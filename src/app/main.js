import { AudioEngine, clipState, filterFreqs } from '../audio/engine.js';
import { computePeaks } from '../audio/bpm.js';
import { analyzeBeatgrid, quantizeToBeat, beatPhase01, alignToPhase, beatDelayTime, syncTempoPct, ecoDelayFor } from '../audio/beatgrid.js';
import { createHandTracker, startCamera } from '../camera/tracker.js';
import { PinchDetector, Smoother, ControlRegistry, pinchRatio, clamp, expandRect, mapVideoPointInBox, parseObjectPosition, visibleVideoWindow, fitFromObjectFit, knobDragValue, knobAngle, waveDragPosition, scratchRate, jogAngleDelta, handsDistance, TwoHandSession, assignHandSlots, zoomWindow, tempoDetent } from '../gestures/logic.js';
import { aperture01, ClawController, clawGate } from '../gestures/claw.js';
import { transitionValues, expressiveValues, smooth } from '../audio/transition.js';
import { evaluateAutoDj, autoDjTriggerKey } from '../audio/autodj.js';
import { enqueue, removeFromQueue, takeNext, chooseTargetDeck } from '../audio/queue.js';
import { FxSession, FX_PARAMS, fxCanAdjust } from '../audio/fx-twohand.js';

const $ = s => document.querySelector(s);
const stage = $('#stage'), video = $('#cam'), overlay = $('#overlay');
let engine = null, tracker = null, gesturesOn = false, diag = false;
let selectedTrack = null, smartTimer = null, recorder = null, recChunks = [];
const library = [];
const decks = [
  { el: $('#deckA'), name: 'A', track: null, bpm: null, grid: null, taps: [], peaks: null, hotcues: Array(8).fill(null), mode: 'hotcue', loop: null },
  { el: $('#deckB'), name: 'B', track: null, bpm: null, grid: null, taps: [], peaks: null, hotcues: Array(8).fill(null), mode: 'hotcue', loop: null }
];
const fmt = t => { if (!isFinite(t) || t < 0) t = 0; return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`; };
function status(msg) { $('#status').textContent = msg; }

// Pads fijos sin modos (Etapa 14): 2 HOT CUE, 2 BEAT JUMP, 2 PAD FX, 2 SAMPLER.
const PAD_LABELS = ['CUE 1', 'CUE 2', '◀ SALTO', 'SALTO ▶', 'FX FILTRO', 'FX ECO', 'SONIDO 1', 'SONIDO 2'];
const PAD_TITLES = ['Hot cue 1: guarda o salta (Mayús+clic o clic derecho borra)', 'Hot cue 2: guarda o salta (Mayús+clic o clic derecho borra)', 'Salta atrás 4 tiempos (a la rejilla)', 'Salta adelante 4 tiempos (a la rejilla)', 'Barrido de filtro corto', 'Eco corto', 'Sonido de sampler 1', 'Sonido de sampler 2'];
function padLabel(p) { return PAD_LABELS[p] || `PAD ${p + 1}`; }
function deckHTML(d, i) {
  const col = i === 0 ? 'var(--a)' : 'var(--b)';
  d.el.innerHTML = `
  <div class="deck-head"><span class="badge">${d.name}</span><h3><span class="tname">Sin pista</span></h3><span class="time bpm">BPM —</span></div>
  <canvas class="wave" width="480" height="88"></canvas>
  <canvas class="zoomwave" width="480" height="54" title="Onda ampliada: mira si las líneas gruesas caen sobre los bombos"></canvas>
  <div class="row"><span class="time pos">0:00</span><span class="time bpm">BPM —</span><span class="grow"></span><label class="time">Zoom <select class="zoomwin" title="Segundos visibles en la onda ampliada"><option value="4">4 s</option><option value="8" selected>8 s</option><option value="16">16 s</option></select></label><span class="time rem">-0:00</span></div>
  <div class="gridrow"><span class="gridstate time">Sin rejilla</span></div>
  <div class="deck-mid"><div class="jog" data-g="jog" title="Arrastra para scratch"><i></i></div><div class="transport">
  <div class="rowb">
    <button class="btn cue" data-act="cue" title="Marca o vuelve al punto CUE">CUE</button>
    <button class="btn play" data-act="play" title="Reproducir / pausar">▶ PLAY</button>
    <button class="btn" data-act="sync" title="Iguala el tempo con el otro deck y alinea golpes si la rejilla es fiable">SYNC</button>
  </div>
  <label>Tempo <span class="tempoval">+0.0%</span><input class="tempo" type="range" min="-8" max="8" step="0.1" value="0" data-g="range" data-deck="${i}" data-param="tempo" title="Velocidad de la pista. Centro = 0 % (retén)"></label>
  <div class="row">
    <button class="btn small loopbtn dj-only" data-act="loop" title="Repite 4 tiempos desde el golpe más cercano">LOOP 4</button>
    <button class="btn small ecohold" title="Mantén pulsado: eco mientras lo sostienes; al soltar se apaga solo">ECO (mantén)</button></div></div>
  </div>
  <div class="pads">${Array.from({ length: 8 }, (_, p) => `<button class="pad" data-pad="${p}" title="${PAD_TITLES[p]}">${PAD_LABELS[p]}</button>`).join('')}</div>`;
}
decks.forEach(deckHTML);
$('#mixer').innerHTML = `
  <h3 style="text-align:center;margin:2px 0 8px">MEZCLADOR</h3>
  <div class="mixgrid">
    ${[0, 1].map(i => `<div class="mixcol"><strong>CANAL ${'AB'[i]}</strong>
      ${[['high', 'HIGH', -26, 6, 0.5, 0, 'dB', 'dj-only'], ['mid', 'MID', -26, 6, 0.5, 0, 'dB', 'dj-only'], ['low', 'LOW', -26, 6, 0.5, 0, 'dB', ''], ['trim', 'TRIM', 0, 2, 0.01, 1, '%', 'dj-only']].map(([p, l, mn, mx, st, v, unit, cls]) => knobHTML(i, p, l, mn, mx, st, v, unit, cls)).join('')}
      ${knobHTML(i, 'filter', `FILTRO ${'AB'[i]}`, -50, 50, 1, 0, '', 'dj-only knob-filter-wrap')}
      ${knobHTML(i, 'eco', `ECO ${'AB'[i]}`, 0, 0.8, 0.01, 0, '%', 'dj-only')}
    </div>${i === 0 ? '<div class="mixmeters"><div class="leds" title="Nivel del canal A"><i class="chmeter" data-meter="0"></i></div><div class="leds" title="Nivel del canal B"><i class="chmeter" data-meter="1"></i></div></div>' : ''}`).join('')}
  </div>
  <div class="faderow"><div>VOL A<br><input class="vfader" type="range" min="0" max="1" step="0.01" value="0.85" data-g="range" data-orient="v" data-deck="0" data-param="vol" title="Volumen del canal A"></div>
  <div class="knobwrap"><button type="button" class="knob" data-g="knob" data-param="master" aria-label="Volumen master"><span class="knob-dial"><i></i></span></button><label>MASTER</label><input class="knob-state" type="range" min="0" max="1" step="0.01" value="0.85" data-g="range" data-param="master" data-display="pct" hidden></div>
  <div>VOL B<br><input class="vfader" type="range" min="0" max="1" step="0.01" value="0.85" data-g="range" data-orient="v" data-deck="1" data-param="vol" title="Volumen del canal B"></div></div>
  <div class="crossbox"><label style="display:block;text-align:center;font-size:11px">CROSSFADER</label>
  <input id="cross" type="range" min="-1" max="1" step="0.01" value="0" data-g="range" data-param="cross" title="Mezcla entre el deck A y el B">
  <div class="row"><strong style="color:var(--a)">A</strong><span class="grow"></span><strong style="color:var(--b)">B</strong></div></div>
  <details class="avanzado dj-only"><summary>Avanzado</summary>
    <label>FX REVERB <input type="range" min="0" max="0.8" step="0.01" value="0" data-g="range" data-param="verb" style="width:110px"></label>
    <div class="ecosync">ECO fracciones <select id="ecoDeck"><option value="0">Deck A</option><option value="1">Deck B</option></select>
    <button class="btn small" data-eco="0.25">¼</button><button class="btn small" data-eco="0.5">½</button><button class="btn small" data-eco="1">1</button>
    <span id="ecoState" class="time">eco sin sincronizar</span></div>
    <p class="msg">Las fracciones fijan el tiempo del eco compartido; la perilla ECO de cada canal usa ½ tiempo de su propio deck.</p>
  </details>
  </div>`;

// ---------- Espectro del master (barato: buffer reutilizado, ~30 fps) ----------
let spectrumOn = localStorage.getItem('motiondj-spectrum') !== '0', spectrumBuf = null, spectrumFrame = 0;
const spectrumPeaks = new Float32Array(64);
function drawSpectrum() {
  const wrap = $('#spectrumWrap');
  if (!wrap) return;
  const show = spectrumOn && document.body.dataset.view !== 'easy';
  wrap.style.display = show ? '' : 'none';
  if (!show || !engine) return;
  if ((spectrumFrame++ & 1) === 1) return; // ~mitad de fotogramas
  const an = engine.masterAnalyser, cv = $('#spectrum'), ctx = cv.getContext('2d');
  if (!spectrumBuf || spectrumBuf.length !== an.frequencyBinCount) spectrumBuf = new Uint8Array(an.frequencyBinCount);
  an.getByteFrequencyData(spectrumBuf);
  const W = cv.width, H = cv.height, bars = spectrumPeaks.length;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(6,17,26,.85)'; ctx.fillRect(0, 0, W, H);
  const nyq = engine.ctx.sampleRate / 2;
  const grad = ctx.createLinearGradient(0, H, 0, 0);
  grad.addColorStop(0, '#0e7490'); grad.addColorStop(0.55, '#22d3ee'); grad.addColorStop(0.85, '#f472b6'); grad.addColorStop(1, '#facc15');
  for (let b = 0; b < bars; b++) {
    // Eje logaritmico 40 Hz .. Nyquist
    const f0 = 40 * Math.pow(nyq / 40, b / bars), f1 = 40 * Math.pow(nyq / 40, (b + 1) / bars);
    const i0 = Math.max(1, Math.floor(f0 / nyq * spectrumBuf.length)), i1 = Math.max(i0 + 1, Math.floor(f1 / nyq * spectrumBuf.length));
    let mx = 0; for (let i = i0; i < i1 && i < spectrumBuf.length; i++) if (spectrumBuf[i] > mx) mx = spectrumBuf[i];
    // Compensa la inclinacion natural (los graves dominan) para leer la musica.
    const v = Math.min(1, (mx / 255) * (0.55 + 0.75 * (b / bars)));
    spectrumPeaks[b] = Math.max(v, spectrumPeaks[b] - 0.008); // caida de picos lenta
    const w = W / bars;
    ctx.fillStyle = grad;
    ctx.globalAlpha = 0.9;
    ctx.fillRect(b * w + 1, H - v * H, w - 2, v * H);
    ctx.globalAlpha = 1; ctx.fillStyle = '#f8fafc';
    ctx.fillRect(b * w + 1, H - spectrumPeaks[b] * H - 2, w - 2, 2);
  }
}
$('#btnSpectrum').onclick = () => {
  spectrumOn = !spectrumOn;
  localStorage.setItem('motiondj-spectrum', spectrumOn ? '1' : '0');
  $('#btnSpectrum').setAttribute('aria-pressed', spectrumOn);
  spectrumPeaks.fill(0);
};
$('#btnSpectrum').setAttribute('aria-pressed', spectrumOn);
function knobHTML(i, p, label, mn, mx, step, v, unit, cls = '') {
  const disp = (p === 'trim' || p === 'eco') ? 'pct' : '';
  const titles = { eco: 'Repite el sonido al ritmo de la canción. Súbelo para más eco', filter: 'Gira a un lado para quitar agudos, al otro para quitar graves. Centro = normal', low: 'Graves del canal', mid: 'Medios del canal', high: 'Agudos del canal', trim: 'Volumen de entrada del canal' };
  return `<div class="knobwrap ${cls}"><button type="button" class="knob${p === 'filter' ? ' knob-filter' : ''}" style="--kc:var(--${i === 1 ? 'b' : 'a'})" data-g="knob" data-deck="${i}" data-param="${p}" aria-label="${label}, Deck ${'AB'[i]}" title="${titles[p] || label}"><span class="knob-dial"><i></i></span></button><label>${label}</label><input class="knob-state" type="range" min="${mn}" max="${mx}" step="${step}" value="${v}" data-g="range" data-deck="${i}" data-param="${p}" data-unit="${unit}" data-display="${disp}" hidden></div>`;
}
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
  if (d.grid?.bpm && d.grid.firstBeat != null && d.track) {
    const beat = 60 / d.grid.bpm, dur = d.track.buffer.duration;
    let idx = 0;
    for (let tt = d.grid.firstBeat; tt < dur; tt += beat, idx++) {
      const x = tt / dur * cv.width, strong = idx % 4 === 0;
      ctx.fillStyle = strong ? 'rgba(255,255,255,.75)' : 'rgba(255,255,255,.28)';
      ctx.fillRect(x, strong ? 0 : 14, strong ? 2 : 1, cv.height - (strong ? 0 : 14));
    }
    ctx.fillStyle = '#4ade80'; ctx.fillRect(d.grid.firstBeat / dur * cv.width, 0, 3, cv.height); // primer golpe
  }
  ctx.globalAlpha = 1; ctx.fillStyle = '#fff'; ctx.fillRect(pos * cv.width, 0, 2, cv.height);
  (d.hotcues || []).forEach(h => { if (h !== null && d.track) { ctx.fillStyle = '#facc15'; ctx.fillRect(h / d.track.buffer.duration * cv.width, 0, 2, 10); } });
}
// Onda ampliada (Etapa 12): ventana de 4/8/16 s alrededor de la posicion,
// con la rejilla nitida. Solo visualizacion: no corrige nada.
function drawZoomWave(d) {
  const cv = d.el.querySelector('.zoomwave'); if (!cv || !engine || !d.track || !d.peaksZoom) return;
  const ctx = cv.getContext('2d'), pos = engine.decks[decks.indexOf(d)].position(), dur = d.track.buffer.duration;
  const winSec = Number(d.el.querySelector('.zoomwin')?.value || 8);
  const { start, end, frac } = zoomWindow(pos, dur, winSec);
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = d.name === 'A' ? '#22d3ee' : '#f472b6';
  const n = d.peaksZoom.length, i0 = Math.floor(start / dur * n), i1 = Math.max(i0 + 1, Math.ceil(end / dur * n));
  const w = cv.width / Math.max(1, i1 - i0);
  for (let i = i0; i < i1 && i < n; i++) { const h = Math.max(2, d.peaksZoom[i] * 50); ctx.globalAlpha = start + (i - i0) / (i1 - i0) * (end - start) <= pos ? 1 : 0.4; ctx.fillRect((i - i0) * w, 27 - h / 2, Math.max(1, w - 0.5), h); }
  ctx.globalAlpha = 1;
  if (d.loop) { ctx.fillStyle = 'rgba(74,222,128,.18)'; ctx.fillRect((d.loop.start - start) / (end - start) * cv.width, 0, d.loop.len / (end - start) * cv.width, cv.height); }
  if (d.grid?.bpm && d.grid.firstBeat != null) {
    const beat = 60 / d.grid.bpm;
    const k0 = Math.ceil((start - d.grid.firstBeat) / beat);
    for (let k = k0; ; k++) {
      const tt = d.grid.firstBeat + k * beat; if (tt > end) break;
      const x = (tt - start) / (end - start) * cv.width, strong = ((k % 4) + 4) % 4 === 0;
      ctx.fillStyle = strong ? 'rgba(255,255,255,.9)' : 'rgba(255,255,255,.35)';
      ctx.fillRect(x, strong ? 0 : 10, strong ? 2 : 1, cv.height - (strong ? 0 : 10));
    }
    ctx.fillStyle = '#4ade80'; const fx = (d.grid.firstBeat - start) / (end - start) * cv.width; if (fx >= 0 && fx <= cv.width) ctx.fillRect(fx, 0, 3, cv.height);
  }
  (d.hotcues || []).forEach(h => { if (h !== null && h >= start && h <= end) { ctx.fillStyle = '#facc15'; ctx.fillRect((h - start) / (end - start) * cv.width, 0, 2, 10); } });
  ctx.fillStyle = '#fff'; ctx.fillRect(frac * cv.width, 0, 2, cv.height);
}
// ---------- Biblioteca ----------
function renderLibrary() {
  const q = $('#search').value.toLowerCase(), ul = $('#trackList'); ul.innerHTML = '';
  library.filter(t => t.name.toLowerCase().includes(q)).forEach(t => {
    const li = document.createElement('li');
    if (selectedTrack === t) li.className = 'sel';
    li.innerHTML = `<span>${t.name}</span><span>${decks.map((d, i) => d.track === t ? `<span class="tagdeck">DECK ${'AB'[i]}</span>` : '').join('')} <button class="btn small" data-qadd title="Añadir a la cola">+ cola</button> <button class="btn small" data-qdel title="Quitar de la biblioteca">✕</button></span>`;
    li.onclick = () => { selectedTrack = t; renderLibrary(); };
    li.querySelector('[data-qadd]').onclick = (e) => { e.stopPropagation(); playQueue = enqueue(playQueue, t); renderQueue(); $('#libMsg').textContent = `En cola: ${t.name}`; };
    li.querySelector('[data-qdel]').onclick = (e) => { e.stopPropagation(); const ix = library.indexOf(t); if (ix >= 0) library.splice(ix, 1); playQueue = playQueue.filter(x => x !== t); if (selectedTrack === t) selectedTrack = null; renderLibrary(); renderQueue(); $('#libMsg').textContent = `Quitada de la biblioteca: ${t.name} (si sonaba en un deck, sigue hasta que cargues otra).`; };
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
async function loadToDeck(i, track = selectedTrack) {
  if (!track) { $('#libMsg').textContent = 'Selecciona primero una pista de la lista.'; return; }
  ensureEngine(); const ch = engine.decks[i], d = decks[i];
  if (ch.playing) { if (!confirm(`El deck ${d.name} está sonando. ¿Detenerlo y reemplazar la pista?`)) return; }
  ch.load(track.buffer); d.track = track; d.hotcues = Array(8).fill(null);
  d.loop = null; ch.clearLoop();
  d.el.querySelectorAll('.pad').forEach((b, p) => { b.classList.remove('set'); b.textContent = padLabel(p); });
  const lb = d.el.querySelector('.loopbtn'); if (lb) lb.textContent = 'LOOP 4';
  const tempoInp = d.el.querySelector('.tempo'); if (tempoInp) { tempoInp.value = 0; d.el.querySelector('.tempoval').textContent = '+0.0%'; }
  ch.setRate(1);
  d.peaks = computePeaks(track.buffer);
  d.peaksZoom = computePeaks(track.buffer, 1440);
  d.grid = analyzeBeatgrid(track.buffer.getChannelData(0), track.buffer.sampleRate);
  d.bpm = d.grid?.bpm || null; d.taps = [];
  d.el.querySelector('.tname').textContent = track.name;
  updateGridUI(d);
  drawWave(d); renderLibrary(); status(`Pista cargada en deck ${d.name}. No suena hasta pulsar PLAY.`);
}
function updateGridUI(d) {
  // Solo lectura (Etapa 13): BPM estimado y estado de la rejilla, sin controles.
  const g = d.grid;
  d.el.querySelectorAll('.bpm').forEach(el => { el.textContent = g?.bpm ? `BPM ~${g.bpm.toFixed(1)} (estimado)` : 'BPM —'; });
  const st = d.el.querySelector('.gridstate');
  if (st) st.textContent = !g?.bpm ? 'Sin rejilla: este deck funciona sin SYNC de golpes ni eco al ritmo' : `Rejilla estimada · confianza ${g.confidence.toFixed(2)}${g.ambiguous ? ' · tempo dudoso entre dos octavas' : ''} · mira la onda ampliada`;
  drawWave(d);
  refreshEcoTimes();
}
$('#loadA').onclick = () => loadToDeck(0);
$('#loadB').onclick = () => loadToDeck(1);
// ---------- Controles de deck ----------
// ECO por canal (Etapa 14): tiempo automatico a 1/2 del BPM efectivo del
// deck; sin BPM, 0,28 s fijo sin avisos. El delay es compartido: manda el
// ultimo canal con ECO movido. Las fracciones de Avanzado tienen prioridad
// mientras esten elegidas (ecoSync).
let lastEcoDeck = 0;
function ecoKnobValue(i) { return Number(document.querySelector(`input.knob-state[data-param="eco"][data-deck="${i}"]`)?.value || 0); }
function ecoTimeForDeck(i) { const d = decks[i], tempoPct = Number(d.el.querySelector('.tempo')?.value || 0); const r = ecoDelayFor(d.grid?.bpm, tempoPct, 0.5); return r ? r.sec : 0.28; }
function refreshEcoTimes() {
  if (!engine) return;
  if (typeof ecoSync !== 'undefined' && ecoSync.fraction !== null) return refreshEco();
  const i = ecoKnobValue(lastEcoDeck) > 0 ? lastEcoDeck : (ecoKnobValue(0) > 0 ? 0 : (ecoKnobValue(1) > 0 ? 1 : -1));
  if (i >= 0) engine.setDelayTime(ecoTimeForDeck(i));
}
function setParam(input) {
  if (!engine) return;
  const p = input.dataset.param, i = Number(input.dataset.deck), v = Number(input.value), ch = engine?.decks[i], t = engine.ctx.currentTime;
  if (p === 'master') return engine.master.gain.setTargetAtTime(v, t, 0.03);
  if (p === 'cross') return engine.setCross(v);
  if (p === 'delay') return engine.decks.forEach(d => d.delaySend.gain.setTargetAtTime(v, t, 0.05));
  if (p === 'verb') return engine.decks.forEach(d => d.verbSend.gain.setTargetAtTime(v, t, 0.05));
  if (!ch) return;
  if (p === 'tempo') { const bpm = decks[i].bpm || 120; ch.setRate(bpm ? (1 + v / 100) : 1); decks[i].el.querySelector('.tempoval').textContent = `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`; refreshEcoTimes(); }
  if (p === 'vol') ch.fader.gain.setTargetAtTime(v, t, 0.03);
  if (p === 'trim') ch.trim.gain.setTargetAtTime(v, t, 0.03);
  if (p === 'low') ch.low.gain.setTargetAtTime(v, t, 0.03);
  if (p === 'mid') ch.mid.gain.setTargetAtTime(v, t, 0.03);
  if (p === 'high') ch.high.gain.setTargetAtTime(v, t, 0.03);
  if (p === 'eco') { lastEcoDeck = i; ch.delaySend.gain.setTargetAtTime(v, t, 0.05); refreshEcoTimes(); }
  if (p === 'filter') { const f = filterFreqs(v); ch.filter.frequency.setTargetAtTime(f.lp, t, 0.03); ch.filterHp.frequency.setTargetAtTime(f.hp, t, 0.03); }
}
document.addEventListener('input', e => { if (e.target.matches('input[type=range][data-param]')) { if (e.target.dataset.param === 'tempo') { const nv = tempoDetent(Number(e.target.value)); if (nv !== Number(e.target.value)) e.target.value = nv; } setParam(e.target); } });
function deckAction(i, act, btn) {
  ensureEngine(); const ch = engine.decks[i], d = decks[i];
  if (!ch.buffer) { status(`Carga una pista en el deck ${d.name} primero.`); return; }
  if (act === 'play') { ch.playing ? ch.pause() : ch.play(); }
  if (act === 'cue') { if (ch.playing) { ch.seek(ch.cue ?? 0); } else { ch.cue = ch.position(); ch.seek(ch.cue); status(`CUE deck ${d.name} en ${fmt(ch.cue)} (pulsa CUE sonando para volver)`); } }
  if (act === 'sync') {
    const other = decks[1 - i], otherCh = engine.decks[1 - i];
    if (!d.bpm || !other.bpm) { status('SYNC no disponible: falta BPM en algún deck. Carga la pista en ambos decks.'); return; }
    const otherTempoPct = Number(other.el.querySelector('.tempo')?.value || 0);
    const sync = syncTempoPct(d.bpm, other.bpm, otherTempoPct);
    if (!sync.ok && sync.reason === 'fuera-rango') { status(`SYNC fuera de rango (±8%): harían falta ${sync.pct.toFixed(1)}%.`); return; }
    const tempo = sync.pct;
    const inp = d.el.querySelector('.tempo'); inp.value = tempo.toFixed(1); setParam(inp);
    const CONF = 0.3;
    if (d.grid && other.grid && d.grid.confidence >= CONF && other.grid.confidence >= CONF && otherCh.playing) {
      const targetPhase = beatPhase01(otherCh.position(), other.grid);
      const dest = alignToPhase(ch.position(), d.grid, targetPhase);
      ch.seek(dest);
      status(`SYNC deck ${d.name}: tempo ${tempo.toFixed(1)}% y golpes alineados con ${other.name} (rejillas estimadas).`);
    } else {
      status(`SYNC de TEMPO deck ${d.name}: ${tempo.toFixed(1)}% (sin alinear golpes: rejilla ${!d.grid || !other.grid ? 'ausente' : 'poco fiable'}). Revisa la rejilla y vuelve a intentarlo.`);
    }
  }
  if (act === 'loop') {
    if (d.loop) { d.loop = null; ch.clearLoop(); btn.textContent = 'LOOP 4'; }
    else if (d.grid?.bpm) {
      const beat = 60 / d.grid.bpm, start = quantizeToBeat(ch.position(), d.grid);
      d.loop = { start, len: beat * 4 };
      ch.setLoop(start, start + beat * 4); // loop programado en el motor, sin seek
      btn.textContent = 'LOOP ON';
      status(`Loop de 4 tiempos desde el golpe (${fmt(start)}) en deck ${d.name}.`);
    }
    else status('Loop necesita la rejilla estimada de la pista.');
  }
  refreshTransport();
}
// Pads fijos (Etapa 14): cada pad siempre hace lo mismo, sin cambiar de modo.
// 0-1 HOT CUE · 2-3 BEAT JUMP -4/+4 · 4-5 PAD FX · 6-7 SAMPLER.
function padAction(i, p, btn) {
  ensureEngine(); const ch = engine.decks[i], d = decks[i];
  btn.classList.add('hit'); setTimeout(() => btn.classList.remove('hit'), 180);
  if (p >= 6) return engine.playSample(p - 6 + 2);
  if (!ch.buffer) { status('Carga una pista para usar los pads.'); return; }
  if (p <= 1) {
    if (d.hotcues[p] === null) { d.hotcues[p] = ch.position(); btn.classList.add('set'); btn.textContent = `CUE ${p + 1} ● ${fmt(d.hotcues[p])}`; drawWave(d); }
    else ch.seek(d.hotcues[p]);
  }
  if (p === 2 || p === 3) {
    if (!d.bpm) { status('Saltar necesita el BPM estimado de la pista.'); return; }
    const beat = 60 / d.bpm, target = ch.position() + (p === 2 ? -4 : 4) * beat;
    ch.seek(d.grid ? quantizeToBeat(target, d.grid) : target);
  }
  if (p === 4) { const oldLp = ch.filter.frequency.value, oldHp = ch.filterHp.frequency.value, t = engine.ctx.currentTime; ch.filter.frequency.setValueAtTime(500, t); ch.filter.frequency.setTargetAtTime(oldLp, t + 0.3, 0.08); setTimeout(() => { ch.filterHp.frequency.setTargetAtTime(oldHp, engine.ctx.currentTime, 0.05); }, 400); }
  if (p === 5) { const prev = ch.delaySend.gain.value, t = engine.ctx.currentTime; engine.setDelayTime(ecoTimeForDeck(i)); ch.delaySend.gain.setValueAtTime(0.6, t); setTimeout(() => ch.delaySend.gain.setTargetAtTime(prev, engine.ctx.currentTime, 0.08), 650); }
}
// ---------- Hot cues: borrar / reemplazar y cola de reproduccion ----------
let playQueue = [];
function deleteCue(i, p, btn) {
  const d = decks[i];
  if (d.hotcues[p] === null) { status(`El pad ${p + 1} del deck ${d.name} ya está vacío.`); return; }
  d.hotcues[p] = null;
  if (btn) { btn.classList.remove('set'); btn.textContent = padLabel(p); }
  drawWave(d);
  status(`Hot cue ${p + 1} del deck ${d.name} borrado. Un clic en el pad lo vuelve a guardar (reemplazar = borrar y guardar).`);
}
function renderQueue() {
  const ul = $('#queueList'); if (!ul) return;
  ul.innerHTML = '';
  playQueue.forEach((t, ix) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${ix + 1}. ${t.name}</span><button class="btn small">✕</button>`;
    li.querySelector('button').onclick = () => { playQueue = removeFromQueue(playQueue, ix); renderQueue(); };
    ul.appendChild(li);
  });
  $('#queueInfo').textContent = playQueue.length ? `Cola: ${playQueue.length} pista(s). «Siguiente» la carga en el deck que no suena.` : 'Cola vacía: añade pistas con «+ cola». Cada deck lleva una pista; la siguiente va al otro deck mientras suena el primero.';
}
function nextInQueue(manual = true) {
  ensureEngine();
  const target = chooseTargetDeck(decks.map((d, i) => ({ hasTrack: !!d.track, playing: !!engine.decks[i].playing })));
  if (target < 0) { if (manual) status('Suenan los dos decks: «Siguiente» no reemplaza ninguno sin tu confirmación.'); return false; }
  const taken = takeNext(playQueue);
  if (!taken.track) { if (manual) status('La cola está vacía. Añade pistas con «+ cola».'); return false; }
  playQueue = taken.queue; renderQueue();
  loadToDeck(target, taken.track);
  status(`Siguiente: «${taken.track.name}» cargada en el deck ${decks[target].name} (no suena hasta PLAY o Auto DJ).`);
  return true;
}
$('#btnNextTrack')?.addEventListener('click', () => nextInQueue(true));
$('#btnEasyMix')?.addEventListener('click', () => {
  ensureEngine();
  const playing = decks.findIndex((d, i) => engine.decks[i].playing && d.track);
  if (playing < 0) { status('Igualar y mezclar: primero pon una pista a sonar (PLAY).'); return; }
  const other = 1 - playing;
  if (!decks[other].track) { status('Igualar y mezclar: carga otra pista en el deck libre (LOAD).'); return; }
  deckAction(other, 'sync', decks[other].el.querySelector('[data-act="sync"]'));
  if (!engine.decks[other].playing) engine.decks[other].play();
  startAutoTransition(other === 1 ? 1 : -1, 8000);
  status(`Igualar y mezclar: mezclando hacia el deck ${'AB'[other]} en 8 s.`);
});
decks.forEach((d, i) => {
  d.el.addEventListener('click', e => {
    const act = e.target.dataset?.act, pad = e.target.dataset?.pad;
    if (act) deckAction(i, act, e.target);
    if (pad !== undefined) { if (e.shiftKey) deleteCue(i, Number(pad), e.target); else padAction(i, Number(pad), e.target); }
  });
  d.el.addEventListener('contextmenu', e => {
    if (e.target.classList.contains('pad')) { e.preventDefault(); deleteCue(i, Number(e.target.dataset.pad), e.target); }
  });
  const jog = d.el.querySelector('.jog');
  jog.style.touchAction = 'none';
  jog.addEventListener('pointerdown', e => {
    if (!engine || !d.track) return;
    ensureEngine();
    const r = jog.getBoundingClientRect();
    startScratch('mouse' + i, i, e.clientY);
    const s = scratches.get('mouse' + i);
    if (s) { s.cx = r.left + r.width / 2; s.cy = r.top + r.height / 2; s.lastA = Math.atan2(e.clientY - s.cy, e.clientX - s.cx); }
    try { jog.setPointerCapture(e.pointerId); } catch {}
  });
  jog.addEventListener('pointermove', e => {
    const s = scratches.get('mouse' + i); if (!s) return;
    const now = performance.now(), dt = Math.max(1, now - s.lastT) / 1000;
    const a = Math.atan2(e.clientY - s.cy, e.clientX - s.cx);
    const rev = jogAngleDelta(s.lastA, a) / (2 * Math.PI) / dt;
    s.lastA = a; s.lastT = now;
    applyScratchRev('mouse' + i, rev);
  });
  jog.addEventListener('pointerup', () => endScratch('mouse' + i));
  jog.addEventListener('pointercancel', () => endScratch('mouse' + i));
  const ecoBtn = d.el.querySelector('.ecohold');
  if (ecoBtn) {
    const on = e => { e.preventDefault(); ensureEngine(); engine.setDelayTime(ecoTimeForDeck(i)); engine.decks[i].delaySend.gain.setTargetAtTime(0.55, engine.ctx.currentTime, 0.03); ecoBtn.classList.add('play-on'); };
    const off = () => { if (engine) engine.decks[i].delaySend.gain.setTargetAtTime(ecoKnobValue(i), engine.ctx.currentTime, 0.09); ecoBtn.classList.remove('play-on'); };
    ecoBtn.addEventListener('pointerdown', on); ecoBtn.addEventListener('pointerup', off); ecoBtn.addEventListener('pointerleave', off); ecoBtn.addEventListener('pointercancel', off);
  }
  const wave = d.el.querySelector('.wave');
  wave.style.touchAction = 'none';
  wave.addEventListener('pointerdown', e => {
    if (!engine || !d.track) return;
    ensureEngine(); const ch = engine.decks[i], r = wave.getBoundingClientRect();
    const jump = (e.clientX - r.left) / r.width * d.track.buffer.duration;
    ch.seek(jump); // clic corto: salto al punto (como siempre)
    d._waveDrag = { x: e.clientX, pos: ch.position(), last: 0 };
    try { wave.setPointerCapture(e.pointerId); } catch {}
  });
  wave.addEventListener('pointermove', e => {
    if (!d._waveDrag || !engine || !d.track) return;
    moveWaveDrag(i, e.clientX, performance.now());
  });
  const endWave = () => { if (d._waveDrag && engine && d.track) moveWaveDrag(i, null, performance.now(), true); d._waveDrag = null; };
  wave.addEventListener('pointerup', endWave);
  wave.addEventListener('pointercancel', endWave);
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
let consoleFit = 1;
// La consola nunca se recorta (Etapa 9): si es mas alta que el escenario,
// se escala lo justo para caber entera, sin tocar zonas minimas en pantalla
// movil (alli la consola fluye en columna y no necesita escala).
function fitConsole() {
  if (window.innerWidth <= 640) { consoleFit = 1; return; }
  const prev = consoleEl.style.transform;
  consoleEl.style.transform = '';
  const h = consoleEl.offsetHeight, sh = stage.clientHeight;
  consoleFit = h > 0 && sh > 0 ? Math.min(1, (sh * 0.95 - 8) / h) : 1; // deja el margen inferior del ancla
  consoleEl.style.transform = prev;
  applyCal(false);
}
function applyCal(save = true) {
  const s = $('#calScale').value, x = $('#calX').value, y = $('#calY').value;
  consoleEl.style.transform = `translateX(calc(-50% + ${x}px)) scale(${s * consoleFit})`;
  consoleEl.style.bottom = `calc(3% + ${-y}px)`;
  document.documentElement.style.setProperty('--ctl', $('#calSize').value);
  document.documentElement.style.setProperty('--alpha', $('#calOpacity')?.value || 0.86);
  const kv = $('#calKnobVal'); if (kv) kv.textContent = $('#calKnob')?.value || 220;
  if (save) localStorage.setItem('motiondj-cal', JSON.stringify({ s, x, y, size: $('#calSize').value, sens: $('#calSens').value, knob: $('#calKnob')?.value || 220 }));
}
try { const c = JSON.parse(localStorage.getItem('motiondj-cal') || 'null'); if (c) { $('#calScale').value = c.s; $('#calX').value = c.x; $('#calY').value = c.y; $('#calSize').value = c.size; $('#calSens').value = c.sens; if (c.knob && $('#calKnob')) $('#calKnob').value = c.knob; } } catch {}
['calScale', 'calX', 'calY', 'calSize', 'calSens', 'calHit', 'calOpacity', 'calKnob'].forEach(id => { const el = $('#' + id); if (el) el.addEventListener('input', () => applyCal()); });
// ---------- Vistas Facil / DJ (mismo estado y motor; solo cambia visibilidad) ----------
function setView(v) { requestAnimationFrame(() => { if (typeof hands !== 'undefined') hands.forEach(h => { h.smoothX.reset(); h.smoothY.reset(); }); if (typeof fitConsole === 'function') fitConsole(); if (typeof rebuildRegistry === 'function') rebuildRegistry(); });
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
function lowInput(i) { return document.querySelector(`input.knob-state[data-param="low"][data-deck="${i}"]`); }
function filterInputs() { return [0, 1].map(i => document.querySelector(`input.knob-state[data-param="filter"][data-deck="${i}"]`)); }
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
function checkAutoDj(now) {
  const plan0 = autoDjPlanNow();
  if ($('#autoDjEnabled').checked && plan0.active !== null && plan0.next !== null && !decks[plan0.next].track && playQueue.length) nextInQueue(false);
  const plan = autoDjPlanNow(); autoDjRender(plan); if (!plan.shouldTransition || smartTimer || autoDjTimerBusy) return; const key = autoDjTriggerKey(plan, decks.map(d => d.track?.id)); if (key === autoDjLastKey) return; autoDjLastKey = key; startAutoDjTransition(plan, 'Auto DJ'); }
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
// Eco sincronizado: recuerda deck + fraccion y sigue al BPM EFECTIVO de ese
// deck (nominal x tempo aplicado, como el SYNC de la Etapa 1).
const ecoSync = { deck: 0, fraction: null };
function refreshEco(announce = false) {
  if (ecoSync.fraction === null || !engine) return;
  const i = ecoSync.deck, d = decks[i];
  const tempoPct = Number(d.el.querySelector('.tempo')?.value || 0);
  const r = ecoDelayFor(d.grid?.bpm, tempoPct, ecoSync.fraction);
  const fracTxt = { '0.25': '¼', '0.5': '½', '1': '1' }[String(ecoSync.fraction)];
  if (!r) { $('#ecoState').textContent = 'eco sin sincronizar'; if (announce) status(`Eco sin sincronizar: el deck ${'AB'[i]} no tiene BPM. El tiempo no cambió.`); return; }
  engine.setDelayTime(r.sec);
  $('#ecoState').textContent = `Eco ${fracTxt} de tiempo · ${r.sec.toFixed(3)} s (deck ${'AB'[i]}, BPM efectivo ${r.effectiveBpm.toFixed(1)})`;
  if (announce) status(`Eco sincronizado a ${fracTxt} de tiempo del deck ${'AB'[i]}: ${r.sec.toFixed(3)} s. Sube FX DELAY del mezclador para oírlo.`);
}
$('#mixer').addEventListener('click', e => {
  const f = e.target.dataset?.eco; if (!f) return;
  ensureEngine();
  ecoSync.deck = Number($('#ecoDeck').value); ecoSync.fraction = Number(f);
  refreshEco(true);
});
$('#ecoDeck')?.addEventListener('change', () => { ecoSync.deck = Number($('#ecoDeck').value); refreshEco(); });
$('#btnTwoConfirm').onclick = () => { $('#btnTwoConfirm').disabled = true; confirmTwoHand(); };
$('#btnTwoCancel').onclick = () => { cancelAuto(); autoDjTimerBusy = false; freezeExpressive('Cancelado por el usuario.'); two.reset(); $('#btnTwoConfirm').disabled = true; };
$('#twoEnabled').onchange = e => { if (!e.target.checked) { two.reset(); freezeExpressive('Dos manos desactivado.'); cancelAuto(false); twoBanner(''); } twoStatus(e.target.checked ? 'Activado. Mantén pinza con AMBAS manos 1 s para preparar (no se activa bailando ni con una mano).' : 'Desactivado.'); };
$('#autoDjEnabled').onchange = () => { autoDjLastKey = null; const p = autoDjPlanNow(); autoDjRender(p); if ($('#autoDjEnabled').checked) $('#autoDjStatus').textContent = p.reason; };
$('#autoDjAnt').oninput = () => { $('#autoDjAntVal').textContent = $('#autoDjAnt').value; };
$('#btnAutoDjNow').onclick = () => { if (!$('#autoDjEnabled').checked) { $('#autoDjStatus').textContent = 'Activa Auto DJ primero; la transicion a pedido no arranca sola.'; return; } const p = autoDjPlanNow(); if (startAutoDjTransition(p, 'Transicion a pedido')) autoDjLastKey = autoDjTriggerKey(p, decks.map(d => d.track?.id)); else autoDjRender(p); };
$('#btnAutoDjCancel').onclick = () => cancelAutoDj();
// ---------- Efectos a dos pinzas (prototipo Filtro/Eco) ----------
const fx = new FxSession();
const FX_IDS = ['filter', 'delay'];
function fxCurrentValue() {
  if (fx.effectId === 'delay') return engine ? engine.decks[fx.deck].delaySend.gain.value : 0;
  return Number(document.querySelector(`input.knob-state[data-param="filter"][data-deck="${fx.deck}"]`)?.value || 0);
}
function fxApplyValue(v, feedback) {
  ensureEngine(); if (!engine) return;
  const t = engine.ctx.currentTime;
  if (fx.effectId === 'delay') {
    engine.decks[fx.deck].delaySend.gain.setTargetAtTime(v, t, 0.05);
    if (feedback !== undefined) engine.delayFb.gain.setTargetAtTime(feedback, t, 0.05);
  } else {
    const inp = document.querySelector(`input.knob-state[data-param="filter"][data-deck="${fx.deck}"]`);
    if (inp) { inp.value = v; setParam(inp); syncAllKnobs(); }
  }
  fx.value = v;
}
function fxRender() {
  const p = FX_PARAMS[fx.effectId], deckTxt = 'AB'[fx.deck];
  $('#fxName').textContent = p.label;
  $('#fxDeckA').setAttribute('aria-pressed', fx.deck === 0); $('#fxDeckB').setAttribute('aria-pressed', fx.deck === 1);
  const valTxt = fx.effectId === 'delay' ? `${Math.round(fxCurrentValue() / 0.8 * 100)}%` : `${Math.round(fxCurrentValue())}`;
  $('#fxValue').textContent = `Intensidad actual: ${valTxt}`;
  const man = $('#fxManual'); man.min = p.min; man.max = p.max; man.step = fx.effectId === 'delay' ? 0.01 : 1;
  if (document.activeElement !== man) man.value = fxCurrentValue();
  document.querySelectorAll('[data-fx-card]').forEach(c => c.classList.toggle('active', c.dataset.fxCard === fx.effectId));
  $('#fxPalette').hidden = fx.state !== 'palette';
  const chip = $('#fxChip');
  chip.hidden = !(fx.state === 'prepared' || fx.state === 'frozen' || fx.state === 'adjusting');
  chip.textContent = fx.state === 'adjusting' ? `AJUSTANDO ${p.label.toUpperCase()} · DECK ${deckTxt}: ${valTxt} — suelta para congelar` : `FX PREPARADO: ${p.label.toUpperCase()} · ${deckTxt} — pinza con cada mano para ajustar`;
  const stateTxt = { idle: 'sin preparar', palette: 'paleta abierta (el audio no cambia)', prepared: 'preparado', adjusting: 'ajustando con dos pinzas', frozen: 'congelado (valor conservado)' }[fx.state];
  $('#fxStatus').textContent = `Efecto: ${p.label} · Deck ${deckTxt} · ${stateTxt}. Seleccionar/preparar no cambia el audio.`;
}
function fxCycle(step) { const i = FX_IDS.indexOf(fx.effectId); fx.select(FX_IDS[(i + step + FX_IDS.length) % FX_IDS.length], fx.deck); fxRender(); }
$('#fxEnabled').onchange = e => { $('#fxPanel').hidden = !e.target.checked; if (e.target.checked) fxRender(); else { fx.freeze(); fx.closePalette(); fxRender(); } };
$('#fxPrev').onclick = () => fxCycle(-1);
$('#fxNext').onclick = () => fxCycle(1);
$('#fxDeckA').onclick = () => { fx.select(fx.effectId, 0); fxRender(); };
$('#fxDeckB').onclick = () => { fx.select(fx.effectId, 1); fxRender(); };
$('#fxOpen').onclick = () => { fx.openPalette(); fxRender(); };
$('#fxPaletteClose').onclick = () => { fx.closePalette(); fxRender(); };
document.querySelectorAll('[data-fx-card]').forEach(c => c.onclick = () => { fx.select(c.dataset.fxCard, fx.deck); fxRender(); });
$('#fxPrepare').onclick = () => { fx.prepare(fxCurrentValue()); fxRender(); status(`FX preparado: ${FX_PARAMS[fx.effectId].label} · Deck ${'AB'[fx.deck]}. El audio aún no cambia.`); };
$('#fxUnprepare').onclick = () => { fx.unprepare(); fxRender(); };
$('#fxManual').addEventListener('input', e => {
  if (fx.state === 'idle' || fx.state === 'palette') fx.prepare(fxCurrentValue());
  fxApplyValue(Number(e.target.value)); fxRender();
});
// Compatibilidad: la antigua smartTo queda sustituida por startAutoTransition.
// ---------- Garra de cinco dedos (experimental, desactivada por defecto) ----------
const claw = new ClawController({ engageMs: 500 });
let clawHand = -1;
const CLAW_PARAMS = { filter: { min: -50, max: 50, label: 'Filtro' }, low: { min: -24, max: 24, label: 'Graves LOW' }, delay: { min: 0, max: 0.8, label: 'Delay (envio del deck)' } };
function clawParamInput() { return document.querySelector(`input.knob-state[data-param="${$('#clawParam').value}"][data-deck="${$('#clawDeck').value}"]`); }
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
const hands = [0, 1].map(() => ({ pinch: new PinchDetector(), smoothX: new Smoother(0.45), smoothY: new Smoother(0.45), seen: 0, el: null, needRelease: true, wrist: null, missingSince: null }));
let mirrored = true;
function rebuildRegistry() {
  registry.controls.clear();
  const pad = Number($('#calHit')?.value || 16), sr = stage.getBoundingClientRect();
  // TODOS los controles de la mesa: sliders, botones (PLAY/CUE/SYNC/LOOP/pads/modo) y onda.
  document.querySelectorAll('.console [data-g], .console button, .console .wave, #fxPalette [data-fx-card]').forEach((el, idx) => {
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
  if (el.classList.contains('wave')) return 'ONDA (pinza = salto, mantén y mueve = ajuste fino)';
  if (el.classList.contains('jog')) return 'JOG (pinza y mueve = scratch)';
  return (el.textContent || el.className).trim().slice(0, 22);
}
// Faders con pinza (Etapa 11): arrastre RELATIVO anclado, sin salto al
// pinzar (como la perilla). Excepcion: el crossfader conserva el modo
// absoluto, porque en un corte rapido importa donde esta la mano, no el delta.
const rangeDrags = new Map();
function startRangeDrag(hand, el, x, y) {
  if (el.dataset.param === 'cross') { setRangeFromPoint(el, x, y); return; }
  rangeDrags.set(hand, { el, value: Number(el.value), x, y });
}
function moveRangeDrag(hand, el, x, y) {
  if (el.dataset.param === 'cross') { setRangeFromPoint(el, x, y); return; }
  const a = rangeDrags.get(hand); if (!a || a.el !== el) return;
  const r = el.getBoundingClientRect(), span = Number(el.max) - Number(el.min);
  const delta = el.dataset.orient === 'v' ? (a.y - y) / Math.max(40, r.height) * span : (x - a.x) / Math.max(40, r.width) * span;
  el.value = Math.min(Number(el.max), Math.max(Number(el.min), a.value + delta));
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
function setRangeFromPoint(el, x, y) {
  const r = el.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  const frac = el.dataset.orient === 'v' ? clamp(1 - (y - (r.top - sr.top - stage.clientTop)) / r.height) : clamp((x - (r.left - sr.left - stage.clientLeft)) / r.width);
  el.value = Number(el.min) + frac * (Number(el.max) - Number(el.min));
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
// ---------- Perilla piloto (LOW deck A): arrastre relativo anclado ----------
const knobDrags = new Map(); let knobBarTimer = null;
function knobInput(knob) { return knob?.closest('.knobwrap')?.querySelector('.knob-state') || null; }
function knobPx() { return Number($('#calKnob')?.value || 220); }
function syncKnob(knob) {
  const inp = knobInput(knob); if (!inp) return;
  const v = Number(inp.value), mn = Number(inp.min), mx = Number(inp.max), f = mx > mn ? (v - mn) / (mx - mn) : 0;
  knob.style.setProperty('--ang', knobAngle(v, mn, mx) + 'deg');
  knob.style.setProperty('--frac', f);
  if ([...knobDrags.values()].some(d => d.knob === knob)) showKnobBar(inp, knob, true);
}
function syncAllKnobs() { document.querySelectorAll('.knob').forEach(syncKnob); }
function showKnobBar(inp, knob, keep) {
  const bar = $('#knobBar'); bar.hidden = false;
  const v = Number(inp.value), mn = Number(inp.min), mx = Number(inp.max), f = mx > mn ? (v - mn) / (mx - mn) : 0;
  $('#knobBarLabel').textContent = inp.dataset.param === 'master' ? 'MASTER' : `${(inp.dataset.param || '').toUpperCase()} · DECK ${'AB'[Number(inp.dataset.deck || 0)]}`;
  $('#knobBarVal').textContent = inp.dataset.display === 'pct' ? `${Math.round(v * 100)}%` : (inp.dataset.unit === 'dB' ? `${v > 0 ? '+' : ''}${v} dB` : `${v}`);
  $('#knobBarFill').style.width = `${f * 100}%`;
  $('#knobBarDot').style.left = `${f * 100}%`;
  bar.style.borderColor = Number(inp.dataset.deck) === 1 ? 'var(--b)' : 'var(--a)';
  if (!keep && knobBarTimer) { clearTimeout(knobBarTimer); knobBarTimer = null; }
}
function hideKnobBarSoon() {
  if (knobBarTimer) clearTimeout(knobBarTimer);
  knobBarTimer = setTimeout(() => { if (!knobDrags.size) $('#knobBar').hidden = true; knobBarTimer = null; }, 700);
}
function startKnobDrag(knob, x, hand) {
  const inp = knobInput(knob); if (!inp) return false;
  knobDrags.set(hand, { knob, input: inp, hand, startValue: Number(inp.value), startX: x });
  showKnobBar(inp, knob);
  return true;
}
function moveKnobDrag(hand, x) {
  const drag = knobDrags.get(hand); if (!drag) return;
  const inp = drag.input;
  inp.value = knobDragValue(drag.startValue, x - drag.startX, Number(inp.min), Number(inp.max), knobPx());
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  syncKnob(drag.knob);
}
function endKnobDrag(hand) {
  if (hand !== undefined) knobDrags.delete(hand); else knobDrags.clear();
  if (!knobDrags.size) hideKnobBarSoon();
  else { const last = [...knobDrags.values()].at(-1); if (last) showKnobBar(last.input, last.knob, true); }
}
function endAllKnobs() { endKnobDrag(); }
document.querySelectorAll('.knob').forEach(knob => {
  const inp = knobInput(knob);
  knob.addEventListener('pointerdown', e => { e.preventDefault(); knob.focus(); try { knob.setPointerCapture(e.pointerId); } catch {} startKnobDrag(knob, e.clientX, 'mouse'); });
  knob.addEventListener('pointermove', e => { if (knobDrags.get('mouse')?.knob === knob) moveKnobDrag('mouse', e.clientX); });
  knob.addEventListener('pointerup', () => endKnobDrag('mouse'));
  knob.addEventListener('pointercancel', () => endKnobDrag('mouse'));
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
  const drag = [...knobDrags.values()].at(-1);
  const knob = drag?.knob || document.querySelector('.knob:focus') || document.querySelector('.knob'); const inp = knob && knobInput(knob); if (!inp) return;
  const r = e.currentTarget.getBoundingClientRect(), f = clamp((e.clientX - r.left) / r.width);
  inp.value = Number(inp.min) + f * (Number(inp.max) - Number(inp.min));
  inp.dispatchEvent(new Event('input', { bubbles: true })); syncKnob(knob);
});
// ---------- Arrastre en la onda: salto + ajuste fino anclado ----------
// Decision de audio: seek limitado a ~11/s mientras se arrastra (throttle)
// y seek exacto al soltar; si el deck sonaba sigue sonando, si estaba en
// pausa queda en pausa. Salir del loop activo con el arrastre lo desactiva.
const waveDrags = new Map();
function waveTarget(i, fromPos, dxPx) {
  const d = decks[i];
  return waveDragPosition(fromPos, dxPx, d.track.buffer.duration, knobPx());
}
function applyWaveTarget(i, target) {
  const d = decks[i], ch = engine.decks[i];
  if (d.loop && (target < d.loop.start || target > d.loop.start + d.loop.len)) {
    d.loop = null; ch.clearLoop();
    const b = d.el.querySelector('.loopbtn'); if (b) b.textContent = 'LOOP 4';
    status(`Deck ${d.name}: saliste del loop arrastrando; loop desactivado.`);
  }
  ch.seek(target);
}
function moveWaveDrag(i, clientX, now, force = false) {
  const d = decks[i], drag = d._waveDrag;
  if (!drag) return;
  if (!force && now - drag.last < 90) return;
  drag.last = now;
  applyWaveTarget(i, waveTarget(i, drag.pos, clientX === null ? 0 : clientX - drag.x));
  if (clientX !== null) { drag.pos = engine.decks[i].position(); drag.x = clientX; }
}
function startWaveDrag(hand, el, x) {
  const i = decks.findIndex(d => d.el.contains(el));
  if (i < 0 || !engine || !decks[i].track) return;
  waveDrags.set(hand, { deck: i, pos: engine.decks[i].position(), x, last: 0 });
}
function moveWaveDragGesture(hand, x) {
  const drag = waveDrags.get(hand);
  if (!drag || !engine) return;
  const now = performance.now();
  if (now - drag.last < 90) return;
  drag.last = now;
  applyWaveTarget(drag.deck, waveTarget(drag.deck, drag.pos, x - drag.x));
  drag.pos = engine.decks[drag.deck].position(); drag.x = x;
}
function endWaveDragGesture(hand) {
  const drag = waveDrags.get(hand);
  if (drag && engine && decks[drag.deck].track) applyWaveTarget(drag.deck, waveTarget(drag.deck, drag.pos, 0));
  waveDrags.delete(hand);
}
// ---------- Scratch minimo (velocidad del jog, sin reverse) ----------
// AudioBufferSourceNode no admite rate negativo: girar "hacia atras" lleva
// el rate a ~0 en vez de sonar al reves. El reverse real exige AudioWorklet
// (pendiente, ver docs/estado.md). Al soltar se vuelve al rate del deck con
// la rampa de setRate (~30 ms) y position() sigue continua.
const scratches = new Map();
function startScratch(key, i, y) {
  if (i < 0 || !engine) return;
  ensureEngine(); const ch = engine.decks[i];
  if (!ch.buffer || scratches.has(key)) return;
  const wasPaused = !ch.playing;
  if (wasPaused) ch.play();
  scratches.set(key, { deck: i, baseRate: ch.rate, wasPaused, lastY: y, lastT: performance.now(), rev: 0 });
  status(`Scratch deck ${decks[i].name}: mueve para girar el disco; suelta para volver a la velocidad normal.`);
}
function applyScratchRev(key, rev) {
  const s = scratches.get(key); if (!s || !engine) return;
  s.rev = 0.55 * rev + 0.45 * s.rev;
  engine.decks[s.deck].setRate(scratchRate(s.rev, s.baseRate));
}
function moveScratchGesture(key, y) {
  const s = scratches.get(key); if (!s) return;
  const now = performance.now(), dt = Math.max(1, now - s.lastT) / 1000;
  const rev = -(y - s.lastY) / 140 / dt; // 140 px/s de mano = 1 vuelta/s
  s.lastY = y; s.lastT = now;
  applyScratchRev(key, rev);
}
function endScratch(key) {
  const s = scratches.get(key); if (!s) return;
  scratches.delete(key);
  if (!engine) return;
  const ch = engine.decks[s.deck];
  if (s.wasPaused) ch.pause(); // queda pausado en la posicion alcanzada
  else ch.setRate(s.baseRate);
}
function endAllScratches() { for (const k of [...scratches.keys()]) endScratch(k); }
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
window.addEventListener('resize', () => { hands.forEach(h => { h.smoothX.reset(); h.smoothY.reset(); }); fitConsole(); rebuildRegistry(); });
$('#btnMirror').onclick = () => { mirrored = !mirrored; applyMirror(); hands.forEach(h => { h.smoothX.reset(); h.smoothY.reset(); }); status(mirrored ? 'Modo ESPEJO: te mueves como frente a un espejo.' : 'Modo NORMAL: la imagen no se invierte; el cursor sigue a tu dedo igualmente.'); };
$('#btnGestures').onclick = e => {
  gesturesOn = !gesturesOn; e.target.textContent = gesturesOn ? 'Gestos: ACTIVOS (pausar)' : 'Gestos: PAUSADOS'; e.target.setAttribute('aria-pressed', gesturesOn);
  $('#gesturePaused').style.display = gesturesOn ? 'none' : 'block';
  $('#chipGest').textContent = gesturesOn ? 'Gestos: activos' : 'Gestos: pausados'; $('#chipGest').classList.toggle('on', gesturesOn);
  hands.forEach(h => { h.needRelease = true; h.pinch.reset(); });
  if (!gesturesOn) { registry.releaseAll(); endKnobDrag(); endAllScratches(); two.reset(); freezeExpressive('Gestos pausados.'); if (fx.freeze()) fxRender(); document.querySelectorAll('[data-focus]').forEach(el => el.removeAttribute('data-focus')); $('#focusTag').hidden = true; }
};
$('#btnDiag').onclick = e => { diag = !diag; e.target.setAttribute('aria-pressed', diag); if (!diag) overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height); };
$('#btnGuide').onclick = () => $('#guide').scrollIntoView({ behavior: 'smooth' });
document.addEventListener('keydown', e => {
  if (e.target.matches('input,select,textarea')) return;
  const k = e.key.toLowerCase();
  if (k === 'q') deckAction(0, 'play'); if (k === 'a') deckAction(0, 'cue', decks[0].el.querySelector('.cue'));
  if (k === 'p') deckAction(1, 'play'); if (k === 'l') deckAction(1, 'cue', decks[1].el.querySelector('.cue'));
  if (k === 'g') $('#btnGestures').click();
  if (k === 'e') { if (!$('#fxEnabled').checked) { $('#fxEnabled').checked = true; $('#fxPanel').hidden = false; } fx.openPalette(); fxCycle(0); }
  if (k === 'enter' && fx.state === 'palette') { fx.prepare(fxCurrentValue()); fxRender(); }
  if (k === 'escape') { if (fx.state === 'adjusting') fx.freeze(); else fx.closePalette(); fxRender(); }
  if (k === 'x') { fx.unprepare(); fxRender(); }
  if (k === 'c' && $('#clawEnabled').checked) setClawEnabled(false);
  if (k === 'arrowleft' || k === 'arrowright') { const c = $('#cross'); c.value = clamp(Number(c.value) + (k === 'arrowright' ? 0.08 : -0.08), -1, 1); c.dispatchEvent(new Event('input', { bubbles: true })); }
});
// ---------- Bucle principal ----------
function loop() {
  requestAnimationFrame(loop);
  if (performance.now() - (loop._fitAt || 0) > 1200) { loop._fitAt = performance.now(); fitConsole(); }
  if (engine) {
    decks.forEach((d, i) => {
      const ch = engine.decks[i];
      if (d.track) { d.el.querySelector('.pos').textContent = fmt(ch.position()); d.el.querySelector('.rem').textContent = '-' + fmt(d.track.buffer.duration - ch.position()); drawWave(d); drawZoomWave(d); }
      const m = document.querySelector(`.chmeter[data-meter="${i}"]`); if (m) m.style.height = `${Math.min(100, ch.level() * 100)}%`;
    });
    const ml = engine.masterLevel(), mm = $('#masterMeter'); if (mm) mm.style.width = `${Math.min(100, ml * 100)}%`;
    // Saturacion con hold de 500 ms y espacio reservado: no parpadea ni
    // mueve la barra. Rojo si el limitador esta actuando fuerte.
    const cw = $('#clipWarn'), nowMs = performance.now();
    const cs = clipState(loop._clipUntil || 0, ml, nowMs);
    loop._clipUntil = cs.until;
    const limiting = engine.limiter.reduction < -3;
    if (limiting) loop._clipUntil = nowMs + 500;
    cw.style.visibility = (cs.on || limiting) ? 'visible' : 'hidden';
    cw.textContent = limiting ? 'LIMITADOR' : 'SATURACIÓN';
    cw.classList.toggle('limiting', !!limiting);
    refreshTransport(); syncAllKnobs(); drawSpectrum(); if (performance.now() - autoDjLastCheck > 250) { autoDjLastCheck = performance.now(); checkAutoDj(autoDjLastCheck); if (!$('#fxPanel').hidden) fxRender(); }
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
  // Identidad estable: asigna detecciones a huecos por cercania de muneca,
  // para que al cruzarse las manos un hueco no herede la mano de la otra.
  const slotOf = assignHandSlots(hands.map(h => ({ wrist: h.wrist })), lms.map(lm => ({ wrist: lm?.[0] })));
  const pts = hands.map((h, hi) => {
    const lm = slotOf[hi] >= 0 ? lms[slotOf[hi]] : null, cursor = $(`#handCursor${hi}`);
    if (!lm) { if (h.missingSince === null) h.missingSince = now; if (now - h.missingSince > 800) h.wrist = null; if (h.seen && now - h.seen > 250) { registry.release(hi); h.pinch.reset(); h.needRelease = true; endKnobDrag(hi); endWaveDragGesture(hi); } cursor.style.display = 'none'; return null; }
    h.wrist = lm[0]; h.missingSince = null;
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
    if (bothPinched) { registry.releaseAll(); endKnobDrag(); endAllScratches(); twoBusy = true; }
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
  // --- FX a dos pinzas: solo con efecto preparado, en el aire (sin control
  // bajo ninguna mano) y sin agarres/transicion/Auto DJ. La mesa manda. ---
  let fxBusy = false;
  if (fx.state === 'prepared' || fx.state === 'frozen' || fx.state === 'adjusting') {
    const bothPresent = !!(pts[0] && pts[1]), bothPinched = bothPresent && pts.every(p => p.det.pinched);
    if (fx.state === 'adjusting' && !bothPresent) {
      if (fx.notePresence({ bothPresent: false, bothPinched: false }, now) === 'frozen') fxRender();
      fxBusy = fx.state === 'adjusting';
    } else if (bothPresent) {
      const noHit = pts.every(p => !registry.hit(p.x, p.y));
      const can = fxCanAdjust({ anyGrabbed: !!registry.grabbedBy(0) || !!registry.grabbedBy(1), twoHandBusy: twoBusy || expressiveActive, autoTransition: !!smartTimer }) && noHit;
      if (loop._fxNeedRelease) { if (!bothPinched) loop._fxNeedRelease = false; }
      else if (fx.state !== 'adjusting' && bothPinched && can) {
        const left = pts[0].x <= pts[1].x ? pts[0] : pts[1];
        fx.beginAdjust({ value: fxCurrentValue(), y: left.y, dist01: handsDistance(pts[0], pts[1], stage.clientWidth), feedback: engine ? engine.delayFb.gain.value : 0.32 });
        fxBusy = true; fxRender();
      } else if (fx.state === 'adjusting') {
        fxBusy = true;
        if (fx.notePresence({ bothPresent: true, bothPinched }, now) === 'frozen') fxRender();
        else if (bothPinched) {
          const left = pts[0].x <= pts[1].x ? pts[0] : pts[1];
          const r = fx.adjust({ y: left.y, dist01: handsDistance(pts[0], pts[1], stage.clientWidth) });
          if (r) { fxApplyValue(r.value, r.feedback); fxRender(); }
        }
      }
    }
  }
  // Con la paleta abierta, mantener la pinza doble prepara el efecto elegido
  // (todavia sin tocar el audio). Elegir tarjeta: pinza sobre ella o teclado.
  if (loop._fxNeedRelease && !(pts[0]?.det.pinched && pts[1]?.det.pinched)) loop._fxNeedRelease = false;
  if (fx.state === 'palette' && !loop._fxNeedRelease && pts[0] && pts[1] && pts.every(p => p.det.pinched) && !registry.grabbedBy(0) && !registry.grabbedBy(1)) {
    loop._fxPalHold = loop._fxPalHold || now;
    if (now - loop._fxPalHold >= 700) { fx.prepare(fxCurrentValue()); fxRender(); loop._fxPalHold = null; loop._fxNeedRelease = true; status('FX preparado con pinza doble. Suelta y vuelve a pinzar con cada mano para ajustar.'); }
  } else loop._fxPalHold = null;
  // Abrir la paleta con pinza doble mantenida (llave de reserva) solo si la
  // transicion a dos manos esta desactivada: nunca roba su gesto.
  if (fx.state === 'idle' && $('#fxEnabled').checked && !twoOn && pts[0] && pts[1] && pts.every(p => p.det.pinched) && !registry.grabbedBy(0) && !registry.grabbedBy(1) && pts.every(p => !registry.hit(p.x, p.y))) {
    loop._fxHold = loop._fxHold || now;
    if (now - loop._fxHold >= 700) { fx.openPalette(); fxRender(); loop._fxHold = null; loop._fxNeedRelease = true; }
  } else loop._fxHold = null;
  // --- Garra: una mano sin pinza; cede ante pinza, dos manos y transicion ---
  clawHand = -1;
  const gate = clawGate({ enabled: $('#clawEnabled').checked, handCount: pts.filter(Boolean).length, anyPinched: pts.some(p => p?.det.pinched), anyGrabbed: !!registry.grabbedBy(0) || !!registry.grabbedBy(1), twoHandBusy: twoBusy || fxBusy, expressiveActive, autoTransition: !!smartTimer });
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
    if (twoBusy || fxBusy || expressiveActive || hi === clawHand) return;
    const grabbedId = registry.grabbedBy(hi);
    if (grabbedId) { const c = registry.controls.get(grabbedId); if (c?.el?.dataset.g === 'range') moveRangeDrag(hi, c.el, p.x, p.y); if (c?.el?.dataset.g === 'knob') moveKnobDrag(hi, p.x); if (c?.el?.classList.contains('wave')) moveWaveDragGesture(hi, p.x); if (c?.el?.dataset.g === 'jog') moveScratchGesture(hi, p.y); if (c) c.el.setAttribute('data-grabbed', '1'); }
    if (p.det.started && !h.needRelease && hit) {
      if (hit.el.dataset.g === 'range') { if (registry.grab(hi, hit.id)) startRangeDrag(hi, hit.el, p.x, p.y); } else if (hit.el.dataset.g === 'knob') { if (registry.grab(hi, hit.id)) startKnobDrag(hit.el, p.x, hi); } else if (hit.el.dataset.g === 'jog') { if (registry.grab(hi, hit.id)) startScratch(hi, decks.findIndex(d => d.el.contains(hit.el)), p.y); } else { triggerEl(hit.el, p.x); if (hit.el.classList.contains('wave')) startWaveDrag(hi, hit.el, p.x); }
    }
    if (p.det.ended) { registry.release(hi); h.needRelease = false; rangeDrags.delete(hi); endKnobDrag(hi); endWaveDragGesture(hi); endScratch(hi); }
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
