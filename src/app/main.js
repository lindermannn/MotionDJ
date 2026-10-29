import { AudioEngine } from '../audio/engine.js';
import { estimateBPM, computePeaks } from '../audio/bpm.js';
import { createHandTracker, startCamera } from '../camera/tracker.js';
import { PinchDetector, Smoother, ControlRegistry, pinchRatio, clamp, expandRect, mapCoverPoint, handsDistance, TwoHandSession } from '../gestures/logic.js';
import { transitionValues, expressiveValues, smooth } from '../audio/transition.js';

const $ = s => document.querySelector(s);
const stage = $('#stage'), video = $('#cam'), overlay = $('#overlay');
let engine = null, tracker = null, gesturesOn = false, diag = false;
let selectedTrack = null, smartTimer = null, recorder = null, recChunks = [];
const library = [];
const decks = [
  { el: $('#deckA'), name: 'A', track: null, bpm: null, peaks: null, hotcues: Array(8).fill(null), mode: 'hotcue', loop: null },
  { el: $('#deckB'), name: 'B', track: null, bpm: null, peaks: null, hotcues: Array(8).fill(null), mode: 'hotcue', loop: null }
];
const fmt = t => { if (!isFinite(t) || t < 0) t = 0; return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`; };
function status(msg) { $('#status').textContent = msg; }

function deckHTML(d, i) {
  const col = i === 0 ? 'var(--a)' : 'var(--b)';
  d.el.innerHTML = `
  <h3 class="deck-a-title">DECK ${d.name} · <span class="tname">Sin pista</span></h3>
  <canvas class="wave" width="480" height="88"></canvas>
  <div class="row"><span class="time pos">0:00</span><span class="grow"></span><span class="time bpm">BPM —</span><span class="time rem">-0:00</span></div>
  <div class="jog"><i></i></div>
  <div class="row transport">
    <button class="btn cue" data-act="cue">CUE</button>
    <button class="btn play" data-act="play">▶ PLAY</button>
    <button class="btn" data-act="sync" title="Iguala tempo, no alinea golpes">SYNC tempo</button>
  </div>
  <label>Tempo <span class="tempoval">+0.0%</span><input class="tempo" type="range" min="-8" max="8" step="0.1" value="0" data-g="range" data-deck="${i}" data-param="tempo"></label>
  <div class="row">
    <button class="btn small padmode" data-mode="hotcue" title="Pinza/clic para cambiar de modo">MODO: HOT CUE</button>
    <button class="btn small loopbtn" data-act="loop">LOOP 4</button><span class="time loopinfo"></span>
  </div>
  <div class="pads">${Array.from({ length: 8 }, (_, p) => `<button class="pad" data-pad="${p}">PAD ${p + 1}</button>`).join('')}</div>`;
}
decks.forEach(deckHTML);
$('#mixer').innerHTML = `
  <h3>MEZCLADOR</h3>
  ${[0, 1].map(i => `<div class="knobs">
    ${[['trim', 'TRIM', 0, 2, 1], ['low', 'GRAVES', -24, 24, 0], ['mid', 'MEDIOS', -24, 24, 0], ['high', 'AGUDOS', -24, 24, 0]].map(([p, l, mn, mx, v]) =>
      `<div class="knob"><label>${l} ${i === 0 ? 'A' : 'B'}</label><input type="range" min="${mn}" max="${mx}" step="0.5" value="${v}" data-g="range" data-deck="${i}" data-param="${p}"></div>`).join('')}
  </div>
  <label>FILTRO ${i === 0 ? 'A' : 'B'} <input type="range" min="-50" max="50" step="1" value="50" data-g="range" data-deck="${i}" data-param="filter"></label>
  <label>VOLUMEN ${i === 0 ? 'A' : 'B'} <input type="range" min="0" max="1" step="0.01" value="0.85" data-g="range" data-deck="${i}" data-param="vol"></label>
  <div class="meter-row"><span>CH ${i === 0 ? 'A' : 'B'}</span><div class="meter"><i class="chmeter"></i></div></div>`).join('')}
  <div class="cross"><label>CROSSFADER</label>
  <input id="cross" type="range" min="-1" max="1" step="0.01" value="0" data-g="range" data-param="cross">
  <div class="row"><span>A</span><span class="grow"></span><span>B</span></div></div>
  <label>FX DELAY <input type="range" min="0" max="0.8" step="0.01" value="0" data-g="range" data-param="delay"></label>
  <label>FX REVERB <input type="range" min="0" max="0.8" step="0.01" value="0" data-g="range" data-param="verb"></label>`;

function ensureEngine() {
  if (!engine) { engine = new AudioEngine(); status('Audio activado. Carga demos o importa música.'); }
  if (engine.ctx.state === 'suspended') engine.ctx.resume();
  return engine;
}
$('#gAudio').onclick = ensureEngine;
function drawWave(d) {
  const cv = d.el.querySelector('.wave'), ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height); ctx.fillStyle = d.name === 'A' ? '#22d3ee' : '#f472b6';
  if (!d.peaks) { ctx.fillStyle = '#33505c'; ctx.fillRect(0, 42, cv.width, 2); return; }
  const pos = engine && d.track ? engine.decks[decks.indexOf(d)].position() / d.track.buffer.duration : 0;
  const n = d.peaks.length, w = cv.width / n;
  for (let i = 0; i < n; i++) { const h = Math.max(2, d.peaks[i] * 80); ctx.globalAlpha = i / n <= pos ? 1 : 0.35; ctx.fillRect(i * w, 44 - h / 2, Math.max(1, w - 1), h); }
  ctx.globalAlpha = 1; ctx.fillStyle = '#fff'; ctx.fillRect(pos * cv.width, 0, 2, cv.height);
  (d.hotcues || []).forEach(h => { if (h !== null && d.track) { ctx.fillStyle = '#facc15'; ctx.fillRect(h / d.track.buffer.duration * cv.width, 0, 2, 10); } });
}
// ---------- Biblioteca ----------
function renderLibrary() {
  const q = $('#search').value.toLowerCase(), ul = $('#trackList'); ul.innerHTML = '';
  library.filter(t => t.name.toLowerCase().includes(q)).forEach(t => {
    const li = document.createElement('li');
    if (selectedTrack === t) li.className = 'sel';
    li.innerHTML = `<span>${t.name}</span><span>${decks.map((d, i) => d.track === t ? `<span class="badge">DECK ${'AB'[i]}</span>` : '').join('')}</span>`;
    li.onclick = () => { selectedTrack = t; renderLibrary(); };
    ul.appendChild(li);
  });
}
$('#search').oninput = renderLibrary;
async function addTrack(name, blobOrUrl) {
  ensureEngine();
  try {
    const buf = typeof blobOrUrl === 'string'
      ? await (await fetch(blobOrUrl)).then(r => { if (!r.ok) throw new Error('demo no encontrada'); return r.arrayBuffer(); }).then(ab => engine.ctx.decodeAudioData(ab))
      : await engine.decode(blobOrUrl);
    const t = { id: crypto.randomUUID(), name, buffer: buf };
    library.push(t); selectedTrack = t; renderLibrary();
    $('#libMsg').textContent = `Importada: ${name}`;
    return t;
  } catch (e) { $('#libMsg').textContent = `Error al leer "${name}": formato no soportado o archivo dañado.`; return null; }
}
$('#fileImport').onchange = async e => { for (const f of e.target.files) await addTrack(f.name, f); e.target.value = ''; };
$('#btnDemo').onclick = async () => {
  $('#libMsg').textContent = 'Cargando demos generadas localmente…';
  await addTrack('Demo A — House 122 BPM (generada)', '/audio/demo-a.wav');
  await addTrack('Demo B — Electro 124 BPM (generada)', '/audio/demo-b.wav');
};
async function loadToDeck(i) {
  if (!selectedTrack) { $('#libMsg').textContent = 'Selecciona primero una pista de la lista.'; return; }
  ensureEngine(); const ch = engine.decks[i], d = decks[i];
  if (ch.playing) { if (!confirm(`El deck ${d.name} está sonando. ¿Detenerlo y reemplazar la pista?`)) return; }
  ch.load(selectedTrack.buffer); d.track = selectedTrack; d.hotcues = Array(8).fill(null);
  d.peaks = computePeaks(selectedTrack.buffer); d.bpm = estimateBPM(selectedTrack.buffer);
  d.el.querySelector('.tname').textContent = selectedTrack.name;
  d.el.querySelector('.bpm').textContent = d.bpm ? `BPM ~${d.bpm} (estimado)` : 'BPM —';
  drawWave(d); renderLibrary(); status(`Pista cargada en deck ${d.name}. No suena hasta pulsar PLAY.`);
}
$('#loadA').onclick = () => loadToDeck(0);
$('#loadB').onclick = () => loadToDeck(1);
// ---------- Controles de deck ----------
function setParam(input) {
  if (!engine) return;
  const p = input.dataset.param, i = Number(input.dataset.deck), v = Number(input.value), ch = engine?.decks[i], t = engine.ctx.currentTime;
  if (p === 'master') return engine.master.gain.setTargetAtTime(v, t, 0.03);
  if (p === 'cross') return engine.setCross(v);
  if (p === 'delay') return engine.decks.forEach(d => d.delaySend.gain.setTargetAtTime(v, t, 0.05));
  if (p === 'verb') return engine.decks.forEach(d => d.verbSend.gain.setTargetAtTime(v, t, 0.05));
  if (!ch) return;
  if (p === 'tempo') { const bpm = decks[i].bpm || 120; ch.setRate(bpm ? (1 + v / 100) : 1); decks[i].el.querySelector('.tempoval').textContent = `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`; }
  if (p === 'vol') ch.fader.gain.setTargetAtTime(v, t, 0.03);
  if (p === 'trim') ch.trim.gain.setTargetAtTime(v, t, 0.03);
  if (p === 'low') ch.low.gain.setTargetAtTime(v, t, 0.03);
  if (p === 'mid') ch.mid.gain.setTargetAtTime(v, t, 0.03);
  if (p === 'high') ch.high.gain.setTargetAtTime(v, t, 0.03);
  if (p === 'filter') ch.filter.frequency.setTargetAtTime(v <= 50 ? 400 + (v + 50) / 100 * 2000 : 2400 * Math.pow(18000 / 2400, (v - 50) / 50), t, 0.03);
}
document.addEventListener('input', e => { if (e.target.matches('input[type=range][data-param]')) setParam(e.target); if (e.target.id === 'masterVol' && engine) engine.master.gain.setTargetAtTime(Number(e.target.value), engine.ctx.currentTime, 0.03); });
function deckAction(i, act, btn) {
  ensureEngine(); const ch = engine.decks[i], d = decks[i];
  if (!ch.buffer) { status(`Carga una pista en el deck ${d.name} primero.`); return; }
  if (act === 'play') { ch.playing ? ch.pause() : ch.play(); }
  if (act === 'cue') { if (ch.playing) { ch.seek(ch.cue ?? 0); } else { ch.cue = ch.position(); ch.seek(ch.cue); status(`CUE deck ${d.name} en ${fmt(ch.cue)} (pulsa CUE sonando para volver)`); } }
  if (act === 'sync') {
    const other = decks[1 - i];
    if (!d.bpm || !other.bpm) { status('Sync tempo no disponible: falta BPM estimado en algún deck.'); return; }
    const tempo = (other.bpm / d.bpm - 1) * 100;
    if (Math.abs(tempo) > 8) { status(`Sync fuera de rango (±8%): harían falta ${tempo.toFixed(1)}%.`); return; }
    const inp = d.el.querySelector('.tempo'); inp.value = tempo.toFixed(1); setParam(inp);
    status(`Sync de TEMPO deck ${d.name}: ${tempo.toFixed(1)}% (no alinea golpes). Tono cambia con la velocidad.`);
  }
  if (act === 'loop') {
    if (d.loop) { d.loop = null; btn.textContent = 'LOOP 4'; }
    else if (d.bpm) { const beat = 60 / d.bpm; d.loop = { start: ch.position(), len: beat * 4 }; btn.textContent = 'LOOP ON'; }
    else status('Loop necesita BPM estimado.');
  }
  refreshTransport();
}
const PAD_MODES = ['hotcue', 'sampler', 'padfx', 'beatjump'];
function padAction(i, p, btn) {
  ensureEngine(); const ch = engine.decks[i], d = decks[i], mode = d.el.querySelector('.padmode').dataset.mode;
  btn.classList.add('hit'); setTimeout(() => btn.classList.remove('hit'), 180);
  if (mode === 'sampler') return engine.playSample(p);
  if (!ch.buffer) { status('Carga una pista para usar los pads.'); return; }
  if (mode === 'hotcue') {
    if (d.hotcues[p] === null) { d.hotcues[p] = ch.position(); btn.classList.add('set'); btn.textContent = `CUE ${p + 1} ●`; }
    else ch.seek(d.hotcues[p]);
  }
  if (mode === 'padfx') { const old = engine.decks[i].filter.frequency.value; ch.filter.frequency.setValueAtTime(600 + p * 300, engine.ctx.currentTime); setTimeout(() => ch.filter.frequency.setTargetAtTime(old, engine.ctx.currentTime, 0.08), 350); }
  if (mode === 'beatjump' && d.bpm) { const beat = 60 / d.bpm; ch.seek(ch.position() + (p < 4 ? -(4 - p) * beat : (p - 3) * beat)); }
}
decks.forEach((d, i) => {
  d.el.addEventListener('click', e => {
    const act = e.target.dataset?.act, pad = e.target.dataset?.pad;
    if (e.target.classList.contains('padmode')) { const n = PAD_MODES[(PAD_MODES.indexOf(e.target.dataset.mode) + 1) % PAD_MODES.length]; e.target.dataset.mode = n; e.target.textContent = `MODO: ${n.toUpperCase()}`; return; }
    if (act) deckAction(i, act, e.target);
    if (pad !== undefined) padAction(i, Number(pad), e.target);
  });
  d.el.querySelector('.wave').addEventListener('click', e => {
    if (!engine || !d.track) return; const r = e.target.getBoundingClientRect();
    engine.decks[i].seek((e.clientX - r.left) / r.width * d.track.buffer.duration);
  });
});
function refreshTransport() {
  decks.forEach((d, i) => {
    const playing = engine?.decks[i].playing;
    const b = d.el.querySelector('.play'); b.textContent = playing ? '❚❚ PAUSE' : '▶ PLAY'; b.classList.toggle('play-on', !!playing);
    d.el.querySelector('.jog').classList.toggle('spin', !!playing);
  });
}
// ---------- Calibracion ----------
const consoleEl = $('#console');
function applyCal(save = true) {
  const s = $('#calScale').value, x = $('#calX').value, y = $('#calY').value;
  consoleEl.style.transform = `translateX(calc(-50% + ${x}px)) scale(${s})`;
  consoleEl.style.bottom = `calc(3% + ${-y}px)`;
  document.documentElement.style.setProperty('--ctl', $('#calSize').value);
  if (save) localStorage.setItem('motiondj-cal', JSON.stringify({ s, x, y, size: $('#calSize').value, sens: $('#calSens').value }));
}
try { const c = JSON.parse(localStorage.getItem('motiondj-cal') || 'null'); if (c) { $('#calScale').value = c.s; $('#calX').value = c.x; $('#calY').value = c.y; $('#calSize').value = c.size; $('#calSens').value = c.sens; } } catch {}
['calScale', 'calX', 'calY', 'calSize', 'calSens'].forEach(id => $('#' + id).addEventListener('input', () => applyCal()));
applyCal(false);
let locked = false;
$('#btnLock').onclick = e => { locked = !locked; ['calScale', 'calX', 'calY'].forEach(id => $('#' + id).disabled = locked); e.target.textContent = locked ? 'Desbloquear mesa' : 'Bloquear mesa'; };
let zoomed = false;
$('#btnZoomMixer').onclick = e => { zoomed = !zoomed; consoleEl.style.gridTemplateColumns = zoomed ? '0.6fr 1.4fr 0.6fr' : ''; e.target.textContent = zoomed ? 'Vista normal' : 'Ampliar mixer'; };
// ---------- Transicion a dos manos y grabacion ----------
// La sesion de gestos SOLO emite eventos; aqui se traducen a audio.
const two = new TwoHandSession({ holdMs: 700, lossMs: 300 });
let expressiveActive = false;
function twoBanner(txt) { const b = $('#twoHandBanner'); b.hidden = !txt; b.textContent = txt || ''; }
function twoStatus(txt) { $('#twoStatus').textContent = txt; }
function lowInput(i) { return document.querySelector(`[data-param=low][data-deck="${i}"]`); }
function filterInputs() { return [0, 1].map(i => document.querySelector(`[data-param=filter][data-deck="${i}"]`)); }
function applyTransitionFrame(vals, target, progress01) {
  if (!engine) return;
  const cross = $('#cross'); cross.value = vals.cross; engine.setCross(vals.cross);
  const outIdx = target === 1 ? 0 : 1, inIdx = 1 - outIdx;
  if (lowInput(outIdx)) { lowInput(outIdx).value = vals.lowOut; setParam(lowInput(outIdx)); }
  if (lowInput(inIdx)) { lowInput(inIdx).value = vals.lowIn; setParam(lowInput(inIdx)); }
  if (vals.delay !== undefined) engine.decks.forEach(d => d.delaySend.gain.setTargetAtTime(vals.delay, engine.ctx.currentTime, 0.05));
  $('#twoProgress').style.width = `${progress01 * 100}%`; $('#twoProgressVal').textContent = `${Math.round(progress01 * 100)}%`;
}
function startAutoTransition() {
  ensureEngine(); cancelAuto(false);
  const target = Number($('#twoTarget').value), dur = Number($('#twoDuration').value);
  const from = Number($('#cross').value), lowFrom = [0, 1].map(i => Number(lowInput(i)?.value || 0)), t0 = performance.now();
  $('#btnTwoCancel').disabled = false;
  twoBanner(`Transición automática hacia ${target === 1 ? 'B' : 'A'} en curso… Cancela para retomar el control.`);
  smartTimer = setInterval(() => {
    const k = Math.min(1, (performance.now() - t0) / dur), vals = transitionValues(k, from, target), outIdx = target === 1 ? 0 : 1;
    vals.lowOut = lowFrom[outIdx] + (-18 - lowFrom[outIdx]) * smooth(k);
    applyTransitionFrame(vals, target, k);
    if (k >= 1) { cancelAuto(false); twoBanner(''); twoStatus('Transición automática finalizada. Control manual activo.'); }
  }, 50);
}
function cancelAuto(restoreMsg = true) {
  if (smartTimer) clearInterval(smartTimer); smartTimer = null;
  if (engine) engine.decks.forEach(d => d.delaySend.gain.setTargetAtTime(0, engine.ctx.currentTime, 0.08));
  $('#btnTwoCancel').disabled = true;
  if (restoreMsg) { twoBanner(''); twoStatus('Cancelado. Los valores quedan donde están: control manual sin saltos.'); }
}
function confirmTwoHand() {
  if ($('#twoMode').value === 'auto') { startAutoTransition(); twoStatus('Automática iniciada tras confirmación explícita.'); }
  else { expressiveActive = true; $('#btnTwoCancel').disabled = false; twoBanner('MODO EXPRESIVO: mueve una mano en horizontal para mezclar; separa/junta las manos para el filtro. Suelta para congelar.'); twoStatus('Expresivo activo.'); }
}
function freezeExpressive(reason) {
  if (!expressiveActive) return; expressiveActive = false;
  twoBanner(''); twoStatus(`${reason} Valores congelados sin saltos; control manual activo.`);
}
$('#btnTwoConfirm').onclick = () => { $('#btnTwoConfirm').disabled = true; confirmTwoHand(); };
$('#btnTwoCancel').onclick = () => { cancelAuto(); freezeExpressive('Cancelado por el usuario.'); two.reset(); $('#btnTwoConfirm').disabled = true; };
$('#twoEnabled').onchange = e => { if (!e.target.checked) { two.reset(); freezeExpressive('Dos manos desactivado.'); cancelAuto(false); twoBanner(''); } twoStatus(e.target.checked ? 'Activado. Mantén pinza con AMBAS manos 1 s para preparar (no se activa bailando ni con una mano).' : 'Desactivado.'); };
// Compatibilidad: la antigua smartTo queda sustituida por startAutoTransition.
$('#btnRecord').onclick = e => {
  ensureEngine();
  if (recorder) { recorder.stop(); return; }
  recChunks = []; recorder = new MediaRecorder(engine.recordDest.stream);
  recorder.ondataavailable = ev => recChunks.push(ev.data);
  recorder.onstop = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(recChunks, { type: recorder.mimeType })); a.download = 'motiondj-mezcla.webm'; a.click(); recorder = null; e.target.textContent = '● Grabar mezcla'; };
  recorder.start(); e.target.textContent = '■ Detener y descargar';
};
// ---------- Camara y gestos ----------
const registry = new ControlRegistry();
const hands = [0, 1].map(() => ({ pinch: new PinchDetector(), smoothX: new Smoother(0.45), smoothY: new Smoother(0.45), seen: 0, el: null, needRelease: true }));
let mirrored = true;
function rebuildRegistry() {
  registry.controls.clear();
  const pad = Number($('#calHit')?.value || 16), sr = stage.getBoundingClientRect();
  // TODOS los controles de la mesa: sliders, botones (PLAY/CUE/SYNC/LOOP/pads/modo) y onda.
  document.querySelectorAll('.console [data-g], .console button, .console .wave').forEach((el, idx) => {
    const r = el.getBoundingClientRect();
    if (!r.width) return;
    if (!el._gid) el._gid = `ctl-${idx}-${el.dataset.param || el.dataset.act || el.className}`;
    const base = { x: r.left - sr.left, y: r.top - sr.top, w: r.width, h: r.height };
    registry.register(el._gid, el.classList.contains('wave') ? base : expandRect(base, pad), { el, z: el.classList.contains('wave') ? 0 : 1 });
  });
}
function coverPoint(lm) {
  const sr = stage.getBoundingClientRect();
  const p = mapCoverPoint(lm, video.videoWidth || 1280, video.videoHeight || 720, sr.width, sr.height, mirrored);
  return { ...p, sr };
}
function controlLabel(el) {
  if (!el) return '—';
  if (el.dataset.param) return `${el.dataset.param.toUpperCase()} ${el.dataset.deck !== undefined ? 'AB'[el.dataset.deck] : ''}`.trim();
  if (el.classList.contains('wave')) return 'ONDA (pinza = seek)';
  return (el.textContent || el.className).trim().slice(0, 22);
}
function setRangeFromPoint(el, x) {
  const r = el.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  const frac = clamp((x - (r.left - sr.left)) / r.width);
  el.value = Number(el.min) + frac * (Number(el.max) - Number(el.min));
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
function triggerEl(el, x) {
  if (el.classList.contains('wave')) {
    const deckEl = el.closest('.deck'), i = decks.findIndex(d => d.el === deckEl), r = el.getBoundingClientRect(), sr = stage.getBoundingClientRect();
    if (engine && decks[i].track) engine.decks[i].seek(clamp((x - (r.left - sr.left)) / r.width) * decks[i].track.buffer.duration);
    return;
  }
  if (el.classList.contains('pad')) { const deckEl = el.closest('.deck'); padAction(decks.findIndex(d => d.el === deckEl), Number(el.dataset.pad), el); }
  else el.click();
}
async function enableCamera() {
  try {
    await startCamera(video); $('#noCam').style.display = 'none';
    status('Cámara activa. Cargando modelo de manos (primera vez requiere internet)…');
    tracker = await createHandTracker(video, () => status('MediaPipe no pudo cargar. Revisa internet la primera vez; mouse/teclado siguen activos.'));
    status(tracker ? 'Manos listas. Activa Gestos y haz una pinza sobre un control.' : 'Sin tracker de manos; mouse/teclado activos.');
  } catch (e) { status('Permiso de cámara denegado o no disponible. Usa mouse/teclado.'); }
}
$('#gCamera').onclick = enableCamera; $('#btnCam2').onclick = enableCamera;
function applyMirror() {
  video.style.transform = mirrored ? 'scaleX(-1)' : 'none';
  const b = $('#btnMirror'); b.textContent = `Cámara: ${mirrored ? 'ESPEJO' : 'NORMAL'}`; b.setAttribute('aria-pressed', mirrored);
  localStorage.setItem('motiondj-mirror', mirrored ? '1' : '0');
}
mirrored = localStorage.getItem('motiondj-mirror') !== '0'; applyMirror();
$('#btnMirror').onclick = () => { mirrored = !mirrored; applyMirror(); hands.forEach(h => { h.smoothX.reset(); h.smoothY.reset(); }); status(mirrored ? 'Modo ESPEJO: te mueves como frente a un espejo.' : 'Modo NORMAL: la imagen no se invierte; el cursor sigue a tu dedo igualmente.'); };
$('#btnGestures').onclick = e => {
  gesturesOn = !gesturesOn; e.target.textContent = gesturesOn ? 'Gestos: ACTIVOS (pausar)' : 'Gestos: PAUSADOS'; e.target.setAttribute('aria-pressed', gesturesOn);
  $('#gesturePaused').style.display = gesturesOn ? 'none' : 'block';
  hands.forEach(h => { h.needRelease = true; h.pinch.reset(); });
  if (!gesturesOn) { registry.releaseAll(); two.reset(); freezeExpressive('Gestos pausados.'); document.querySelectorAll('[data-focus]').forEach(el => el.removeAttribute('data-focus')); $('#focusTag').hidden = true; }
};
$('#btnDiag').onclick = e => { diag = !diag; e.target.setAttribute('aria-pressed', diag); if (!diag) overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height); };
$('#btnGuide').onclick = () => $('#guide').scrollIntoView({ behavior: 'smooth' });
document.addEventListener('keydown', e => {
  if (e.target.matches('input,select,textarea')) return;
  const k = e.key.toLowerCase();
  if (k === 'q') deckAction(0, 'play'); if (k === 'a') deckAction(0, 'cue', decks[0].el.querySelector('.cue'));
  if (k === 'p') deckAction(1, 'play'); if (k === 'l') deckAction(1, 'cue', decks[1].el.querySelector('.cue'));
  if (k === 'g') $('#btnGestures').click();
  if (k === 'arrowleft' || k === 'arrowright') { const c = $('#cross'); c.value = clamp(Number(c.value) + (k === 'arrowright' ? 0.08 : -0.08), -1, 1); c.dispatchEvent(new Event('input', { bubbles: true })); }
});
// ---------- Bucle principal ----------
function loop() {
  requestAnimationFrame(loop);
  if (engine) {
    decks.forEach((d, i) => {
      const ch = engine.decks[i];
      if (d.loop && ch.playing && ch.position() > d.loop.start + d.loop.len) ch.seek(d.loop.start);
      if (d.track) { d.el.querySelector('.pos').textContent = fmt(ch.position()); d.el.querySelector('.rem').textContent = '-' + fmt(d.track.buffer.duration - ch.position()); drawWave(d); }
      const m = d.el.querySelector('.chmeter'); if (m) m.style.width = `${Math.min(100, ch.level() * 100)}%`;
    });
    const ml = engine.masterLevel(), mm = $('#masterMeter'); if (mm) mm.style.width = `${Math.min(100, ml * 100)}%`;
    $('#clipWarn').hidden = ml < 0.98;
    refreshTransport();
  }
  if (!gesturesOn || !tracker) { hands.forEach((h, i) => { const c = $(`#handCursor${i}`); if (c) c.style.display = 'none'; }); return; }
  const res = tracker.detect(); rebuildRegistry();
  const ctx = overlay.getContext('2d'); overlay.width = stage.clientWidth; overlay.height = stage.clientHeight; ctx.clearRect(0, 0, overlay.width, overlay.height);
  const lms = res?.landmarks || [], now = performance.now();
  const pts = hands.map((h, hi) => {
    const lm = lms[hi], cursor = $(`#handCursor${hi}`);
    if (!lm) { if (h.seen && now - h.seen > 250) { registry.release(hi); h.pinch.reset(); h.needRelease = true; } cursor.style.display = 'none'; return null; }
    h.seen = now;
    const tip = coverPoint(lm[8]), x = h.smoothX.update(tip.x), y = h.smoothY.update(tip.y);
    h.pinch.on = Number($('#calSens').value); h.pinch.off = h.pinch.on + 0.14;
    const det = h.pinch.update(pinchRatio(lm));
    cursor.style.display = 'block'; cursor.style.left = x + 'px'; cursor.style.top = y + 'px'; cursor.classList.toggle('pinched', det.pinched);
    return { lm, x, y, det };
  });
  // --- Sesion a dos manos (solo emite eventos; el audio se aplica aqui) ---
  const twoOn = $('#twoEnabled').checked;
  let twoBusy = false;
  if (twoOn && pts[0] && pts[1]) {
    const bothPinched = pts.every(p => p.det.pinched), ev = two.update({ bothPinched, bothPresent: true }, now);
    if (bothPinched) { registry.releaseAll(); twoBusy = true; }
    if (ev.event === 'prepared') { const t = Number($('#twoTarget').value); twoBanner(`Transición «Mezcla suave» hacia ${t === 1 ? 'B' : 'A'} PREPARADA: crossfader + graves + eco (${$('#twoDuration').value / 1000}s). Suelta ambas manos y confirma con el botón o una segunda pinza doble.`); twoStatus('Preparada. Esperando confirmación explícita.'); $('#btnTwoConfirm').disabled = false; }
    if (ev.event === 'armed') twoStatus('Lista: pulsa Confirmar o haz pinza con ambas manos para iniciar.');
    if (ev.event === 'confirmed') { $('#btnTwoConfirm').disabled = true; confirmTwoHand(); }
    if (ev.event === 'freeze' || ev.event === 'released') freezeExpressive(ev.event === 'freeze' ? 'Se perdió una mano.' : 'Pinzas soltadas.');
    if (expressiveActive && pts[0] && pts[1]) {
      twoBusy = true; const target = Number($('#twoTarget').value);
      const vals = expressiveValues(clamp(pts[1].x / stage.clientWidth), handsDistance(pts[0], pts[1], stage.clientWidth), target);
      applyTransitionFrame({ cross: vals.cross, lowOut: vals.lowOut, lowIn: 0 }, target, vals.progress);
      filterInputs().forEach(inp => { if (inp) { inp.value = vals.filter; setParam(inp); } });
      $('#twoFilter').style.width = `${(vals.filter + 50)}%`; $('#twoFilterVal').textContent = `${Math.round(vals.filter)}`;
    }
  } else if (twoOn) { const ev = two.update({ bothPinched: false, bothPresent: false }, now); if (ev.event === 'freeze') freezeExpressive('Se perdió una mano.'); }
  // --- Mano individual: foco visible antes de pinzar ---
  document.querySelectorAll('[data-focus]').forEach(el => el.removeAttribute('data-focus'));
  document.querySelectorAll('[data-grabbed]').forEach(el => el.removeAttribute('data-grabbed'));
  let focusLabel = '';
  hands.forEach((h, hi) => {
    const p = pts[hi]; if (!p) return;
    const hit = registry.hit(p.x, p.y);
    if (hit && !p.det.pinched) { hit.el.setAttribute('data-focus', '1'); focusLabel = controlLabel(hit.el); $(`#handCursor${hi}`).querySelector('span').textContent = focusLabel; }
    else $(`#handCursor${hi}`).querySelector('span').textContent = p.det.pinched ? 'TOMADO' : '';
    if (twoBusy || expressiveActive) return;
    const grabbedId = registry.grabbedBy(hi);
    if (grabbedId) { const c = registry.controls.get(grabbedId); if (c?.el?.dataset.g === 'range') setRangeFromPoint(c.el, p.x); if (c) c.el.setAttribute('data-grabbed', '1'); }
    if (p.det.started && !h.needRelease && hit) {
      if (hit.el.dataset.g === 'range') { if (registry.grab(hi, hit.id)) setRangeFromPoint(hit.el, p.x); } else triggerEl(hit.el, p.x);
    }
    if (p.det.ended) { registry.release(hi); h.needRelease = false; }
    if (diag) {
      ctx.fillStyle = hi ? '#f472b6' : '#22d3ee';
      p.lm.forEach(pt0 => { const pt = coverPoint(pt0); ctx.fillRect(pt.x - 2, pt.y - 2, 4, 4); });
      ctx.fillStyle = '#fff'; ctx.font = '12px sans-serif';
      ctx.fillText(`Mano ${hi} (${mirrored ? 'espejo' : 'normal'}): pinza=${p.det.pinched ? 'SI' : 'no'} ratio=${pinchRatio(p.lm).toFixed(2)} foco=${controlLabel(hit?.el)} dos-manos=${two.state}`, 10, 18 + hi * 16);
    }
  });
  const ft = $('#focusTag'); ft.hidden = !focusLabel; ft.textContent = focusLabel ? `Enfocado: ${focusLabel} — haz pinza para tomarlo` : '';
}
loop();
