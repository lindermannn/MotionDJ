import { AudioEngine } from '../audio/engine.js';
import { estimateBPM, computePeaks } from '../audio/bpm.js';
import { createHandTracker, startCamera } from '../camera/tracker.js';
import { PinchDetector, Smoother, ControlRegistry, pinchRatio, clamp, expandRect, mapVideoPointInBox, parseObjectPosition, visibleVideoWindow, fitFromObjectFit, knobDragValue, knobAngle, handsDistance, TwoHandSession } from '../gestures/logic.js';
import { aperture01, ClawController, clawGate } from '../gestures/claw.js';
import { transitionValues, expressiveValues, smooth } from '../audio/transition.js';
import { evaluateAutoDj, autoDjTriggerKey } from '../audio/autodj.js';
import { createEffectSelection, cycleEffect, effectById } from '../audio/effects.js';

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
  <div class="deck-head"><span class="badge">${d.name}</span><h3><span class="tname">Sin pista</span></h3><span class="time bpm">BPM —</span></div>
  <canvas class="wave" width="480" height="88"></canvas>
  <div class="row"><span class="time pos">0:00</span><span class="grow"></span><span class="time bpm">BPM —</span><span class="time rem">-0:00</span></div>
  <div class="deck-mid"><div class="jog"><i></i></div><div class="transport">
  <div class="rowb">
    <button class="btn cue" data-act="cue">CUE</button>
    <button class="btn play" data-act="play">▶ PLAY</button>
    <button class="btn" data-act="sync" title="Iguala tempo, no alinea golpes">SYNC</button>
  </div>
  <label>Tempo <span class="tempoval">+0.0%</span><input class="tempo" type="range" min="-8" max="8" step="0.1" value="0" data-g="range" data-deck="${i}" data-param="tempo"></label>
  <div class="row">
    <button class="btn small padmode" data-mode="hotcue" title="Pinza/clic para cambiar de modo">MODO: HOT CUE</button>
    <button class="btn small loopbtn dj-only" data-act="loop">LOOP 4</button></div></div>
  </div>
  <div class="pads">${Array.from({ length: 8 }, (_, p) => `<button class="pad" data-pad="${p}">${p + 1}<br>PAD</button>`).join('')}</div>`;
}
decks.forEach(deckHTML);
$('#mixer').innerHTML = `
  <h3 style="text-align:center;margin:2px 0 8px">MEZCLADOR</h3>
  ${[0, 1].map(i => `<div class="eqgrid"><div class="eqcol"><strong>CANAL ${'AB'[i]}</strong>
    ${[['high', 'HIGH', -24, 24, 0, 'dj-only'], ['mid', 'MID', -24, 24, 0, 'dj-only'], ['low', 'LOW', -24, 24, 0, ''], ['trim', 'TRIM', 0, 2, 1, 'dj-only']].map(([p, l, mn, mx, v, cls]) =>
      (i === 0 && p === 'low'
        ? `<div class="knobwrap"><button type="button" class="knob" data-g="knob" data-deck="0" data-param="low" aria-label="LOW, Deck A"><span class="knob-dial"><i></i></span></button><label>LOW</label><input class="knob-state" type="range" min="-24" max="24" step="0.5" value="0" data-g="range" data-deck="0" data-param="low" hidden></div>`
        : `<div class="${cls}"><label>${l}</label><input type="range" min="${mn}" max="${mx}" step="0.5" value="${v}" data-g="range" data-deck="${i}" data-param="${p}"></div>`)).join('')}
  </div>
  <label>FILTRO ${i === 0 ? 'A' : 'B'} <input type="range" min="-50" max="50" step="1" value="50" data-g="range" data-deck="${i}" data-param="filter"></label>
  </div>
  <div class="meter-row"><div class="meter"><i class="chmeter"></i></div></div></div>`).join('')}
  <div class="faderow"><div>VOL A<br><input class="vfader" type="range" min="0" max="1" step="0.01" value="0.85" data-g="range" data-orient="v" data-deck="0" data-param="vol"></div><div class="dj-only">FX DELAY<br><input type="range" min="0" max="0.8" step="0.01" value="0" data-g="range" data-param="delay" style="width:90px"><br>FX REVERB<br><input type="range" min="0" max="0.8" step="0.01" value="0" data-g="range" data-param="verb" style="width:90px"></div><div>VOL B<br><input class="vfader" type="range" min="0" max="1" step="0.01" value="0.85" data-g="range" data-orient="v" data-deck="1" data-param="vol"></div></div>
  <div class="crossbox"><label style="display:block;text-align:center;font-size:11px">CROSSFADER</label>
  <input id="cross" type="range" min="-1" max="1" step="0.01" value="0" data-g="range" data-param="cross">
  <div class="row"><strong style="color:var(--a)">A</strong><span class="grow"></span><strong style="color:var(--b)">B</strong></div></div>
  </div>`;

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
    li.innerHTML = `<span>${t.name}</span><span>${decks.map((d, i) => d.track === t ? `<span class="tagdeck">DECK ${'AB'[i]}</span>` : '').join('')}</span>`;
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
  document.documentElement.style.setProperty('--alpha', $('#calOpacity')?.value || 0.86);
  const kv = $('#calKnobVal'); if (kv) kv.textContent = $('#calKnob')?.value || 220;
  if (save) localStorage.setItem('motiondj-cal', JSON.stringify({ s, x, y, size: $('#calSize').value, sens: $('#calSens').value, knob: $('#calKnob')?.value || 220 }));
}
try { const c = JSON.parse(localStorage.getItem('motiondj-cal') || 'null'); if (c) { $('#calScale').value = c.s; $('#calX').value = c.x; $('#calY').value = c.y; $('#calSize').value = c.size; $('#calSens').value = c.sens; if (c.knob && $('#calKnob')) $('#calKnob').value = c.knob; } } catch {}
['calScale', 'calX', 'calY', 'calSize', 'calSens', 'calHit', 'calOpacity', 'calKnob'].forEach(id => { const el = $('#' + id); if (el) el.addEventListener('input', () => applyCal()); });
// ---------- Vistas Facil / DJ (mismo estado y motor; solo cambia visibilidad) ----------
function setView(v) { requestAnimationFrame(() => { if (typeof hands !== 'undefined') hands.forEach(h => { h.smoothX.reset(); h.smoothY.reset(); }); if (typeof rebuildRegistry === 'function') rebuildRegistry(); });
  document.body.dataset.view = v;
  $('#btnViewEasy').setAttribute('aria-pressed', v === 'easy'); $('#btnViewDJ').setAttribute('aria-pressed', v === 'dj');
  localStorage.setItem('motiondj-view', v);
}
$('#btnViewEasy').onclick = () => setView('easy'); $('#btnViewDJ').onclick = () => setView('dj');
setView(localStorage.getItem('motiondj-view') || 'dj');
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
let autoDjLastKey = null, autoDjTimerBusy = false, autoDjLastCheck = 0;
function startAutoTransition(targetOverride, durOverride) {
  ensureEngine(); cancelAuto(false);
  const target = targetOverride !== undefined ? targetOverride : Number($('#twoTarget').value), dur = durOverride !== undefined ? durOverride : Number($('#twoDuration').value);
  const from = Number($('#cross').value), lowFrom = [0, 1].map(i => Number(lowInput(i)?.value || 0)), t0 = performance.now();
  $('#btnTwoCancel').disabled = false;
  twoBanner(`Transición automática hacia ${target === 1 ? 'B' : 'A'} en curso… Cancela para retomar el control.`);
  smartTimer = setInterval(() => {
    const k = Math.min(1, (performance.now() - t0) / dur), vals = transitionValues(k, from, target), outIdx = target === 1 ? 0 : 1;
    vals.lowOut = lowFrom[outIdx] + (-18 - lowFrom[outIdx]) * smooth(k);
    applyTransitionFrame(vals, target, k);
    if (k >= 1) { if (autoDjTimerBusy && engine) { const outIdx = target === 1 ? 0 : 1; if (engine.decks[outIdx].playing) engine.decks[outIdx].pause(); refreshTransport(); } cancelAuto(false); autoDjTimerBusy = false; twoBanner(''); twoStatus('Transición automática finalizada. Control manual activo.'); }
  }, 50);
}
function autoDjPlanNow() { return evaluateAutoDj({ enabled: $('#autoDjEnabled').checked, cross: Number($('#cross').value || 0), anticipationSec: Number($('#autoDjAnt').value || 15), decks: decks.map((d, i) => ({ hasTrack: !!d.track, playing: !!engine?.decks[i].playing, position: engine && d.track ? engine.decks[i].position() : 0, duration: d.track ? d.track.buffer.duration : null })) }); }
function autoDjRender(plan) { $('#autoDjActive').textContent = `Activo: ${plan.active === null ? '—' : 'Deck ' + 'AB'[plan.active]}`; $('#autoDjNext').textContent = `Destino: ${plan.next === null ? '—' : 'Deck ' + 'AB'[plan.next] + (plan.ready ? ' (pista lista)' : ' (sin pista)')}`; $('#autoDjStatus').textContent = plan.reason; $('#btnAutoDjNow').disabled = !(plan.ready && plan.active !== null && !smartTimer && !autoDjTimerBusy); $('#btnAutoDjCancel').disabled = !($('#autoDjEnabled').checked || smartTimer); $('#autoDjAntVal').textContent = $('#autoDjAnt').value; }
function startAutoDjTransition(plan, why) { if (!plan.ready || plan.active === null || smartTimer) return false; ensureEngine(); const next = plan.next; $('#twoTarget').value = String(next === 1 ? 1 : -1); if (!engine.decks[next].playing) engine.decks[next].play(); refreshTransport(); autoDjTimerBusy = true; startAutoTransition(next === 1 ? 1 : -1, Number($('#autoDjDuration').value)); $('#autoDjStatus').textContent = `${why}: pasando de ${'AB'[plan.active]} a ${'AB'[next]} en ${Number($('#autoDjDuration').value) / 1000} s. Cancela para retomar el control.`; return true; }
function checkAutoDj(now) { const plan = autoDjPlanNow(); autoDjRender(plan); if (!plan.shouldTransition || smartTimer || autoDjTimerBusy) return; const key = autoDjTriggerKey(plan, decks.map(d => d.track?.id)); if (key === autoDjLastKey) return; autoDjLastKey = key; startAutoDjTransition(plan, 'Auto DJ'); }
function cancelAutoDj(msg) { $('#autoDjEnabled').checked = false; autoDjLastKey = null; if (autoDjTimerBusy) { cancelAuto(false); autoDjTimerBusy = false; } twoBanner(''); autoDjRender(autoDjPlanNow()); $('#autoDjStatus').textContent = msg || 'Auto DJ pausado. Control manual activo; los valores quedan donde estan, sin saltos.'; }
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
$('#btnTwoCancel').onclick = () => { cancelAuto(); autoDjTimerBusy = false; freezeExpressive('Cancelado por el usuario.'); two.reset(); $('#btnTwoConfirm').disabled = true; };
$('#twoEnabled').onchange = e => { if (!e.target.checked) { two.reset(); freezeExpressive('Dos manos desactivado.'); cancelAuto(false); twoBanner(''); } twoStatus(e.target.checked ? 'Activado. Mantén pinza con AMBAS manos 1 s para preparar (no se activa bailando ni con una mano).' : 'Desactivado.'); };
$('#autoDjEnabled').onchange = () => { autoDjLastKey = null; const p = autoDjPlanNow(); autoDjRender(p); if ($('#autoDjEnabled').checked) $('#autoDjStatus').textContent = p.reason; };
$('#autoDjAnt').oninput = () => { $('#autoDjAntVal').textContent = $('#autoDjAnt').value; };
$('#btnAutoDjNow').onclick = () => { if (!$('#autoDjEnabled').checked) { $('#autoDjStatus').textContent = 'Activa Auto DJ primero; la transicion a pedido no arranca sola.'; return; } const p = autoDjPlanNow(); if (startAutoDjTransition(p, 'Transicion a pedido')) autoDjLastKey = autoDjTriggerKey(p, decks.map(d => d.track?.id)); else autoDjRender(p); };
$('#btnAutoDjCancel').onclick = () => cancelAutoDj();
let fxSelection = createEffectSelection();
function fxRender() { const fx = effectById(fxSelection.effectId); $('#fxName').textContent = fx.label; $('#fxDeckA').setAttribute('aria-pressed', fxSelection.deck === 0); $('#fxDeckB').setAttribute('aria-pressed', fxSelection.deck === 1); let val = '—'; if (fx.id === 'delay') val = engine ? Math.round(engine.decks[fxSelection.deck].delaySend.gain.value / 0.8 * 100) + '%' : '0%'; else { const inp = document.querySelector(`[data-param="${fx.targetParam}"][data-deck="${fxSelection.deck}"]`); val = inp ? inp.value + fx.unit : '—'; } $('#fxValue').textContent = `Intensidad actual: ${val}`; $('#fxStatus').textContent = `Efecto seleccionado: ${fx.label} · Deck ${'AB'[fxSelection.deck]}. Sin efecto en el audio por ahora (solo seleccion).`; }
$('#fxEnabled').onchange = e => { $('#fxPanel').hidden = !e.target.checked; if (e.target.checked) fxRender(); };
$('#fxPrev').onclick = () => { fxSelection = cycleEffect(fxSelection, -1); fxRender(); };
$('#fxNext').onclick = () => { fxSelection = cycleEffect(fxSelection, 1); fxRender(); };
$('#fxDeckA').onclick = () => { fxSelection = { ...fxSelection, deck: 0 }; fxRender(); };
$('#fxDeckB').onclick = () => { fxSelection = { ...fxSelection, deck: 1 }; fxRender(); };
// Compatibilidad: la antigua smartTo queda sustituida por startAutoTransition.
// ---------- Garra de cinco dedos (experimental, desactivada por defecto) ----------
const claw = new ClawController({ engageMs: 500 });
let clawHand = -1;
const CLAW_PARAMS = { filter: { min: -50, max: 50, label: 'Filtro' }, low: { min: -24, max: 24, label: 'Graves LOW' }, delay: { min: 0, max: 0.8, label: 'Delay (envio del deck)' } };
function clawParamInput() { return document.querySelector(`[data-param="${$('#clawParam').value}"][data-deck="${$('#clawDeck').value}"]`); }
function clawCurrentValue() {
  const p = $('#clawParam').value, i = Number($('#clawDeck').value);
  if (p === 'delay') return engine ? engine.decks[i].delaySend.gain.value : 0;
  return Number(clawParamInput()?.value || 0);
}
function clawReprime() { claw.setValue(clawCurrentValue()); }
function applyClawValue(v) {
  const p = $('#clawParam').value, i = Number($('#clawDeck').value);
  if (p === 'delay') { if (engine) engine.decks[i].delaySend.gain.setTargetAtTime(v, engine.ctx.currentTime, 0.05); }
  else { const inp = clawParamInput(); if (inp) { inp.value = v; setParam(inp); } }
  $('#clawVal').textContent = `${CLAW_PARAMS[p].label} ${'AB'[i]}: ${p === 'delay' ? Math.round(v / 0.8 * 100) + '%' : Math.round(v)}`;
}
['clawDeck', 'clawParam'].forEach(id => $('#' + id).addEventListener('change', clawReprime));
function setClawEnabled(on) {
  $('#clawEnabled').checked = on; claw.reset(); clawHand = -1;
  if (on) clawReprime();
  $('#clawStatus').textContent = on ? 'Garra activa: deja una mano visible sin pinza 0,5 s para enganchar. La pinza y las dos manos tienen prioridad.' : 'Garra desactivada. El parametro conserva su valor y el control manual sigue activo.';
}
$('#clawEnabled').onchange = e => setClawEnabled(e.target.checked);
$('#btnClawOff').onclick = () => setClawEnabled(false);
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
    const base = stageLocal(el);
    registry.register(el._gid, el.classList.contains('wave') ? base : expandRect(base, pad), { el, z: el.classList.contains('wave') ? 0 : 1 });
  });
}
let frameFit = 'fill'; // RECORTE es el modo principal siempre; COMPLETO es una alternativa de sesion
function effectiveFit() { return fitFromObjectFit(getComputedStyle(video).objectFit); } // el mapeo sigue a lo que el video realmente muestra
function applyFrame() { stage.dataset.frame = frameFit === 'fill' ? 'fill' : 'contain'; video.style.objectFit = frameFit === 'fill' ? 'cover' : 'contain'; const b = $('#btnFrame'); b.textContent = frameFit === 'fill' ? 'Encuadre: RECORTE (llena)' : 'Encuadre: COMPLETO'; b.setAttribute('aria-pressed', frameFit === 'fill'); b.title = frameFit === 'fill' ? 'Recorte: llena el area cortando bordes; pueden salir manos/cabeza.' : 'Completo: se ve toda la camara sin deformar; el espacio libre se integra al fondo.'; localStorage.setItem('motiondj-frame-v2', frameFit); hands.forEach(h => { h.smoothX.reset(); h.smoothY.reset(); }); }
function stageLocal(el) { const sr = stage.getBoundingClientRect(), r = el.getBoundingClientRect(); return { x: r.left - sr.left - stage.clientLeft, y: r.top - sr.top - stage.clientTop, w: r.width, h: r.height }; }
function videoBox() { const sr = stage.getBoundingClientRect(), vr = video.getBoundingClientRect(); return { x: vr.left - sr.left - stage.clientLeft, y: vr.top - sr.top - stage.clientTop, w: vr.width, h: vr.height }; }
function mappingInfo() { const tr = video.srcObject?.getVideoTracks?.()[0]?.getSettings?.() || {}; const box = videoBox(); const cs = getComputedStyle(video); const fit = effectiveFit(); const win = visibleVideoWindow(video.videoWidth || 1280, video.videoHeight || 720, box.w, box.h, fit, parseObjectPosition(cs.objectPosition)); const sync = (fit === 'cover') === (frameFit === 'fill') ? 'ok' : 'DESYNC'; return `video ${video.videoWidth || '?'}x${video.videoHeight || '?'} pista ${tr.width || '?'}x${tr.height || '?'} caja ${Math.round(box.w)}x${Math.round(box.h)} object-fit:${cs.objectFit} mapeo:${fit} (${sync}) ${mirrored ? 'ESPEJO' : 'NORMAL'} visible u:${win.u0.toFixed(2)}-${win.u1.toFixed(2)} v:${win.v0.toFixed(2)}-${win.v1.toFixed(2)}`; }
function coverPoint(lm) { const box = videoBox(); const cs = getComputedStyle(video); const p = mapVideoPointInBox(lm, video.videoWidth || 1280, video.videoHeight || 720, box, mirrored, effectiveFit(), parseObjectPosition(cs.objectPosition)); return { ...p, sr: stage.getBoundingClientRect() }; }

function controlLabel(el) {
  if (!el) return '—';
  if (el.dataset.param) return `${el.dataset.param.toUpperCase()} ${el.dataset.deck !== undefined ? 'AB'[el.dataset.deck] : ''}`.trim();
  if (el.classList.contains('wave')) return 'ONDA (pinza = seek)';
  return (el.textContent || el.className).trim().slice(0, 22);
}
function setRangeFromPoint(el, x, y) {
  const r = el.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  const frac = el.dataset.orient === 'v' ? clamp(1 - (y - (r.top - sr.top - stage.clientTop)) / r.height) : clamp((x - (r.left - sr.left - stage.clientLeft)) / r.width);
  el.value = Number(el.min) + frac * (Number(el.max) - Number(el.min));
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
// ---------- Perilla piloto (LOW deck A): arrastre relativo anclado ----------
let knobDrag = null, knobBarTimer = null;
function knobInput(knob) { return knob?.closest('.knobwrap')?.querySelector('.knob-state') || null; }
function knobPx() { return Number($('#calKnob')?.value || 220); }
function syncKnob(knob) {
  const inp = knobInput(knob); if (!inp) return;
  const v = Number(inp.value), mn = Number(inp.min), mx = Number(inp.max), f = mx > mn ? (v - mn) / (mx - mn) : 0;
  knob.style.setProperty('--ang', knobAngle(v, mn, mx) + 'deg');
  knob.style.setProperty('--frac', f);
  if (knobDrag?.knob === knob) showKnobBar(inp, knob, true);
}
function syncAllKnobs() { document.querySelectorAll('.knob').forEach(syncKnob); }
function showKnobBar(inp, knob, keep) {
  const bar = $('#knobBar'); bar.hidden = false;
  const v = Number(inp.value), mn = Number(inp.min), mx = Number(inp.max), f = mx > mn ? (v - mn) / (mx - mn) : 0;
  $('#knobBarLabel').textContent = `${(inp.dataset.param || '').toUpperCase()} · DECK ${'AB'[Number(inp.dataset.deck || 0)]}`;
  $('#knobBarVal').textContent = `${v > 0 ? '+' : ''}${v} dB`;
  $('#knobBarFill').style.width = `${f * 100}%`;
  $('#knobBarDot').style.left = `${f * 100}%`;
  bar.style.borderColor = Number(inp.dataset.deck) === 1 ? 'var(--b)' : 'var(--a)';
  if (!keep && knobBarTimer) { clearTimeout(knobBarTimer); knobBarTimer = null; }
}
function hideKnobBarSoon() {
  if (knobBarTimer) clearTimeout(knobBarTimer);
  knobBarTimer = setTimeout(() => { if (!knobDrag) $('#knobBar').hidden = true; knobBarTimer = null; }, 700);
}
function startKnobDrag(knob, x, hand) {
  const inp = knobInput(knob); if (!inp) return false;
  knobDrag = { knob, input: inp, hand, startValue: Number(inp.value), startX: x };
  showKnobBar(inp, knob);
  return true;
}
function moveKnobDrag(x) {
  if (!knobDrag) return;
  const inp = knobDrag.input;
  inp.value = knobDragValue(knobDrag.startValue, x - knobDrag.startX, Number(inp.min), Number(inp.max), knobPx());
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  syncKnob(knobDrag.knob);
}
function endKnobDrag() { if (!knobDrag) return; knobDrag = null; hideKnobBarSoon(); }
document.querySelectorAll('.knob').forEach(knob => {
  const inp = knobInput(knob);
  knob.addEventListener('pointerdown', e => { e.preventDefault(); knob.focus(); knob.setPointerCapture(e.pointerId); startKnobDrag(knob, e.clientX, 'mouse'); });
  knob.addEventListener('pointermove', e => { if (knobDrag?.knob === knob && knobDrag.hand === 'mouse') moveKnobDrag(e.clientX); });
  knob.addEventListener('pointerup', () => endKnobDrag());
  knob.addEventListener('pointercancel', () => endKnobDrag());
  knob.addEventListener('focus', () => { if (inp) showKnobBar(inp, knob); });
  knob.addEventListener('blur', () => hideKnobBarSoon());
  knob.addEventListener('keydown', e => {
    if (!inp) return;
    const step = Number(inp.step || 0.5), v = Number(inp.value);
    let nv = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') nv = v + step;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') nv = v - step;
    if (e.key === 'PageUp') nv = v + step * 4;
    if (e.key === 'PageDown') nv = v - step * 4;
    if (e.key === 'Home') nv = Number(inp.min);
    if (e.key === 'End') nv = Number(inp.max);
    if (nv !== null) { e.preventDefault(); inp.value = Math.min(Number(inp.max), Math.max(Number(inp.min), nv)); inp.dispatchEvent(new Event('input', { bubbles: true })); showKnobBar(inp, knob); syncKnob(knob); }
  });
});
$('#knobTrack').addEventListener('pointerdown', e => {
  const knob = document.querySelector('.knob'); const inp = knob && knobInput(knob); if (!inp) return;
  const r = e.currentTarget.getBoundingClientRect(), f = clamp((e.clientX - r.left) / r.width);
  inp.value = Number(inp.min) + f * (Number(inp.max) - Number(inp.min));
  inp.dispatchEvent(new Event('input', { bubbles: true })); syncKnob(knob);
});
function triggerEl(el, x) {
  if (el.classList.contains('wave')) {
    const deckEl = el.closest('.deck'), i = decks.findIndex(d => d.el === deckEl), r = el.getBoundingClientRect(), sr = stage.getBoundingClientRect();
    if (engine && decks[i].track) engine.decks[i].seek(clamp((x - (r.left - sr.left - stage.clientLeft)) / r.width) * decks[i].track.buffer.duration);
    return;
  }
  if (el.classList.contains('pad')) { const deckEl = el.closest('.deck'); padAction(decks.findIndex(d => d.el === deckEl), Number(el.dataset.pad), el); }
  else el.click();
}
async function enableCamera() {
  try {
    await startCamera(video); $('#noCam').style.display = 'none'; $('#chipCam').textContent = 'Cámara: activa'; $('#chipCam').classList.add('on');
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
mirrored = localStorage.getItem('motiondj-mirror') !== '0'; applyMirror(); applyFrame();
$('#btnFrame').onclick = () => { frameFit = frameFit === 'fill' ? 'contain' : 'fill'; applyFrame(); status(frameFit === 'fill' ? 'Encuadre RECORTE: llena la pantalla cortando bordes.' : 'Encuadre COMPLETO: se ve toda la camara sin recorte ni deformacion.'); };
window.addEventListener('resize', () => { hands.forEach(h => { h.smoothX.reset(); h.smoothY.reset(); }); rebuildRegistry(); });
$('#btnMirror').onclick = () => { mirrored = !mirrored; applyMirror(); hands.forEach(h => { h.smoothX.reset(); h.smoothY.reset(); }); status(mirrored ? 'Modo ESPEJO: te mueves como frente a un espejo.' : 'Modo NORMAL: la imagen no se invierte; el cursor sigue a tu dedo igualmente.'); };
$('#btnGestures').onclick = e => {
  gesturesOn = !gesturesOn; e.target.textContent = gesturesOn ? 'Gestos: ACTIVOS (pausar)' : 'Gestos: PAUSADOS'; e.target.setAttribute('aria-pressed', gesturesOn);
  $('#gesturePaused').style.display = gesturesOn ? 'none' : 'block';
  $('#chipGest').textContent = gesturesOn ? 'Gestos: activos' : 'Gestos: pausados'; $('#chipGest').classList.toggle('on', gesturesOn);
  hands.forEach(h => { h.needRelease = true; h.pinch.reset(); });
  if (!gesturesOn) { registry.releaseAll(); endKnobDrag(); two.reset(); freezeExpressive('Gestos pausados.'); document.querySelectorAll('[data-focus]').forEach(el => el.removeAttribute('data-focus')); $('#focusTag').hidden = true; }
};
$('#btnDiag').onclick = e => { diag = !diag; e.target.setAttribute('aria-pressed', diag); if (!diag) overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height); };
$('#btnGuide').onclick = () => $('#guide').scrollIntoView({ behavior: 'smooth' });
document.addEventListener('keydown', e => {
  if (e.target.matches('input,select,textarea')) return;
  const k = e.key.toLowerCase();
  if (k === 'q') deckAction(0, 'play'); if (k === 'a') deckAction(0, 'cue', decks[0].el.querySelector('.cue'));
  if (k === 'p') deckAction(1, 'play'); if (k === 'l') deckAction(1, 'cue', decks[1].el.querySelector('.cue'));
  if (k === 'g') $('#btnGestures').click();
  if (k === 'c' && $('#clawEnabled').checked) setClawEnabled(false);
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
    refreshTransport(); syncAllKnobs(); if (performance.now() - autoDjLastCheck > 250) { autoDjLastCheck = performance.now(); checkAutoDj(autoDjLastCheck); if (!$('#fxPanel').hidden) fxRender(); }
  }
  if (!gesturesOn || !tracker) { hands.forEach((h, i) => { const c = $(`#handCursor${i}`); if (c) c.style.display = 'none'; }); return; }
  const res = tracker.detect(); rebuildRegistry();
  const ctx = overlay.getContext('2d'); overlay.width = stage.clientWidth; overlay.height = stage.clientHeight; ctx.clearRect(0, 0, overlay.width, overlay.height);
  const lms = res?.landmarks || [], now = performance.now();
  const stageKey = stage.clientWidth + 'x' + stage.clientHeight;
  if (stageKey !== loop._stageKey) { loop._stageKey = stageKey; hands.forEach(h => { h.smoothX.reset(); h.smoothY.reset(); }); }
  if (diag) {
    // Rejilla de calibracion: cruces en coordenadas normalizadas conocidas.
    // Deben caer sobre tu mano/dedo en esa posicion de la imagen de camara.
    ctx.strokeStyle = 'rgba(250,204,21,.85)'; ctx.fillStyle = '#facc15'; ctx.font = '11px sans-serif';
    for (const u of [0, 0.25, 0.5, 0.75, 1]) for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      const pt = coverPoint({ x: u, y: v });
      if (pt.x < -20 || pt.y < -20 || pt.x > stage.clientWidth + 20 || pt.y > stage.clientHeight + 20) continue;
      ctx.beginPath(); ctx.moveTo(pt.x - 7, pt.y); ctx.lineTo(pt.x + 7, pt.y); ctx.moveTo(pt.x, pt.y - 7); ctx.lineTo(pt.x, pt.y + 7); ctx.stroke();
      if (u === 0 || u === 1 || v === 0 || v === 1) ctx.fillText(u + ',' + v, pt.x + 8, pt.y - 4);
    }
    ctx.fillStyle = '#fff'; ctx.fillText(mappingInfo(), 10, stage.clientHeight - 10);
  }
  const pts = hands.map((h, hi) => {
    const lm = lms[hi], cursor = $(`#handCursor${hi}`);
    if (!lm) { if (h.seen && now - h.seen > 250) { registry.release(hi); h.pinch.reset(); h.needRelease = true; if (knobDrag?.hand === hi) endKnobDrag(); } cursor.style.display = 'none'; return null; }
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
    if (bothPinched) { registry.releaseAll(); endKnobDrag(); twoBusy = true; }
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
  // --- Garra: una mano sin pinza; cede ante pinza, dos manos y transicion ---
  clawHand = -1;
  const gate = clawGate({ enabled: $('#clawEnabled').checked, handCount: pts.filter(Boolean).length, anyPinched: pts.some(p => p?.det.pinched), anyGrabbed: !!registry.grabbedBy(0) || !!registry.grabbedBy(1), twoHandBusy: twoBusy, expressiveActive, autoTransition: !!smartTimer });
  if (!gate.run && $('#clawEnabled').checked && claw.engaged) { claw.update(null, now, { min: 0, max: 1, sensitivity: 1, invert: false, rangeMin01: 0, rangeMax01: 1 }); $('#clawStatus').textContent = `Garra soltada (${gate.reason}). Valor conservado; pinza y dos manos libres.`; }
  if (gate.run) {
    const hi = pts.findIndex(p => p);
    if (hi >= 0) {
      claw.prime(clawCurrentValue());
      const spec = CLAW_PARAMS[$('#clawParam').value];
      const r = claw.update({ aperture01: aperture01(pts[hi].lm), pinched: pts[hi].det.pinched }, now, { min: spec.min, max: spec.max, sensitivity: Number($('#clawSens').value), invert: $('#clawInvert').checked, rangeMin01: clamp(Number($('#clawMin').value || 0) / 100), rangeMax01: clamp(Number($('#clawMax').value || 100) / 100) });
      $('#clawBar').style.width = `${aperture01(pts[hi].lm) * 100}%`;
      if (r.engaged) { clawHand = hi; applyClawValue(r.value); $('#clawStatus').textContent = `Garra ENGANCHADA (mano ${hi}): abre/cierra para mover ${spec.label} del deck ${'AB'[Number($('#clawDeck').value)]}. Haz pinza para soltarla.`; }
      else if (r.event === 'released') $('#clawStatus').textContent = 'Garra soltada. Valor conservado; control manual activo.';
      else $('#clawStatus').textContent = 'Garra: mano detectada, esperando enganche (0,5 s sin pinza)…';
    } else { claw.update(null, now, { min: 0, max: 1, sensitivity: 1, invert: false, rangeMin01: 0, rangeMax01: 1 }); $('#clawStatus').textContent = 'Garra: sin mano. Valor conservado.'; }
  }
  // --- Mano individual: foco visible antes de pinzar ---
  document.querySelectorAll('[data-focus]').forEach(el => el.removeAttribute('data-focus'));
  document.querySelectorAll('[data-grabbed]').forEach(el => el.removeAttribute('data-grabbed'));
  let focusLabel = '';
  hands.forEach((h, hi) => {
    const p = pts[hi]; if (!p) return;
    const hit = registry.hit(p.x, p.y);
    if (hit && !p.det.pinched) { hit.el.setAttribute('data-focus', '1'); focusLabel = controlLabel(hit.el); $(`#handCursor${hi}`).querySelector('span').textContent = focusLabel; }
    else $(`#handCursor${hi}`).querySelector('span').textContent = p.det.pinched ? 'TOMADO' : '';
    if (twoBusy || expressiveActive || hi === clawHand) return;
    const grabbedId = registry.grabbedBy(hi);
    if (grabbedId) { const c = registry.controls.get(grabbedId); if (c?.el?.dataset.g === 'range') setRangeFromPoint(c.el, p.x, p.y); if (c?.el?.dataset.g === 'knob' && knobDrag?.hand === hi) moveKnobDrag(p.x); if (c) c.el.setAttribute('data-grabbed', '1'); }
    if (p.det.started && !h.needRelease && hit) {
      if (hit.el.dataset.g === 'range') { if (registry.grab(hi, hit.id)) setRangeFromPoint(hit.el, p.x, p.y); } else if (hit.el.dataset.g === 'knob') { if (registry.grab(hi, hit.id)) startKnobDrag(hit.el, p.x, hi); } else triggerEl(hit.el, p.x);
    }
    if (p.det.ended) { registry.release(hi); h.needRelease = false; if (knobDrag?.hand === hi) endKnobDrag(); }
    if (diag) {
      ctx.fillStyle = hi ? '#f472b6' : '#22d3ee';
      p.lm.forEach(pt0 => { const pt = coverPoint(pt0); ctx.fillRect(pt.x - 2, pt.y - 2, 4, 4); });
      ctx.fillStyle = '#fff'; ctx.font = '12px sans-serif';
      ctx.fillText(`Mano ${hi} (${mirrored ? 'espejo' : 'normal'}): pinza=${p.det.pinched ? 'SI' : 'no'} ratio=${pinchRatio(p.lm).toFixed(2)} foco=${controlLabel(hit?.el)} dos-manos=${two.state}`, 10, 18 + hi * 16);
    }
  });
  const ft = $('#focusTag'); ft.hidden = !focusLabel; ft.textContent = focusLabel ? `Enfocado: ${focusLabel} — haz pinza para tomarlo` : '';
  $('#chipFocus').textContent = `Foco: ${focusLabel || '—'}`;
  $('#stateDetail').textContent = `Cámara: ${video.srcObject ? 'activa' : 'apagada'} (${mirrored ? 'espejo' : 'normal'}) · Gestos: ${gesturesOn ? 'activos' : 'pausados'} · Foco: ${focusLabel || '—'} · Garra: ${$('#clawEnabled').checked ? (clawHand >= 0 ? 'enganchada' : 'activa sin enganchar') : 'desactivada'} · Dos manos: ${two.state}`;
}
loop();
