import { AudioEngine, clipState, filterFreqs } from '../audio/engine.js';
import { computePeaks } from '../audio/bpm.js';
import { analyzeBeatgrid, quantizeToBeat, beatPhase01, alignToPhase, beatDelayTime, syncTempoPct, ecoDelayFor } from '../audio/beatgrid.js';
import { createHandTracker, startCamera } from '../camera/tracker.js';
import { PinchDetector, Smoother, ControlRegistry, pinchRatio, clamp, expandRect, mapVideoPointInBox, parseObjectPosition, visibleVideoWindow, fitFromObjectFit, knobDragValue, knobAngle, knobPos01, waveDragPosition, scratchRate, jogAngleDelta, handsDistance, TwoHandSession, assignHandSlots, zoomWindow, tempoDetent, RESET_DEFAULTS, sanitizeCal, bassClash } from '../gestures/logic.js';
import { aperture01, ClawController, clawGate } from '../gestures/claw.js';
import { transitionValues, expressiveValues, smooth } from '../audio/transition.js';
import { evaluateAutoDj, autoDjTriggerKey } from '../audio/autodj.js';
import { emptyQueues, addToDeck, removeAt, moveAt, takeFromDeck, dropTrack, queueTag, deckFree, sortTracks } from '../audio/deck-queues.js';
import { chooseTargetDeck, pickerIdleState, pickerPointingText, pickerCountdownText } from '../audio/queue.js';
import { FxSession, FX_PARAMS, fxCanAdjust } from '../audio/fx-twohand.js';
import { fmtDb, fmtTrimDb, fmtPct, fmtTempo, fmtFilter, fmtEs, displayTrackName } from '../audio/format.js';
import { aperturaToFilter, aperturaFromDistance, beatPhaseAt, onBeat, handModeShouldExit, pinchPoint, anchoredFilter, neutralRampValue, DoublePinchGate, bezierPoint, filterColor } from '../audio/handfx.js';
import { OneEuroFilter, magnetPoint, StickyFocus, ValueHistory } from '../gestures/precision.js';
import { stemsServerUp, separateStems, loadStemBuffers, buildStemBuffer, STEM_KEYS, STEM_LABELS, STEM_COLORS } from '../audio/stems-client.js';
import { buildLevel, buildStage, rollBeatsLabel, OpenHandsGate, HandsTogetherGate, nextBarCut } from '../audio/buildup.js';
import { handExtension01, FistGate, thumbUp01, ThumbGate, anchoredDose, nextBeatCut, targetStartPosition, launchPlan, crossTargetFor, throwDirSign } from '../audio/eco-hand.js';
import { FingerCounter, PalmGate, rollSizeBeats, rollSizeLabel, brakeDurationBeats, brakeRate, brakePlan, palmHeight01, slipPosition } from '../audio/roll-brake.js';

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
  <div class="deck-head"><span class="badge">${d.name}</span><h3><span class="tname">Sin pista</span></h3><span class="time pos">0:00</span><span class="time bpm">BPM —</span><span class="time rem">-0:00</span></div>
  <button type="button" class="btn small nextup" hidden title="Cargar ya el siguiente tema de la cola de este deck"></button>
  <canvas class="wave" width="480" height="88"></canvas>
  <div class="zoomwrap"><canvas class="zoomwave" width="480" height="54" title="Onda ampliada: mira si las líneas gruesas caen sobre los bombos"></canvas><span class="zoomtag">rejilla estimada</span><select class="zoomwin" title="Segundos visibles en la onda ampliada"><option value="4">4 s</option><option value="8" selected>8 s</option><option value="16">16 s</option></select></div>
  <span class="gridstate" hidden>Sin rejilla</span>
  <div class="deck-main">
    <div class="transport-col">
      <button class="btn syncbtn" data-act="sync" title="Iguala el tempo con el otro deck y alinea golpes si la rejilla es fiable">SYNC</button>
      <button class="btn round cue" data-act="cue" title="Marca o vuelve al punto CUE">CUE</button>
      <button class="btn round play" data-act="play" title="Reproducir / pausar" aria-label="Reproducir o pausar, Deck ${d.name}"><span class="play-ico">▶</span></button>
      <span class="round-label">PLAY / PAUSA</span>
    </div>
    <div class="jogcol">
      <div class="jogwrap"><div class="jog" data-g="jog" title="Centro: buscar con sonido · borde: empujar el tempo"><i></i></div><span class="jog-letter">${d.name}</span></div>
      <span class="jog-hint">centro: buscar con sonido · borde: empujar</span>
    </div>
    <div class="tempo-col dj-only"><span class="tempo-label">TEMPO</span><input class="tempo" type="range" min="-8" max="8" step="0.1" value="0" data-g="range" data-orient="v" data-deck="${i}" data-param="tempo" title="Velocidad de la pista. Centro = 0 % (retén)"><span class="tempoval">+0,0 %</span><span class="tempo-range">±8 %</span></div>
  </div>
  <div class="row">
    <button class="btn small loopbtn dj-only" data-act="loop" title="Repite 4 tiempos desde el golpe más cercano">LOOP 4</button>
    <button class="btn small ecohold" title="Mantén pulsado: eco mientras lo sostienes; al soltar se apaga solo">ECO · MANTÉN</button></div>
  <div class="pads">${Array.from({ length: 8 }, (_, p) => `<button class="pad fn-${['cue', 'cue', 'salto', 'salto', 'fx', 'fx', 'sonido', 'sonido'][p]}" data-pad="${p}" title="${PAD_TITLES[p]}">${PAD_LABELS[p]}</button>`).join('')}</div>
  <canvas class="deckspec" width="480" height="44" title="Espectro de este deck"></canvas>
  <div class="deck-foot">
    <button class="btn pill pistasbtn" title="Elige la siguiente pista a pantalla completa"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h12M4 10h12M4 14h7"/><circle cx="17.5" cy="16.5" r="2.2"/><path d="M19.7 16.5V7l3-1v8.5"/></svg> PISTAS</button>
    <button class="btn pill cuephones" title="Preescucha en auriculares (experimental)"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 13a8 8 0 0 1 16 0"/><rect x="3" y="13" width="4" height="7" rx="1.6"/><rect x="17" y="13" width="4" height="7" rx="1.6"/></svg> PREESCUCHA</button>
    <span class="grow"></span>
    <span class="manos-wrap"><button class="btn manosfx" data-manos="${i}" title="Modo manos: efecto de filtro con las dos manos" aria-label="Modo manos, Deck ${d.name}"><svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 11.5V6a1.5 1.5 0 0 1 3 0V4.8a1.5 1.5 0 0 1 3 0V6a1.5 1.5 0 0 1 3 0v1.2a1.5 1.5 0 0 1 3 0V13a7 7 0 0 1-7 7h-.6c-2.3 0-4-.9-5.3-2.7L3.6 14a1.6 1.6 0 0 1 2.6-1.7L7 13.5z"/></svg></button><span class="manos-label">MANOS · FX</span></span>
  </div>`;
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
  <div class="knobwrap"><button type="button" class="knob" data-g="knob" data-param="master" aria-label="Volumen master"><span class="knob-dial"><i></i></span></button><label>MASTER</label><span class="knobval"></span><input class="knob-state" type="range" min="0" max="1" step="0.01" value="0.85" data-g="range" data-param="master" data-display="pct" hidden></div>
  <div>VOL B<br><input class="vfader" type="range" min="0" max="1" step="0.01" value="0.85" data-g="range" data-orient="v" data-deck="1" data-param="vol" title="Volumen del canal B"></div></div>
  <div class="crossbox"><label style="display:block;text-align:center;font-size:11px">CROSSFADER</label>
  <input id="cross" type="range" min="-1" max="1" step="0.01" value="0" data-g="range" data-param="cross" title="Mezcla entre el deck A y el B">
  <div class="row"><strong style="color:var(--a)">A</strong><span class="grow"></span><strong style="color:var(--b)">B</strong></div></div>
  <div class="autodj-row"><label class="btn small autodj-toggle" title="Mezcla sola cerca del final de cada pista (ajustes en ⚙ Ajustes › Auto DJ)"><input type="checkbox" id="autoDjEnabled"> AUTO DJ</label><button class="btn small" id="btnAutoDjNow" disabled title="Con AUTO DJ encendido: mezcla ya al otro deck">MEZCLAR ▶</button><button class="btn small easy-only" id="btnEasyMix" title="Iguala el tempo del deck parado con el que suena y hace la mezcla suave">IGUALAR Y MEZCLAR</button></div>
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
  // La franja master se retiro (P2): el espectro vive ahora en cada deck.
  const wrap = $('#spectrumWrap');
  if (wrap) wrap.style.display = 'none';
  return;
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
  return `<div class="knobwrap ${cls}"><button type="button" class="knob${p === 'filter' ? ' knob-filter' : ''}" style="--kc:var(--${i === 1 ? 'b' : 'a'})" data-g="knob" data-deck="${i}" data-param="${p}" aria-label="${label}, Deck ${'AB'[i]}" title="${titles[p] || label}"><span class="knob-dial"><i></i></span></button><label>${label}</label><span class="knobval"></span><input class="knob-state" type="range" min="${mn}" max="${mx}" step="${step}" value="${v}" data-g="range" data-deck="${i}" data-param="${p}" data-unit="${unit}" data-display="${disp}" hidden></div>`;
}
function ensureEngine() {
  if (!(window.AudioContext || window.webkitAudioContext)) { status('Este navegador no soporta Web Audio: prueba Chrome o Edge actualizados. Mouse y cámara pueden verse, pero no habrá sonido.'); return null; }
  if (!engine) { engine = new AudioEngine(); status('Audio activado. Carga demos o importa música.'); engine.ensureScrub(scrubWorkletUrl); engine.decks.forEach((ch, i) => { ch.onEnded = () => { if (decks[i].track) decks[i].track._ended = true; }; }); }
  if (engine.ctx.state === 'suspended') { engine.ctx.resume(); status('Audio en pausa por el navegador: pulsa «Activar audio» o cualquier botón de la mesa para despertarlo.'); }
  return engine;
}
window.addEventListener('error', e => { const s = $('#status'); if (s) s.textContent = `Algo falló (${(e.message || 'error').slice(0, 90)}). La música y los controles siguen: si se repite, anota qué estabas haciendo.`; });
$('#gAudio').onclick = ensureEngine;
function drawWave(d) {
  const cv = d.el.querySelector('.wave');
  if (document.body.dataset.holo === '1' && d.peaks && d.track) { drawHoloOverview(d, cv); return; }
  if (cv.width !== 480) { cv.width = 480; cv.height = 88; }
  const ctx = cv.getContext('2d');
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
  if (document.body.dataset.holo === '1') { drawHoloWave(d, cv); return; }
  if (cv.width !== 480) { cv.width = 480; cv.height = 54; }
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
// Onda de la mesa 3D, al estilo del software de DJ: el cabezal queda fijo en
// el centro y la onda pasa por debajo; espejada desde la linea media, con un
// nucleo claro. Usa energia (RMS) en bloques cortos, normalizada al p98 de la
// pista y con curva de contraste, para que se vean los bombos y los cortes
// aunque el tema este masterizado muy fuerte. Se calcula una vez por pista.
const HOLO_RATE = 150; // bloques por segundo
function holoEnergy(d) {
  if (d._holoE && d._holoE.track === d.track) return d._holoE;
  const buf = d.track.buffer, c0 = buf.getChannelData(0), c1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : c0;
  const n = Math.max(1, Math.floor(buf.duration * HOLO_RATE)), block = Math.max(1, Math.floor(c0.length / n));
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, k = 0; const off = i * block;
    for (let j = 0; j < block; j += 4) { const v = (c0[off + j] + c1[off + j]) * 0.5 || 0; s += v * v; k++; }
    e[i] = Math.sqrt(s / Math.max(1, k));
  }
  const sorted = Float32Array.from(e).sort(), ref = sorted[Math.floor(sorted.length * 0.98)] || 1;
  for (let i = 0; i < n; i++) e[i] = Math.pow(Math.min(1, e[i] / ref), 1.6);
  d._holoE = { track: d.track, e };
  return d._holoE;
}
function drawHoloWave(d, cv) {
  if (cv.width !== 960 || cv.height !== 72) { cv.width = 960; cv.height = 72; }
  const ctx = cv.getContext('2d'), W = cv.width, H = cv.height, mid = H / 2;
  const pos = engine.decks[decks.indexOf(d)].position(), dur = d.track.buffer.duration;
  const winSec = 8, start = pos - winSec / 2, pxPerSec = W / winSec;
  const { e } = holoEnergy(d), n = e.length;
  const col = d.name === 'A' ? [34, 211, 238] : [255, 79, 163];
  ctx.clearRect(0, 0, W, H);
  if (d.loop) { ctx.fillStyle = 'rgba(74,222,128,.16)'; ctx.fillRect((d.loop.start - start) * pxPerSec, 0, d.loop.len * pxPerSec, H); }
  // Rejilla suave detras de la onda (compases mas marcados).
  if (d.grid?.bpm && d.grid.firstBeat != null) {
    const beat = 60 / d.grid.bpm, k0 = Math.ceil((start - d.grid.firstBeat) / beat);
    for (let k = k0; ; k++) {
      const tt = d.grid.firstBeat + k * beat; if (tt > start + winSec) break;
      const strong = ((k % 4) + 4) % 4 === 0;
      ctx.fillStyle = strong ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.08)';
      ctx.fillRect(Math.round((tt - start) * pxPerSec), 0, strong ? 2 : 1, H);
    }
  }
  const half = mid - 4, cx = W / 2;
  for (let x = 0; x < W; x += 2) {
    const t = start + x / pxPerSec; if (t < 0 || t >= dur) continue;
    const i = Math.min(n - 1, Math.floor(t * HOLO_RATE));
    const v = Math.max(e[i], e[Math.min(n - 1, i + 1)]), h = Math.max(1, v * half);
    const played = x < cx;
    ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${played ? 0.5 : 0.95})`;
    ctx.fillRect(x, mid - h, 2, h * 2);
    if (v > 0.12) { ctx.fillStyle = played ? 'rgba(255,255,255,.35)' : 'rgba(255,255,255,.85)'; const c = h * 0.42; ctx.fillRect(x, mid - c, 2, c * 2); }
  }
  (d.hotcues || []).forEach(h => { if (h !== null && h >= start && h <= start + winSec) { ctx.fillStyle = '#facc15'; ctx.fillRect((h - start) * pxPerSec - 1, 0, 3, 16); } });
  // Cabezal fijo en el centro.
  ctx.fillStyle = '#fff'; ctx.fillRect(cx - 1, 0, 3, H);
  ctx.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`; ctx.beginPath(); ctx.moveTo(cx - 8, 0); ctx.lineTo(cx + 9, 0); ctx.lineTo(cx + 0.5, 10); ctx.fill();
}
// Vista general de la mesa 3D: la cancion entera, en grande. Sin rejilla
// (cientos de lineas blancas tapaban la forma); energia media por columna con
// contraste propio, para que los drops y los breaks se distingan.
function drawHoloOverview(d, cv) {
  if (cv.width !== 960 || cv.height !== 192) { cv.width = 960; cv.height = 192; }
  const ctx = cv.getContext('2d'), W = cv.width, H = cv.height, mid = H / 2;
  if (!d._holoOv || d._holoOv.track !== d.track) {
    const { e } = holoEnergy(d), n = e.length, cols = W / 2, v = new Float32Array(cols);
    for (let c = 0; c < cols; c++) {
      const a = Math.floor(c / cols * n), b = Math.max(a + 1, Math.floor((c + 1) / cols * n));
      let s = 0; for (let i = a; i < b && i < n; i++) s += e[i]; v[c] = s / Math.max(1, b - a);
    }
    const sorted = Float32Array.from(v).sort(), lo = sorted[Math.floor(cols * 0.05)], hi = sorted[Math.floor(cols * 0.98)] || 1;
    for (let c = 0; c < cols; c++) v[c] = Math.pow(Math.min(1, Math.max(0, (v[c] - lo * 0.6) / Math.max(1e-6, hi - lo * 0.6))), 1.4);
    d._holoOv = { track: d.track, v };
  }
  const { v } = d._holoOv, col = d.name === 'A' ? '34,211,238' : '255,79,163';
  const pos = engine ? engine.decks[decks.indexOf(d)].position() / d.track.buffer.duration : 0, px = pos * W;
  ctx.clearRect(0, 0, W, H);
  for (let c = 0; c < v.length; c++) {
    const x = c * 2, h = Math.max(1, v[c] * (mid - 1));
    ctx.fillStyle = `rgba(${col},${x < px ? 0.35 : 0.95})`;
    ctx.fillRect(x, mid - h, 2, h * 2);
  }
  (d.hotcues || []).forEach(h => { if (h !== null) { ctx.fillStyle = '#facc15'; ctx.fillRect(h / d.track.buffer.duration * W - 1, 0, 3, H); } });
  ctx.fillStyle = '#fff'; ctx.fillRect(px - 1, 0, 3, H);
}
// Espectro por deck (P2): usa el AnalyserNode del canal, color del deck,
// buffer reutilizado. Sustituye a la franja de espectro del master.
const deckSpecBufs = [null, null];
function drawDeckSpectrum(d, i) {
  const cv = d.el.querySelector('.deckspec'); if (!cv || !engine || !spectrumOn) { if (cv) cv.style.display = spectrumOn ? '' : 'none'; return; }
  cv.style.display = '';
  const an = engine.decks[i].analyser;
  if (!deckSpecBufs[i] || deckSpecBufs[i].length !== an.frequencyBinCount) deckSpecBufs[i] = new Uint8Array(an.frequencyBinCount);
  const buf = deckSpecBufs[i];
  an.getByteFrequencyData(buf);
  const ctx = cv.getContext('2d'), W = cv.width, H = cv.height, bars = 40;
  ctx.clearRect(0, 0, W, H); ctx.fillStyle = 'rgba(4,12,18,.9)'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = i === 0 ? '#22d3ee' : '#f472b6';
  const nyq = engine.ctx.sampleRate / 2;
  for (let b = 0; b < bars; b++) {
    const f0 = 40 * Math.pow(nyq / 40, b / bars), f1 = 40 * Math.pow(nyq / 40, (b + 1) / bars);
    const i0 = Math.max(1, Math.floor(f0 / nyq * buf.length)), i1 = Math.max(i0 + 1, Math.floor(f1 / nyq * buf.length));
    let mx = 0; for (let k = i0; k < i1 && k < buf.length; k++) if (buf[k] > mx) mx = buf[k];
    const v = Math.min(1, (mx / 255) * (0.55 + 0.75 * (b / bars))), w = W / bars;
    ctx.globalAlpha = 0.9; ctx.fillRect(b * w + 1, H - v * H, w - 2, v * H);
  }
  ctx.globalAlpha = 1;
}
// ---------- Preescucha en auriculares (P3.c, experimental) ----------
// Diagnostico (verificado en codigo): la version anterior llamaba a
// enumerateDevices() SIN ningun permiso previo. Chrome, sin un permiso de
// captura o sin selectAudioOutput, oculta nombres e ids: por eso solo se
// veia una "Salida 1" sin nombre aunque Windows tenga 4 salidas. Ahora:
// 1) selectAudioOutput si existe (el usuario elige y concede el permiso),
// 2) si no, permiso breve de microfono para desbloquear la lista con nombres.
import { normalizeOutputs, resolveSavedCue, cueBlockReason, cueStateText } from '../audio/cue-output.js';
let cueStreamReady = false, cueDevices = [], cueChoice = null;
try { cueChoice = JSON.parse(localStorage.getItem('motiondj-cue-device') || 'null'); } catch { cueChoice = null; }
function cueSave() { try { cueChoice ? localStorage.setItem('motiondj-cue-device', JSON.stringify(cueChoice)) : localStorage.removeItem('motiondj-cue-device'); } catch {} }
function cueLatencyText() {
  if (!engine) return '';
  const lat = (engine.ctx.outputLatency || 0) + (engine.ctx.baseLatency || 0);
  return ` Latencia del contexto: ${Math.round(lat * 1000)} ms (la ruta MediaStream+<audio> suma su propio buffer; la diferencia óptica/jack no se puede medir desde el navegador).`;
}
async function cueApplySink() {
  if (!cueChoice?.deviceId) return false;
  try { await $('#cueAudio').setSinkId(cueChoice.deviceId); return true; }
  catch { $('#cueStatus').textContent = `«${cueChoice.label || 'La salida guardada'}» no aceptó la preescucha (¿desconectada o desactivada en Windows?). Conecta los auriculares y pulsa «Elegir auriculares…» otra vez.`; return false; }
}
async function cueSetup() {
  ensureEngine(); if (!engine || cueStreamReady) return;
  const au = $('#cueAudio');
  au.srcObject = engine.cueDest.stream;
  au.volume = Number($('#cueVol').value);
  cueStreamReady = true;
  if (cueChoice?.deviceId) {
    const ok = await cueApplySink();
    $('#cueStatus').textContent = ok
      ? `Auriculares guardados: «${cueChoice.label || 'sin nombre'}». Pulsa PREESCUCHA en el deck que no suena.${cueLatencyText()}`
      : $('#cueStatus').textContent;
  } else {
    $('#cueStatus').textContent = `Elige primero tus auriculares con «Elegir auriculares…»: la mezcla sigue en tus parlantes y la preescucha saldrá por el jack.${cueLatencyText()}`;
  }
}
function cueFillSelect() {
  const sel = $('#cueDevice'); if (!sel) return;
  const savedOpt = cueChoice?.deviceId && !cueDevices.some(d => d.deviceId === cueChoice.deviceId)
    ? `<option value="${cueChoice.deviceId}">Guardado: ${cueChoice.label || 'sin nombre'} (sin verificar)</option>` : '';
  sel.innerHTML = '<option value="">Elegir en la lista…</option>' + savedOpt + cueDevices.map(d => `<option value="${d.deviceId}">${d.displayName}${d.isAlias ? ' (= salida de la mezcla del sistema)' : ''}</option>`).join('');
  if (cueChoice?.deviceId) sel.value = cueChoice.deviceId;
}
async function cueEnumerateWithPermission() {
  // Desbloquea nombres/ids: permiso breve de microfono (se cierra al instante).
  try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach(t => t.stop()); }
  catch { /* sin microfono: se intenta enumerar igual, puede salir sin nombres */ }
  cueDevices = normalizeOutputs(await navigator.mediaDevices.enumerateDevices());
  return cueDevices;
}
$('#cueVol')?.addEventListener('input', e => { $('#cueAudio').volume = Number(e.target.value); });
$('#btnCueDevices')?.addEventListener('click', async () => {
  await cueSetup();
  if (!('setSinkId' in HTMLAudioElement.prototype)) { $('#cueStatus').textContent = 'Este navegador no permite mandar un elemento de audio a otra salida (sin setSinkId): la preescucha separada no es viable aquí. Usa Chrome de escritorio.'; return; }
  // 1) Eleccion explicita del navegador (Chrome): elige y concede permiso.
  if (typeof navigator.mediaDevices.selectAudioOutput === 'function') {
    try {
      const dev = await navigator.mediaDevices.selectAudioOutput();
      if (dev?.deviceId) {
        cueChoice = { deviceId: dev.deviceId, label: dev.label || '' };
        cueSave();
        await cueEnumerateWithPermission().catch(() => { cueDevices = []; });
        cueFillSelect();
        const block = cueBlockReason(cueChoice, cueDevices);
        if (block === 'coincide-mezcla') { $('#cueStatus').textContent = 'Has elegido la misma salida que usa la mezcla (la predeterminada del sistema): oirías todo junto. Pon en Windows la óptica como predeterminada y elige aquí el jack de auriculares.'; return; }
        if (await cueApplySink()) $('#cueStatus').textContent = `${cueStateText({})}. Auriculares: «${cueChoice.label || 'sin nombre'}». Pulsa PREESCUCHA en el deck que no suena.${cueLatencyText()}`;
        return;
      }
    } catch { /* cancelado o no permitido: se sigue con la lista */ }
  }
  // 2) Respaldo: enumerar con nombres tras el permiso breve.
  try {
    await cueEnumerateWithPermission();
    cueFillSelect();
    const named = cueDevices.filter(d => d.label).length;
    const saved = resolveSavedCue(cueDevices, cueChoice);
    if (saved.status === 'missing') $('#cueStatus').textContent = 'Los auriculares guardados ya no aparecen (¿desconectados o desactivados en Windows > Sonido?). Conéctalos y repite la búsqueda.';
    else if (cueDevices.length <= 1) $('#cueStatus').textContent = 'Chrome sigue viendo una sola salida. Revisa en Windows > Sonido que la salida del jack esté habilitada (no solo conectada) y repite; si acabas de conectarla, recarga la página.';
    else $('#cueStatus').textContent = `${cueDevices.length} salidas (${named} con nombre). Elige tus auriculares en la lista: en tu equipo, «Altavoces (Realtek…)» es el jack y «Realtek Digital Output» la óptica de los parlantes — la mezcla debe quedarse en la óptica.`;
  } catch { $('#cueStatus').textContent = 'No se pudieron listar las salidas. Concede el permiso de micrófono cuando Chrome lo pida (solo se usa para ver los nombres) y reintenta.'; }
});
$('#cueDevice')?.addEventListener('change', async e => {
  await cueSetup();
  const dev = cueDevices.find(d => d.deviceId === e.target.value);
  if (!dev) { cueChoice = null; cueSave(); return; }
  cueChoice = { deviceId: dev.deviceId, label: dev.label };
  cueSave();
  const block = cueBlockReason(cueChoice, cueDevices);
  if (block === 'coincide-mezcla') { $('#cueStatus').textContent = 'Esa es la salida de la mezcla del sistema: la preescucha iría al mismo sitio y se oiría todo junto (eco). Elige la otra salida (el jack de auriculares) o cambia en Windows cuál es la predeterminada.'; return; }
  if (await cueApplySink()) $('#cueStatus').textContent = `Auriculares: «${dev.displayName}». Pulsa PREESCUCHA en el deck que no suena.${cueLatencyText()}`;
});
let cueActiveDeck = -1; // estado propio: no depender de gain.value (con el contexto suspendido no se actualiza)
function toggleCue(i, btn) {
  cueSetup(); if (!engine) return;
  const ch = engine.decks[i], on = cueActiveDeck !== i;
  if (on) {
    const block = cueBlockReason(cueChoice, cueDevices);
    if (block === 'sin-elegir') { $('#cueStatus').textContent = 'Antes elige tus auriculares con «Elegir auriculares…». Sin una segunda salida elegida, la preescucha se mezclaría con la música.'; return; }
    if (block === 'coincide-mezcla') { $('#cueStatus').textContent = 'La salida elegida coincide con la de la mezcla: bloqueado para que no se oiga todo junto. Elige el jack de auriculares.'; return; }
  }
  engine.decks.forEach(d => d.cueSend.gain.setTargetAtTime(0, engine.ctx.currentTime, 0.03));
  decks.forEach(d => d.el.querySelector('.cuephones')?.classList.remove('play-on'));
  cueActiveDeck = on ? i : -1;
  if (on) { ch.cueSend.gain.setTargetAtTime(1, engine.ctx.currentTime, 0.03); btn.classList.add('play-on'); }
  $('#cueStatus').textContent = on
    ? `${cueStateText({ activeDeck: i, deviceName: cueChoice?.label })} (experimental). Se oye aunque su fader esté cerrado; la grabación no la incluye.`
    : cueStateText({});
}
// ---------- Modo manos: barrido de filtro a dos manos (Fase 2) ----------
// Orden de control unico: mientras esta activo, la mesa no recibe pinzas
// (ni FX a dos pinzas, ni transicion, ni garra). Al salir por cualquier via
// el filtro del deck vuelve a Neutro (higiene de fin de sesion).
const handMode = { active: false, deck: -1, effect: 'idle', apertura: 1, smooth: 1, filter: 0, lostSince: null, seenHands: false, beatEnv: 0, lastBeatIdx: -1, mouseControl: false, spark: 0, gate: new DoublePinchGate({ holdMs: 150 }), anchor: null, ramp: null, exitCount: 0, arcCostMs: null, testUntil: 0, introUntil: 0, _barPrev: [false, false] };
// ECO a una mano (4B): puno para agarrar, altura para dosificar, abrir
// de golpe hacia el otro deck para lanzar en el siguiente golpe.
const eco = { gate: new FistGate({ holdMs: 300 }), thumb: new ThumbGate({ holdMs: 250 }), grabbing: false, dose: 0, anchor: null, trail: [], plan: null, pending: null, flying: null, prevSend: null, prevFeedback: null, mouseGrab: false, lastHandAt: 0, throwWindow: null, notice: null };
// ROLL (dedos) y FRENO (palma quieta), Encargo 4C. Detectores por hueco
// de mano; suppressPalmUntil bloquea el FRENO tras lanzar el ECO.
const roll = { counters: [new FingerCounter({ stableMs: 150 }), new FingerCounter({ stableMs: 150 })], palms: [new PalmGate({ holdMs: 220 }), new PalmGate({ holdMs: 220 })], active: false, slot: -1, fingers: 0, sizeBeats: 0, center: null, startCenterY: 0, startCtx: 0, segmentStart: 0, noGrid: false, exitAtMs: 0, suppressPalmUntil: 0, lastWaveDraw: 0 };
const brake = { active: false, stopped: false, returning: false, slot: -1, center: null, startCenterY: 0, height01: 0.5, beats: 3, durationSec: 1, startCtx: 0, startPos: 0, baseRate: 1, progress: 0, returnCtx: 0, returnPos: 0, vinylAngle: 0, lastFrame: 0, handLostAt: 0, stems: null, previewH01: null };
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
// #fxArc es un <svg> (SVGElement): .hidden no quita el atributo. Usar atributos.
function setSvgHidden(el, hidden) { if (!el) return; if (hidden) el.setAttribute('hidden', ''); else el.removeAttribute('hidden'); }
function showFxArc(show) { setSvgHidden($('#fxArc'), !show); }
function hmHighpass() { return !!$('#hmHighpass')?.checked; }
function hmBeatOn() { return !!$('#hmBeat')?.checked && !reducedMotion; }
function hmParticlesOn() { return !!$('#hmParticles')?.checked && !reducedMotion; }
if ($('#hmHighpass')) $('#hmHighpass').checked = false; // ocultos para la demo: valores fijos
if ($('#hmParticles')) $('#hmParticles').checked = false;
function handExitMarginMs() { const v = Number($('#calHandExit')?.value); return Number.isFinite(v) ? Math.min(1000, Math.max(0, v)) : 180; }
try { const saved = Number(localStorage.getItem('motiondj-handexit-ms')); if (Number.isFinite(saved) && saved >= 0 && saved <= 1000 && $('#calHandExit')) { $('#calHandExit').value = saved; $('#calHandExitVal').textContent = saved; } } catch {}
$('#calHandExit')?.addEventListener('input', e => { $('#calHandExitVal').textContent = e.target.value; try { localStorage.setItem('motiondj-handexit-ms', e.target.value); } catch {} });
function hmFilterInput() { return document.querySelector(`input.knob-state[data-param="filter"][data-deck="${handMode.deck}"]`); }
function hmSetFilter(v) {
  handMode.filter = v;
  const inp = hmFilterInput(); if (!inp) return;
  inp.value = v; setParam(inp); syncAllKnobs();
}
// Perilla del canal que mueven las dos pinzas en el efecto FILTRO.
// Las 6 perillas del canal, con los mismos nombres que en la consola.
const HM_KNOBS = { high: 'HIGH', mid: 'MID', low: 'LOW', trim: 'TRIM', filter: 'FILTRO', eco: 'ECO' };
function hmKnobInput(k = handMode.knob) { return document.querySelector(`input.knob-state[data-param="${k}"][data-deck="${handMode.deck}"]`); }
function hmKnobPct(inp) { const mn = Number(inp.min), mx = Number(inp.max); return mx > mn ? (Number(inp.value) - mn) / (mx - mn) : 0; }
function hmKnobText(k, inp) {
  if (k === 'filter') return fmtFilter(handMode.filter);
  if (k === 'low' || k === 'mid' || k === 'high') return fmtDb(Number(inp.value));
  if (k === 'trim') return fmtTrimDb(Number(inp.value));
  return `${Math.round(hmKnobPct(inp) * 100)} %`;
}
function setHandKnob(k) {
  if (!HM_KNOBS[k] || handMode.gate.state === 'agarrado') return;
  handMode.knob = k; handMode.anchor = null; handMode.ramp = null;
  hmEffectUI();
  status(`Modo manos · las dos pinzas mueven ${HM_KNOBS[k]} del deck ${'AB'[handMode.deck]}.`);
}
document.querySelectorAll('#hmKnobs [data-knob]').forEach(b => b.addEventListener('click', () => setHandKnob(b.dataset.knob)));
// Raton/tactil: mismos botones de stems que con la pinza.
document.querySelectorAll('#hmStems [data-stem]').forEach(b => b.addEventListener('click', () => toggleStem(handMode.deck, Number(b.dataset.stem))));
document.querySelectorAll('#hmTarget [data-target]').forEach(b => b.addEventListener('click', () => setFxTarget(handMode.effect, Number(b.dataset.target))));
$('#stemsPanel')?.addEventListener('click', e => { const p = e.target.closest('[data-stem]'); if (p) toggleStem(Number(p.dataset.stemdeck), Number(p.dataset.stem)); });
function hmDeckCardUpdate() {
  const d = decks[handMode.deck]; if (!d) return;
  const badge = $('#hmDeckBadge'); if (badge) { badge.textContent = d.name; badge.style.background = handMode.deck === 1 ? 'var(--b)' : 'var(--a)'; }
  const tr = $('#hmDeckTrack'); if (tr) tr.textContent = d.track ? displayTrackName(d.track.name) : 'Sin pista';
  const bpmEl = $('#hmDeckBpm'); if (bpmEl) bpmEl.textContent = d.grid?.bpm ? `${fmtEs(d.grid.bpm, 1)} BPM · estimado · ${d.track ? fmt(engine?.decks[handMode.deck]?.position?.() || 0) : '0:00'}` : '— BPM · estimado';
}
function targetDeckIdx() { return handMode.deck === 0 ? 1 : 0; }
function hmTargetCardUpdate() {
  const card = $('#hmTargetCard'); if (!card) return;
  const t = targetDeckIdx(), d = decks[t], ch = engine?.decks[t];
  card.hidden = !(handMode.active && handMode.effect === 'eco');
  const badge = $('#hmTargetBadge'); if (badge) { badge.textContent = 'AB'[t]; badge.style.background = t === 1 ? 'var(--b)' : 'var(--a)'; }
  const name = $('#hmTargetTrack'); if (name) name.textContent = d?.track ? `${displayTrackName(d.track.name)} · ${ch?.playing ? 'SONANDO' : 'en pausa'}` : 'Sin pista';
  const st = $('#hmTargetState');
  if (st) st.textContent = !d?.track ? 'carga una pista para lanzar (solo sonará el eco)'
    : eco.flying ? (ch?.playing ? 'entró en el mismo golpe · tempo igualado' : 'solo suena la cola de eco')
    : ch?.playing ? 'ya suena · el lanzamiento pasa el crossfader a este deck'
    : 'en pausa · entrará en el mismo golpe del lanzamiento';
  card.classList.toggle('hot', !!eco.flying && !!ch?.playing);
}
function hmEffectUI() {
  const isEco = handMode.effect === 'eco', isFilter = handMode.effect === 'filter', isRoll = handMode.effect === 'roll', isBrake = handMode.effect === 'brake', isStems = handMode.effect === 'stems', isBuild = handMode.effect === 'build', idle = handMode.effect === 'idle' || (!isEco && !isFilter && !isRoll && !isBrake && !isStems && !isBuild), src = 'AB'[handMode.deck] || 'A', dst = 'AB'[targetDeckIdx()] || 'B';
  const bs = $('#fxSelStems'); if (bs) bs.classList.toggle('on', isStems);
  const bu = $('#fxSelBuild'); if (bu) bu.classList.toggle('on', isBuild);
  const bf = $('#fxSelFilter'), be = $('#fxSelEco'), br = $('#fxSelRoll'), bb = $('#fxSelBrake');
  if (bf) { bf.classList.toggle('on', isFilter); bf.setAttribute('aria-pressed', String(isFilter)); }
  if (be) { be.classList.toggle('on', isEco); be.setAttribute('aria-pressed', String(isEco)); be.style.borderColor = isEco ? (handMode.deck === 1 ? '#FF4FA3' : '#22D3EE') : ''; be.style.background = isEco ? (handMode.deck === 1 ? 'rgba(255,79,163,.16)' : 'rgba(34,211,238,.14)') : ''; }
  if (br) { br.classList.toggle('on', isRoll); br.setAttribute('aria-pressed', String(isRoll)); }
  if (bb) { bb.classList.toggle('on', isBrake); bb.setAttribute('aria-pressed', String(isBrake)); }
  const ex = $('#hmFilterExtras'); if (ex) ex.hidden = !isFilter;
  const lb = $('#hmLaunchBtn'); if (lb) lb.hidden = !isEco;
  const sl = $('#hmSliderLabel'); if (sl) sl.textContent = isEco ? 'ECO:' : isRoll ? 'ROLL:' : isBrake ? 'FRENO:' : 'Sin manos:';
  const title = $('#handModeTitle'); if (title) title.textContent = idle ? `MODO MANOS · DECK ${src}` : `MODO MANOS · ${isEco ? 'ECO' : isFilter ? 'FILTRO' : isRoll ? 'ROLL' : isStems ? 'STEMS' : isBuild ? 'SUBIDA' : 'FRENO'} ${src}`;
  document.body.classList.toggle('hm-picking', handMode.active && (idle || isStems)); // cursor de pinza (aro + dedos)
  const kb = $('#hmKnobs'); if (kb) { kb.hidden = !isFilter; kb.querySelectorAll('[data-knob]').forEach(b => b.classList.toggle('on', b.dataset.knob === handMode.knob)); kb.querySelectorAll('.hm-knob-deck').forEach(s => s.textContent = src); }
  const knobName = HM_KNOBS[handMode.knob] || 'FILTRO';
  const help = $('#hmHelp'); if (help) help.textContent = idle ? 'pellizca un efecto' : isEco ? `puño · sube = más eco · 👍 = lanzar a ${dst}` : isRoll ? '1, 2 o 3 dedos · bájalos y sigue' : isBrake ? 'palma quieta = frena · quítala = vuelve' : isBuild ? 'dos manos abiertas · súbelas · 🙏 juntas = DROP' : isStems ? (stemsReady(handMode.deck) ? 'pellizca una parte · arrastra su fader o el crossfader' : decks[handMode.deck]?.stems?.state === 'separating' ? 'Meta Demucs está separando la pista…' : 'sin stems: arranca stems-server') : handMode.knob === 'filter' ? 'dos pinzas · juntas = cerrar' : `dos pinzas · separa = más ${knobName}`;
  const hintDeck = $('#ecoHintDeck'); if (hintDeck) hintDeck.textContent = dst;
  const giDeck = $('#gestureIntroDeck'); if (giDeck) giDeck.textContent = src;
  const giTarget = $('#gestureIntroTarget'); if (giTarget) giTarget.textContent = dst;
  if (!isEco) { hideEcoVisual(); }
  if (!isRoll) hideRollVisual();
  if (!isBrake) hideBrakeVisual();
  if (!isBuild) hideBuildVisual();
  if (idle || isStems) { const fl = $('#fxArcLabel'); if (fl) fl.hidden = true; }
  hmTargetCardUpdate();
  hmStemsUI();
}
function hideGestureIntro() {
  handMode.introUntil = 0; const gi = $('#gestureIntro'); if (!gi || gi.hidden) return;
  gi.hidden = true; gi.querySelectorAll('.g-card').forEach(c => c.classList.remove('hover'));
  if (handMode.active) rebuildRegistry();
}
// Menu por pinza: el efecto se elige a proposito y queda fijo. Solo se lee
// el gesto del efecto elegido; para cambiar, «Cambiar efecto» con el
// efecto en reposo (nunca a mitad de un agarre, roll, freno o lanzamiento).
const MENU_MS = 10000;
function showEffectMenu() {
  const gi = $('#gestureIntro'); if (!gi) return;
  handMode.introUntil = performance.now() + MENU_MS; gi.hidden = false;
  if (handMode.active) rebuildRegistry();
}
function hmEffectBusy() {
  return !!(eco.grabbing || eco.throwWindow || eco.pending || eco.tail || eco.flying || eco.crossAnim)
    || handMode.gate.state === 'agarrado' || !!handMode.ramp || roll.active || brake.active || brake.returning || build.active || build.dropping;
}
function chooseHandEffect(effect) {
  if (!handMode.active || hmEffectBusy()) return;
  setHandEffect(effect);
  handMode.mouseControl = false;
  rebuildRegistry();
}
function changeHandEffect() {
  if (!handMode.active || hmEffectBusy()) return;
  handMode.effect = 'idle'; handMode.gate.reset(); handMode.anchor = null; eco.gate.reset(); resetFingerDetectors();
  hmEffectUI(); showEffectMenu();
  status(`Modo manos · deck ${'AB'[handMode.deck]}: elige un efecto con pinza.`);
}
document.querySelectorAll('#gestureIntro [data-pick]').forEach(b => b.addEventListener('click', () => chooseHandEffect(b.dataset.pick)));
$('#hmChange')?.addEventListener('click', changeHandEffect);
function setHandEffect(effect, { keepGate = false } = {}) {
  if (!['filter', 'eco', 'roll', 'brake', 'stems', 'build'].includes(effect)) return;
  hideGestureIntro();
  if (handMode.effect === effect) { hmEffectUI(); return; }
  if (handMode.effect === 'eco' && (eco.grabbing || eco.pending || eco.throwWindow)) ecoCancel('Efecto cambiado: eco cancelado sin lanzamiento.');
  if (handMode.effect === 'roll' && roll.active) rollAbort();
  if (handMode.effect === 'brake' && (brake.active || brake.returning)) brakeAbortToSlip();
  if (handMode.effect === 'build' && build.active) buildAbort();
  build.gate.reset();
  handMode.effect = effect;
  if (!keepGate || effect !== 'eco') { eco.gate.reset(); eco.grabbing = false; eco.anchor = null; eco.trail = []; eco.pending = null; eco.throwWindow = null; }
  if (!keepGate || effect !== 'filter') { handMode.gate.reset(); handMode.anchor = null; handMode.ramp = null; }
  if (effect !== 'roll' && effect !== 'brake') resetFingerDetectors();
  hmEffectUI();
  if (handMode.active && effect === 'stems') { status(stemsReady(handMode.deck) ? `Modo manos · STEMS ${'AB'[handMode.deck]}: pellizca VOZ, BATERÍA, BAJO o RESTO para apagar/encender en el golpe; dos pinzas = volumen.` : `Modo manos · STEMS ${'AB'[handMode.deck]}: esta pista aún no tiene stems (Meta Demucs en stems-server).`); return; }
  if (handMode.active && effect === 'build') { status(`Modo manos · SUBIDA ${'AB'[handMode.deck]}: abre las dos manos frente a ti para armar, súbelas para la tensión y 🙏 júntalas para el DROP.`); return; }
  if (handMode.active) status(effect === 'eco' ? `Modo manos · ECO ${'AB'[handMode.deck]}: cierra el puño unos 0,3 s para agarrar la canción; pulgar arriba para lanzar.` : effect === 'roll' ? `Modo manos · ROLL ${'AB'[handMode.deck]}: levanta 1, 2 o 3 dedos (con la mano sonando arranca en el golpe).` : effect === 'brake' ? `Modo manos · FRENO ${'AB'[handMode.deck]}: palma de «alto» quieta ~0,4 s para frenar.` : `Modo manos · FILTRO ${'AB'[handMode.deck]}: pinza con las dos manos para mover el filtro.`);
}
$('#fxSelFilter')?.addEventListener('click', () => setHandEffect('filter'));
$('#fxSelEco')?.addEventListener('click', () => setHandEffect('eco'));
$('#fxSelBuild')?.addEventListener('click', () => setHandEffect('build'));
$('#fxSelRoll')?.addEventListener('click', () => { setHandEffect('roll'); handMode.mouseControl = true; if (!roll.active) rollStart(2, -1, null); });
$('#fxSelBrake')?.addEventListener('click', () => { if (handMode.effect === 'brake' && brake.active) { brakeScheduleReturn(); return; } setHandEffect('brake'); handMode.mouseControl = true; if (!brake.active) brakeStart(-1, null); });
function hideEcoVisual() {
  ['ecoLabel', 'ecoMeter', 'ecoHintThrow', 'ecoHintCancel', 'ecoLaunchFx'].forEach(id => { const el = document.getElementById(id); if (el) el.hidden = true; });
  const rings = $('#ecoRings'); if (rings) rings.innerHTML = '';
  const arrow = $('#ecoArrow'); if (arrow) arrow.setAttribute('hidden', '');
}
// Visual del ECO: anillos que laten alrededor del puno, flecha hacia el
// otro deck y, al lanzar, anillos que vuelan con la cola. Sin ninguna
// indicacion del proximo tiempo 1 (el corte cae solo en el golpe).
function drawEcoVisual(center, now) {
  const rings = $('#ecoRings'), arrow = $('#ecoArrow'); if (!rings) return;
  const col = handMode.deck === 1 ? '#FF4FA3' : '#22D3EE';
  const label = $('#ecoLabel'), meter = $('#ecoMeter');
  if (eco.flying) {
    const p = Math.min(1, (now - eco.flying.since) / Math.max(1, eco.flying.tailMs));
    const dir = throwDirSign(handMode.deck), w = stage.clientWidth;
    let html = '';
    for (let i = 0; i < 4; i++) {
      const cx = eco.flying.x + dir * p * w * 0.42 + i * dir * 74, cy = eco.flying.y - p * 26 - i * 6, rx = 62 - i * 10 - p * 16, ry = rx * 1.12, op = (0.85 - i * 0.18) * (1 - p * 0.75);
      html += `<ellipse cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${Math.max(8, rx).toFixed(1)}" ry="${Math.max(9, ry).toFixed(1)}" fill="none" stroke="${col}" stroke-width="${(4 - i * 0.6).toFixed(1)}" opacity="${Math.max(0, op).toFixed(2)}"/>`;
    }
    rings.innerHTML = html;
    if (arrow) arrow.setAttribute('hidden', '');
    if (label) label.hidden = true; if (meter) meter.hidden = true;
    const fx = $('#ecoLaunchFx'); if (fx) fx.hidden = false;
    const bars = $('#ecoTailBars'); if (bars) [...bars.children].forEach((b, i) => b.style.height = Math.max(3, (28 - i * 4) * (1 - p) + 3) + 'px');
    const thumb = $('#ecoCrossThumb'); if (thumb) thumb.style.left = (handMode.deck === 0 ? (8 + p * 84) : (92 - p * 84)) + '%';
    const ct = $('#ecoCrossText'); if (ct) ct.textContent = `CROSSFADER · pasa solo a ${'AB'[targetDeckIdx()]}`;
    if (p >= 1) { eco.flying = null; if (fx) fx.hidden = true; rings.innerHTML = ''; }
    return;
  }
  const fx = $('#ecoLaunchFx'); if (fx) fx.hidden = true;
  if (!center || !(eco.grabbing || eco.throwWindow)) { rings.innerHTML = ''; if (arrow) arrow.setAttribute('hidden', ''); if (label) label.hidden = true; if (meter) meter.hidden = true; const ht = $('#ecoHintThrow'), hc = $('#ecoHintCancel'); if (ht) ht.hidden = true; if (hc) hc.hidden = true; return; }
  const beatR = handMode.beatEnv * 9;
  const base = 52 + eco.dose * 30 + beatR;
  let html = `<circle cx="${center.x}" cy="${center.y}" r="${(base + 6).toFixed(1)}" fill="none" stroke="${col}" stroke-width="10" opacity="0.28"/>`;
  [0, 38, 76, 112].forEach((extra, i) => { html += `<circle cx="${center.x}" cy="${center.y}" r="${(base + extra).toFixed(1)}" fill="none" stroke="${col}" stroke-width="${(4 - i).toFixed(1)}" opacity="${(0.95 - i * 0.22).toFixed(2)}"/>`; });
  rings.innerHTML = html;
  if (arrow) arrow.setAttribute('hidden', ''); // ya no se lanza con barrido: sin flecha
  if (label) { label.hidden = false; label.style.left = center.x + 'px'; label.style.top = Math.max(84, center.y - base - 132) + 'px'; const tx = $('#ecoLabelText'); if (tx) { const tk = fxTarget('eco'); tx.textContent = `ECO ${'AB'[handMode.deck]} · ${tk >= 0 ? STEM_LABELS[STEM_KEYS[tk]] : 'PISTA'} · ½ · ${Math.round(eco.dose * 100)} %`; } }
  if (meter) { meter.hidden = false; const fill = $('#ecoMeterFill'), tick = $('#ecoMeterTick'); if (fill) fill.style.height = eco.dose * 100 + '%'; if (tick) tick.style.bottom = eco.dose * 100 + '%'; }
  const ht = $('#ecoHintThrow'), hc = $('#ecoHintCancel'); if (ht) ht.hidden = false; if (hc) hc.hidden = false;
  // Pistas pegadas al puno (debajo), para leerlas sin mirar a otro lado.
  const hx = Math.min(stage.clientWidth - 160, Math.max(160, center.x)), hy = Math.min(stage.clientHeight - 80, center.y + base + 120);
  if (ht) { ht.style.left = hx + 'px'; ht.style.top = hy + 'px'; ht.style.transform = 'translateX(-50%)'; }
  if (hc) { hc.style.left = hx + 'px'; hc.style.top = (hy + 40) + 'px'; hc.style.transform = 'translateX(-50%)'; }
}
// Entrada DIRECTA (sin dialogo ni consentimiento): pinza, clic o teclado entran al instante.
function openHandModeIntro(i) { if (handMode.active) { exitHandMode('Modo manos cerrado.'); return; } handMode.deck = i; enterHandMode(); }
function enterHandMode() {
  handMode.effect = 'idle'; handMode.knob = 'filter'; handMode.introUntil = performance.now() + MENU_MS; eco.gate.reset(); eco.grabbing = false; eco.pending = null; eco.throwWindow = null; eco.flying = null;
  roll.active = false; roll.exitAtMs = 0; brake.active = false; brake.returning = false; roll.suppressPalmUntil = 0; resetFingerDetectors(); hideRollVisual(); hideBrakeVisual();
  const gi = $('#gestureIntro'); if (gi) gi.hidden = false;
  handMode.active = true; handMode.lostSince = null; handMode.seenHands = false; handMode.mouseControl = false; handMode.ramp = null; handMode.anchor = null; handMode.gate.reset();
  handMode.filter = Number(hmFilterInput()?.value || 0);
  handMode.apertura = hmHighpass() ? (handMode.filter / 100 + 0.5) : ((handMode.filter + 50) / 50);
  handMode.smooth = handMode.apertura;
  if ($('#hmApertura')) $('#hmApertura').value = handMode.apertura * 100;
  // Demo: latido fijo encendido, particulas y pasa-altos fijos apagados (interruptores ocultos).
  if ($('#hmBeat')) $('#hmBeat').checked = !reducedMotion;
  if ($('#hmParticles')) $('#hmParticles').checked = false;
  if ($('#hmHighpass')) $('#hmHighpass').checked = false;
  document.body.classList.add('handmode');
  $('#handModeBar').hidden = false;
  const dc = $('#hmDeckCard'); if (dc) dc.hidden = false;
  const eh = $('#hmExitHint'); if (eh) eh.hidden = false;
  showFxArc(true);
  hmEffectUI();
  decks[handMode.deck].el.querySelector('[data-manos]')?.classList.add('manos-active');
  registry.releaseAll(); endKnobDrag(); endAllScratches();
  hmDeckCardUpdate();
  status(`Modo manos en el deck ${'AB'[handMode.deck]}: elige un efecto con pinza (FILTRO, ECO, ROLL o FRENO); saca las dos manos para salir.`);
  rebuildRegistry();
}
function exitHandMode(why, { byHands = false } = {}) {
  if (!handMode.active) return;
  if (eco.grabbing || eco.pending) ecoCancel(null);
  if (roll.active) rollAbort(); // la principal nunca se paro: queda en slip
  if (brake.active || brake.returning) brakeAbortToSlip();
  if (build.active) buildAbort();
  resetFingerDetectors();
  eco.gate.reset(); eco.grabbing = false; eco.pending = null; eco.flying = null;
  handMode.active = false; handMode.anchor = null; handMode.ramp = null; handMode.gate.reset();
  if (byHands) { handMode.exitCount++; const c = $('#diagHandExits'); if (c) c.textContent = handMode.exitCount; }
  hmSetFilter(0); // higiene: filtro a Neutro al salir
  document.body.classList.remove('handmode', 'hm-picking');
  $('#handModeBar').hidden = true;
  const dc = $('#hmDeckCard'); if (dc) dc.hidden = true;
  const tc = $('#hmTargetCard'); if (tc) tc.hidden = true;
  hideGestureIntro();
  hideEcoVisual(); hideRollVisual(); hideBrakeVisual(); hideBuildVisual();
  eco.notice = null; { const en = $('#ecoNotice'); if (en) en.hidden = true; } build.flashUntil = 0;
  handMode.effect = 'idle';
  const eh = $('#hmExitHint'); if (eh) eh.hidden = true;
  const hm = $('#hmHandMsg'); if (hm) hm.hidden = true;
  const lb = $('#fxArcLabel'); if (lb) lb.hidden = true;
  showFxArc(false);
  document.querySelectorAll('[data-manos]').forEach(b => b.classList.remove('manos-active'));
  hmStemsUI(); // oculta barra y paneles de stems (los stems apagados siguen asi en la mezcla)
  if (why) status(why);
  rebuildRegistry();
}
$('#handModeExit')?.addEventListener('click', () => exitHandMode('Modo manos cerrado: filtro de vuelta a Neutro.'));
$('#btnTestArc')?.addEventListener('click', () => {
  if (handMode.active) { status('Probar arco: ya estás en Modo manos.'); return; }
  handMode.deck = handMode.deck >= 0 ? handMode.deck : 0; handMode.testUntil = performance.now() + 5000; showFxArc(true);
  const lb = $('#fxArcLabel'); if (lb) lb.hidden = false;
  status('Probar arco: arco fijo 5 s sin cámara. Comprueba que se ve sobre fondo claro y oscuro.');
});
// ---------- ECO: audio, SYNC al agarrar y lanzamiento en el golpe ----------
function hmEcoInput() { return document.querySelector(`input.knob-state[data-param="eco"][data-deck="${handMode.deck}"]`); }
function ecoSetDose(dose) {
  eco.dose = Math.min(1, Math.max(0, Number(dose) || 0));
  const inp = hmEcoInput(); if (inp) { inp.value = eco.dose * 0.8; setParam(inp); syncAllKnobs(); }
  if (engine) engine.delayFb.gain.setTargetAtTime(Math.min(0.5, 0.18 + eco.dose * 0.42), engine.ctx.currentTime, 0.05);
  // ECO sobre un stem (p. ej. solo la VOZ): el envio sale de ese stem, no del deck entero.
  const tk = fxTarget('eco');
  if (engine && stemsReady(handMode.deck)) {
    const ch = engine.decks[handMode.deck]; eco.stemDeck = handMode.deck;
    STEM_KEYS.forEach((_, k) => ch.setStemEco(k, k === tk ? eco.dose * 0.8 : 0));
    if (tk >= 0) ch.delaySend.gain.setTargetAtTime(0, engine.ctx.currentTime, 0.03);
  }
}
function ecoRestoreTail() {
  if (engine && eco.stemDeck >= 0) { STEM_KEYS.forEach((_, k) => engine.decks[eco.stemDeck].setStemEco(k, 0)); eco.stemDeck = -1; }
  const inp = hmEcoInput(); if (inp) { inp.value = 0; setParam(inp); syncAllKnobs(); }
  if (engine) engine.delayFb.gain.setTargetAtTime(0.32, engine.ctx.currentTime, 0.08);
  eco.dose = 0;
}
function showEcoNotice(text, kind = 'ok') {
  eco.notice = { text, kind, until: performance.now() + 1700 };
  const el = $('#ecoNotice'); if (el) { el.textContent = text; el.className = 'eco-notice ' + kind; el.hidden = false; }
}
function serviceEcoNotice(now) {
  const el = $('#ecoNotice'); if (!el) return;
  if (!eco.notice || now > eco.notice.until) { el.hidden = true; eco.notice = null; }
}
function ecoCancel(msg, { notice = false, force = false } = {}) {
  const was = eco.grabbing || eco.pending || eco.throwWindow || force;
  eco.grabbing = false; eco.pending = null; eco.throwWindow = null; eco.anchor = null; eco.trail = []; eco.gate.reset();
  if (was) ecoRestoreTail();
  hideEcoVisual();
  if (notice && handMode.active) showEcoNotice('Eco cancelado (no hubo lanzamiento)', 'cancel');
  if (msg) status(msg);
}
function ecoSyncInfo() {
  const src = handMode.deck, dst = targetDeckIdx(), sD = decks[src], dD = decks[dst];
  if (!sD?.bpm || !dD?.bpm) return { tempoSyncOk: false, alreadySynced: false, sync: null, effSrc: null, effDst: null };
  const sTempo = Number(sD.el.querySelector('.tempo')?.value || 0), dTempo = Number(dD.el.querySelector('.tempo')?.value || 0);
  const sync = syncTempoPct(dD.bpm, sD.bpm, sTempo);
  const effSrc = sD.bpm * (engine?.decks[src]?.rate || (1 + sTempo / 100));
  const effDst = dD.bpm * (engine?.decks[dst]?.rate || (1 + dTempo / 100));
  return { tempoSyncOk: !!sync?.ok, alreadySynced: Math.abs(effDst - effSrc) / Math.max(1, effSrc) < 0.003, sync, effSrc, effDst };
}
function ecoGrabStart(hand, center) {
  ensureEngine();
  const src = handMode.deck, dst = targetDeckIdx(), sCh = engine?.decks[src], dCh = engine?.decks[dst], dD = decks[dst];
  if (!sCh?.playing) { status(`ECO ${'AB'[src]}: el deck no está sonando; dale a PLAY antes de agarrar.`); eco.gate.reset(); return; }
  eco.grabbing = true; eco.pending = null; eco.trail = [];
  const startDose = Math.min(1, Math.max(0.2, ecoKnobValue(src) / 0.8));
  eco.anchor = { y: center ? center.y : stage.clientHeight / 2, dose: startDose };
  ecoSetDose(startDose);
  const cross = Number($('#cross')?.value || 0);
  const targetAudible = src === 0 ? cross > -0.2 : cross < 0.2;
  const info = ecoSyncInfo();
  eco.plan = launchPlan({ targetHasTrack: !!dD?.track, targetPlaying: !!dCh?.playing, targetAudible, tempoSyncOk: info.tempoSyncOk, alreadySynced: info.alreadySynced });
  // SYNC al cerrar el puno (solo si el destino no se oye todavia).
  if (eco.plan.syncAtGrab !== 'none' && dD?.track && info.sync?.ok) {
    const inp = dD.el.querySelector('.tempo'); if (inp) { inp.value = info.sync.pct.toFixed(1); setParam(inp); syncAllKnobs(); }
    if (eco.plan.syncAtGrab === 'completo' && dCh?.playing && decks[src].grid && dD.grid && decks[src].grid.confidence >= 0.3 && dD.grid.confidence >= 0.3) {
      const dest = alignToPhase(dCh.position(), dD.grid, beatPhase01(sCh.position(), decks[src].grid));
      dCh.seek(dest);
    }
  }
  const srcGridOk = decks[src].grid && decks[src].grid.confidence >= 0.3;
  if (eco.plan.aviso === 'sin-pista') status(`ECO ${'AB'[src]} agarrado. Sin pista en ${'AB'[dst]}: al lanzar solo sonará la cola de eco.`);
  else if (eco.plan.aviso === 'tempo-distinto') status(`ECO ${'AB'[src]} agarrado. ${'AB'[dst]} tiene un tempo muy distinto: entrará a su velocidad.`);
  else if (eco.plan.aviso === 'no-sincronizada') status(`ECO ${'AB'[src]} agarrado. ${'AB'[dst]} ya suena y no está sincronizada: no se tocará su tempo.`);
  else status(`ECO ${'AB'[src]} agarrado · ${Math.round(eco.dose * 100)} %. Sube o baja el puño para dosificar; pulgar arriba = lanzar.`);
  if (!srcGridOk) status(`ECO ${'AB'[src]} agarrado. Sin rejilla fiable: el corte será inmediato al lanzar.`);
  hmTargetCardUpdate();
}
function ecoExecuteLaunch(center) {
  const src = handMode.deck, dst = targetDeckIdx(), sCh = engine?.decks[src], dCh = engine?.decks[dst], dD = decks[dst];
  eco.pending = null; eco.grabbing = false;
  if (!engine || !sCh) return;
  const hadTarget = !!dD?.track;
  if (hadTarget && dCh && !dCh.playing) {
    dCh.seek(targetStartPosition({ position: dCh.position(), cue: dCh.cue, firstBeat: dD.grid?.firstBeat }));
    dCh.play();
  }
  // Crossfader automatico al otro deck (curva corta en ecoService).
  const crossEl = $('#cross'), from = Number(crossEl?.value || 0), to = hadTarget ? crossTargetFor(src) : from;
  eco.crossAnim = hadTarget ? { from, to, since: performance.now(), dur: 450 } : null;
  // La seca de A cae por el crossfader; A sigue sonando solo dentro del
  // eco (delay post-fader) hasta que acaba la cola y queda en pausa.
  const tailMs = Math.min(4200, Math.max(1400, ecoTimeForDeck(src) * 6000));
  roll.suppressPalmUntil = performance.now() + 1500; // la palma que abre el lanzamiento no es FRENO
  // Echo out: desde el corte el eco ya no recibe sonido nuevo; solo repite
  // lo ultimo (la ultima palabra, si va sobre la VOZ) y se apaga solo.
  const t0 = engine.ctx.currentTime;
  sCh.delaySend.gain.setTargetAtTime(0, t0, 0.02); sCh.stemEco.forEach(g => g.gain.setTargetAtTime(0, t0, 0.02));
  engine.delayFb.gain.setTargetAtTime(0.5, t0, 0.05);
  eco.flying = { x: center?.x ?? stage.clientWidth / 2, y: center?.y ?? stage.clientHeight / 2, since: performance.now(), tailMs };
  eco.tail = { src, dst, hadTarget, endsAt: performance.now() + tailMs };
  const help = $('#hmHelp'); if (help) help.textContent = hadTarget ? `¡Lanzado! ${'AB'[src]} se cortó en el golpe y ${'AB'[dst]} entró en el mismo golpe` : `¡Lanzado! Solo suena la cola de eco de ${'AB'[src]}`;
  showEcoNotice('¡Lanzado!', 'ok');
  status(help ? help.textContent : 'Lanzado.');
  hmTargetCardUpdate();
}
function ecoLaunch(center) {
  ensureEngine();
  const src = handMode.deck, sCh = engine?.decks[src];
  if (!sCh) return;
  const cut = nextBeatCut({ position: sCh.position(), grid: decks[src].grid, rate: sCh.rate || 1 });
  if (!cut.quantized || cut.delaySec <= 0.03) { ecoExecuteLaunch(center); return; }
  eco.pending = { atPosition: cut.atPosition, deadline: performance.now() + cut.delaySec * 1000 + 500, center };
  status(`Lanzamiento armado: caerá en el siguiente golpe de ${'AB'[src]}.`);
}
function ecoService(now) {
  if (eco.crossAnim) {
    const p = Math.min(1, (now - eco.crossAnim.since) / eco.crossAnim.dur), s = p * p * (3 - 2 * p), v = eco.crossAnim.from + (eco.crossAnim.to - eco.crossAnim.from) * s;
    const crossEl = $('#cross'); if (crossEl) { crossEl.value = v; setParam(crossEl); }
    if (p >= 1) eco.crossAnim = null;
  }
  if (eco.pending) {
    const src = handMode.deck, sCh = engine?.decks[src];
    if ((sCh && sCh.position() >= eco.pending.atPosition - 0.005) || now > eco.pending.deadline) ecoExecuteLaunch(eco.pending.center);
  }
  if (eco.tail && now >= eco.tail.endsAt) {
    const { src, dst, hadTarget } = eco.tail; eco.tail = null;
    const sCh = engine?.decks[src];
    if (sCh?.playing) sCh.pause();
    ecoRestoreTail();
    if (hadTarget && engine?.decks[dst]?.playing) { handMode.deck = dst; eco.gate.reset(); hmEffectUI(); hmDeckCardUpdate(); }
    hmTargetCardUpdate();
  }
}
// ---------- ROLL y FRENO (4C): audio slip, detectores y visual ----------
function handCenterOf(p) { return p?.lm ? coverPoint({ x: (p.lm[0].x + p.lm[9].x) / 2, y: (p.lm[0].y + p.lm[9].y) / 2 }) : (p ? { x: p.x, y: p.y } : null); }
function resetFingerDetectors() { roll.counters.forEach(c => c.reset()); roll.palms.forEach(g => g.reset()); }
function palmSuppressed(now) { return now < roll.suppressPalmUntil || !!(eco.pending || eco.tail || eco.flying || eco.crossAnim || eco.throwWindow); }
// Actualiza conteo de dedos y palma por hueco. Devuelve el primer evento
// estable de dedos (1..3 util, 0/4 informados) y el de palma, si los hay.
function updateFingerDetectors(pts, now) {
  let rollEv = null, palmEv = null;
  pts.forEach((p, hi) => {
    if (!p || p.det.pinched || !p.lm) { roll.counters[hi].reset(); roll.palms[hi].reset(); return; }
    const center = handCenterOf(p);
    const c = roll.counters[hi].update({ landmarks: p.lm, now });
    if (c.event === 'stable' && !rollEv) rollEv = { count: c.count, slot: hi, center };
    const g = roll.palms[hi].update({ landmarks: p.lm, center, now, stageW: stage.clientWidth });
    if (g.event === 'brake' && !palmEv) palmEv = { slot: hi, center };
  });
  return { rollEv, palmEv };
}
function deckBeatSec(i) { const d = decks[i]; return d?.grid?.bpm ? 60 / d.grid.bpm : (d?.bpm ? 60 / d.bpm : 0.5); }
function rollStart(fingers, slot, center) {
  ensureEngine();
  const i = handMode.deck, ch = engine?.decks[i], sizeBeats = rollSizeBeats(fingers);
  if (!sizeBeats) return false;
  if (!ch?.buffer || !ch.playing) { status(`ROLL ${'AB'[i]}: el deck no está sonando; dale a PLAY antes de contar dedos.`); return false; }
  if (handMode.effect !== 'roll') setHandEffect('roll');
  const cut = nextBeatCut({ position: ch.position(), grid: decks[i].grid, rate: ch.rate || 1 });
  const sizeSec = sizeBeats * deckBeatSec(i);
  const whenCtx = engine.ctx.currentTime + (cut.quantized ? cut.delaySec : 0.01);
  const tk = fxTarget('roll', i); ch.rollTargets = tk >= 0 ? [tk] : null; // ROLL solo en un stem (p. ej. BATERIA)
  if (!ch.startSlipRoll({ segmentStart: cut.atPosition, sizeSec, whenCtx })) return false;
  roll.active = true; roll.slot = slot; roll.fingers = fingers; roll.sizeBeats = sizeBeats;
  roll.center = center || { x: stage.clientWidth / 2, y: stage.clientHeight / 2 }; roll.startCenterY = roll.center.y;
  roll.startCtx = whenCtx; roll.segmentStart = cut.atPosition; roll.noGrid = !cut.quantized; roll.exitAtMs = 0;
  if (!cut.quantized) showEcoNotice('Sin rejilla fiable: el roll no está cuantizado', 'cancel');
  status(`ROLL ${'AB'[i]} · ${rollSizeLabel(sizeBeats)}: repite desde el golpe y la pista sigue por debajo.`);
  hmEffectUI();
  return true;
}
function rollChangeSize(fingers) {
  const i = handMode.deck, ch = engine?.decks[i], sizeBeats = rollSizeBeats(fingers);
  if (!roll.active || !ch || !sizeBeats || sizeBeats === roll.sizeBeats) return;
  const cut = nextBeatCut({ position: ch.position(), grid: decks[i].grid, rate: ch.rate || 1 });
  const whenCtx = engine.ctx.currentTime + (cut.quantized ? cut.delaySec : 0.01);
  if (ch.changeRollSize(sizeBeats * deckBeatSec(i), whenCtx)) {
    roll.fingers = fingers; roll.sizeBeats = sizeBeats;
    status(`ROLL ${'AB'[i]} · ${rollSizeLabel(sizeBeats)} en el siguiente golpe.`);
  }
}
function rollExit() {
  const i = handMode.deck, ch = engine?.decks[i];
  if (!roll.active || roll.exitAtMs) return;
  if (!ch) { roll.active = false; return; }
  const cut = nextBeatCut({ position: ch.position(), grid: decks[i].grid, rate: ch.rate || 1 });
  const whenCtx = engine.ctx.currentTime + (cut.quantized ? cut.delaySec : 0.01);
  ch.exitSlipRollAt(whenCtx);
  roll.exitAtMs = performance.now() + Math.max(0, (whenCtx - engine.ctx.currentTime) * 1000);
  status(`ROLL ${'AB'[i]}: sale en el golpe y sigue donde estaría sin roll.`);
}
function rollAbort() {
  const ch = engine?.decks[handMode.deck];
  if (ch?.roll) ch.cancelRoll();
  roll.active = false; roll.exitAtMs = 0; hideRollVisual();
}
function hideRollVisual() {
  ['rollLabel', 'rollBadge', 'rollPanel', 'rollWavePanel', 'rollHint'].forEach(id => { const el = document.getElementById(id); if (el) el.hidden = true; });
  const g = $('#rollFx'); if (g) g.innerHTML = '';
}
function drawRollWave() {
  const cv = $('#rollWaveCanvas'); if (!cv || !engine) return;
  const ctx = cv.getContext('2d'), d = decks[handMode.deck], peaks = d?.peaks;
  ctx.clearRect(0, 0, cv.width, cv.height); ctx.fillStyle = '#0a0f14'; ctx.fillRect(0, 0, cv.width, cv.height);
  if (!peaks?.length || !d.track) return;
  const dur = d.track.buffer.duration, segStart = roll.segmentStart, segLen = Math.max(0.02, roll.sizeBeats * deckBeatSec(handMode.deck));
  const bars = 53, mid = 48;
  for (let b = 0; b < bars; b++) {
    const inRoll = b >= 16 && b < 48, srcPos = inRoll ? segStart + ((b - 16) % 8) / 8 * segLen : (b / bars) * dur;
    const pk = peaks[Math.max(0, Math.min(peaks.length - 1, Math.floor(srcPos / dur * peaks.length)))] || 0.2;
    const h = Math.max(3, pk * 72);
    ctx.fillStyle = inRoll ? '#4ADE80' : '#5b6674';
    ctx.fillRect(18 + b * 6, mid - h / 2, 4, h);
  }
  ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.setLineDash([3, 3]);
  for (let j = 1; j < 4; j++) { const x = 18 + (16 + j * 8) * 6 - 1; ctx.beginPath(); ctx.moveTo(x, 8); ctx.lineTo(x, 88); ctx.stroke(); }
  ctx.setLineDash([]); ctx.strokeStyle = '#4ADE80'; ctx.strokeRect(18 + 16 * 6 - 4, 6, 32 * 6 + 4, 84);
  const wd = $('#rollWaveDeck'); if (wd) wd.textContent = `DECK ${'AB'[handMode.deck]} · trozo de ${rollSizeLabel(roll.sizeBeats).toLowerCase()}, repetido`;
}
function drawRollVisual(now) {
  if (!roll.active || !roll.center) { hideRollVisual(); return; }
  const col = '#4ADE80', label = $('#rollLabel'), badge = $('#rollBadge');
  if (label) { label.hidden = false; label.style.left = roll.center.x + 'px'; label.style.top = Math.max(84, roll.center.y - 190) + 'px'; const tx = $('#rollLabelText'); if (tx) tx.textContent = `ROLL ${'AB'[handMode.deck]} · ${rollSizeLabel(roll.sizeBeats)}`; }
  if (badge) { badge.hidden = false; badge.style.left = (roll.center.x + 150) + 'px'; badge.style.top = (roll.center.y - 150) + 'px'; const n = $('#rollBadgeNum'); if (n) n.textContent = roll.fingers; }
  const panel = $('#rollPanel'); if (panel) { panel.hidden = false; panel.querySelectorAll('.roll-opt').forEach(el => el.classList.toggle('on', Number(el.dataset.fingers) === roll.fingers)); }
  const wave = $('#rollWavePanel'); if (wave) wave.hidden = false;
  const rh = $('#rollHint'); if (rh) rh.hidden = false;
  if (now - roll.lastWaveDraw > 180) { roll.lastWaveDraw = now; drawRollWave(); }
  // Anillo dividido en repeticiones; la actual en blanco y latiendo.
  const g = $('#rollFx'); if (!g || !engine) return;
  const ch = engine.decks[handMode.deck];
  const sizeReal = Math.max(0.03, roll.sizeBeats * deckBeatSec(handMode.deck) / Math.max(0.05, ch?.rate || 1));
  const reps = roll.sizeBeats === 1 ? 4 : roll.sizeBeats === 0.5 ? 8 : 16;
  const elapsed = Math.max(0, engine.ctx.currentTime - roll.startCtx);
  const cur = Math.floor(elapsed / sizeReal) % reps, pulse = reducedMotion ? 1 : 1 + handMode.beatEnv * 0.12;
  const cx = roll.center.x, cy = roll.center.y, r = 150 * pulse, circ = 2 * Math.PI * r, seg = circ / reps;
  let arcs = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${col}" stroke-width="12" opacity="0.16"/>`;
  arcs += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${col}" stroke-width="7" stroke-dasharray="${(seg - 14).toFixed(1)} 14" opacity="0.45" transform="rotate(-90 ${cx} ${cy})"/>`;
  arcs += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#ffffff" stroke-width="9" stroke-dasharray="${(seg - 14).toFixed(1)} ${(circ - seg + 14).toFixed(1)}" stroke-dashoffset="${(-seg * cur).toFixed(1)}" opacity="0.95" transform="rotate(-90 ${cx} ${cy})"/>`;
  arcs += `<circle cx="${cx}" cy="${cy}" r="${(r * 0.82).toFixed(1)}" fill="none" stroke="${col}" stroke-width="2" opacity="0.25"/>`;
  g.innerHTML = arcs;
}
// --- FRENO ---
function brakeStart(slot, center) {
  ensureEngine();
  const i = handMode.deck, ch = engine?.decks[i];
  if (!ch?.buffer || !ch.playing) { status(`FRENO ${'AB'[i]}: el deck no está sonando; dale a PLAY antes de frenar.`); return false; }
  if (handMode.effect !== 'brake') setHandEffect('brake');
  const c = center || { x: stage.clientWidth / 2, y: stage.clientHeight / 2 };
  const height01 = palmHeight01(c, stage.clientHeight);
  const plan = brakePlan({ height01, bpm: decks[i].grid?.bpm || decks[i].bpm, rate: ch.rate || 1 });
  brake.active = true; brake.stopped = false; brake.returning = false; brake.slot = slot; brake.center = c; brake.startCenterY = c.y;
  brake.height01 = height01; brake.beats = plan.beats; brake.durationSec = plan.durationSec;
  brake.startCtx = engine.ctx.currentTime; brake.startPos = ch.position(); brake.baseRate = ch.rate || 1; brake.progress = 0; brake.handLostAt = 0;
  // Con stems: solo frenan las partes elegidas y el resto sigue sonando.
  const tks = brakeTargets(i);
  brake.stems = tks && ch.startStemBrake({ targets: tks, durationSec: plan.durationSec, curve: Array.from({ length: 64 }, (_, n) => brakeRate(n / 63)) }) ? tks : null;
  status(`FRENO ${'AB'[i]} · ${plan.beats % 1 ? plan.beats.toFixed(1) : plan.beats} tiempos (${plan.label.toLowerCase()}): ${brake.stems ? (brakeSel() === -2 ? 'frena la música, la VOZ sigue sola' : `frena solo ${STEM_LABELS[STEM_KEYS[brake.stems[0]]]}`) : 'frenando como un vinilo'}.`);
  hmEffectUI();
  return true;
}
function brakeSlipPos(nowCtx) { return slipPosition(brake.startPos, Math.max(0, (nowCtx ?? engine.ctx.currentTime) - brake.startCtx), brake.baseRate); }
function brakeScheduleReturn() {
  const i = handMode.deck, ch = engine?.decks[i];
  if (!brake.active || brake.returning || !ch || !engine) return;
  const nowCtx = engine.ctx.currentTime;
  const cut = nextBeatCut({ position: brakeSlipPos(nowCtx), grid: decks[i].grid, rate: brake.baseRate });
  const whenCtx = nowCtx + (cut.quantized ? cut.delaySec : 0.005);
  if (brake.stems) { // la fuente principal nunca paro: solo vuelven las partes frenadas
    brake.returning = true; brake.returnCtx = whenCtx; ch.endStemBrake(whenCtx);
    status(`FRENO ${'AB'[i]}: ${cut.quantized ? 'las partes vuelven en el siguiente golpe' : 'las partes vuelven ya (sin rejilla fiable)'}, en su sitio.`);
    return;
  }
  brake.returning = true; brake.returnCtx = whenCtx; brake.returnPos = cut.quantized ? cut.atPosition : brakeSlipPos(whenCtx);
  ch.setRate(brake.baseRate);
  ch.playAt(brake.returnPos, whenCtx);
  status(cut.quantized ? `FRENO ${'AB'[i]}: vuelve en el siguiente golpe, en su sitio.` : `FRENO ${'AB'[i]}: vuelve ya, en su sitio (sin rejilla fiable).`);
}
function brakeAbortToSlip() {
  const i = handMode.deck, ch = engine?.decks[i];
  if (!ch || !engine) { brake.active = false; brake.returning = false; return; }
  if (brake.returning) { brake.active = false; brake.returning = false; hideBrakeVisual(); return; } // playAt ya va a la slip
  if (brake.stems) { ch.endStemBrake(); brake.stems = null; brake.active = false; brake.stopped = false; hideBrakeVisual(); return; }
  if (brake.active) {
    const pos = brakeSlipPos(engine.ctx.currentTime);
    ch.setRate(brake.baseRate);
    if (brake.stopped || !ch.playing) ch.playAt(pos, engine.ctx.currentTime + 0.01); else ch.seek(pos);
  }
  brake.active = false; brake.stopped = false; hideBrakeVisual();
}
function hideBrakeVisual() {
  ['brakeLabel', 'brakeMeter', 'brakePanel', 'brakeHint'].forEach(id => { const el = document.getElementById(id); if (el) el.hidden = true; });
  const g = $('#brakeFx'); if (g) g.innerHTML = '';
}
function drawBrakeCurve(p, speedPct) {
  const cv = $('#brakeCurveCanvas'); if (!cv) return;
  const ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H); ctx.fillStyle = '#0a0f14'; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#2a323c'; ctx.beginPath(); ctx.moveTo(34, 10); ctx.lineTo(34, H - 22); ctx.lineTo(W - 8, H - 22); ctx.stroke();
  ctx.fillStyle = '#7d8794'; ctx.font = '10px Inter'; ctx.fillText('100 %', 2, 16); ctx.fillText('0', 22, H - 24);
  ctx.strokeStyle = '#F5B13D'; ctx.lineWidth = 3; ctx.beginPath();
  for (let x = 0; x <= 40; x++) { const px = 34 + (W - 46) * x / 40, py = 10 + (H - 36) * (1 - brakeRate(x / 40)); x ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
  ctx.stroke(); ctx.lineWidth = 1;
  const px = 34 + (W - 46) * p, py = 10 + (H - 36) * (1 - brakeRate(p));
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(px, py, 6, 0, 7); ctx.fill();
  const sv = $('#brakeSpeedVal'); if (sv) sv.textContent = `${Math.round(speedPct)} %`;
  const sf = $('#brakeSpeedFill'); if (sf) sf.style.width = speedPct + '%';
  const sd = $('#brakeSpeedDeck'); if (sd) sd.textContent = 'AB'[handMode.deck];
}
function drawBrakeVisual(now) {
  if (!brake.active && !brake.returning) {
    // En reposo el medidor sigue a la palma: se ve el largo antes de frenar.
    hideBrakeVisual();
    const meter = $('#brakeMeter'), h = brake.previewH01;
    if (meter && handMode.active && handMode.effect === 'brake') {
      meter.hidden = false; meter.style.opacity = h === null || h === undefined ? 0.45 : 1;
      const v = (h ?? 0.5) * 100, f = $('#brakeMeterFill'), t = $('#brakeMeterTick');
      if (f) f.style.height = v + '%'; if (t) t.style.bottom = v + '%';
    }
    return;
  }
  { const m = $('#brakeMeter'); if (m) m.style.opacity = 1; }
  const c = brake.center || { x: stage.clientWidth * 0.3, y: stage.clientHeight * 0.5 };
  const speedPct = brake.returning ? 100 : brakeRate(brake.progress) * 100;
  const label = $('#brakeLabel'); if (label) { label.hidden = false; label.style.left = c.x + 'px'; label.style.top = Math.max(84, c.y - 185) + 'px'; const tx = $('#brakeLabelText'); if (tx) tx.textContent = brake.returning ? `FRENO ${'AB'[handMode.deck]} · VUELVE EN EL GOLPE` : `FRENO ${'AB'[handMode.deck]}${brake.stems ? (brakeSel() === -2 ? ' · MÚSICA' : ' · ' + STEM_LABELS[STEM_KEYS[brake.stems[0]]]) : ''} · ${Math.round(speedPct)} %`; }
  const meter = $('#brakeMeter'); if (meter) { meter.hidden = false; const f = $('#brakeMeterFill'), t = $('#brakeMeterTick'); if (f) f.style.height = brake.height01 * 100 + '%'; if (t) t.style.bottom = brake.height01 * 100 + '%'; }
  const panel = $('#brakePanel'); if (panel) panel.hidden = false;
  const hint = $('#brakeHint'); if (hint) hint.hidden = false;
  drawBrakeCurve(brake.returning ? 1 : brake.progress, speedPct);
  // Vinilo que gira cada vez mas lento, con estela, y halo de palma.
  const dt = brake.lastFrame ? Math.min(0.05, (now - brake.lastFrame) / 1000) : 0.016; brake.lastFrame = now;
  brake.vinylAngle += dt * (brake.returning ? 1 : brakeRate(brake.progress)) * 2.2;
  const g = $('#brakeFx'); if (!g) return;
  const vx = Math.min(stage.clientWidth - 190, c.x + 430), vy = c.y - 20, a = brake.vinylAngle;
  const pt = (r, ang) => `${(vx + r * Math.cos(ang)).toFixed(1)} ${(vy + r * Math.sin(ang)).toFixed(1)}`;
  let s = `<circle cx="${c.x}" cy="${c.y}" r="150" fill="rgba(245,177,61,.06)"/><circle cx="${c.x}" cy="${c.y}" r="150" fill="none" stroke="#F5B13D" stroke-width="3" stroke-dasharray="14 10" opacity="0.65"/>`;
  s += `<circle cx="${vx}" cy="${vy}" r="118" fill="#0c0f14" stroke="#2a313b" stroke-width="2"/>`;
  for (const r of [104, 92, 80, 68, 56]) s += `<circle cx="${vx}" cy="${vy}" r="${r}" fill="none" stroke="#1f2630" stroke-width="1.5"/>`;
  s += `<path d="M ${pt(126, a - 0.55)} A 126 126 0 0 1 ${pt(126, a)}" fill="none" stroke="#F5B13D" stroke-width="5" stroke-linecap="round" opacity="0.85"/>`;
  s += `<path d="M ${pt(136, a - 0.3)} A 136 136 0 0 1 ${pt(136, a)}" fill="none" stroke="#F5B13D" stroke-width="3" stroke-linecap="round" opacity="0.45"/>`;
  s += `<circle cx="${vx}" cy="${vy}" r="36" fill="#F5B13D"/><path d="M ${pt(9, a)} L ${pt(32, a)}" stroke="#061218" stroke-width="4" stroke-linecap="round"/><circle cx="${vx}" cy="${vy}" r="5" fill="#061218"/>`;
  g.innerHTML = s;
}
// ---------- SUBIDA y DROP (dos manos) ----------
// Armar: las dos manos abiertas ~0,3 s. Subirlas (un palmo desde donde se
// armo) sube la tension: ROLL solo en la BATERIA cada vez mas corto, el
// BAJO sale y el canal va al pasa-altos; la VOZ sigue limpia. Manos juntas =
// DROP en el siguiente compas; bajar o sacar las manos = cancelar en el golpe.
const build = { active: false, dropping: false, gate: new OpenHandsGate({ holdMs: 300 }), together: new HandsTogetherGate(), anchorY: 0, level: 0, rollBeats: null, prevLevels: null, prevFilter: 0, hpSet: null, lostAt: 0, flashUntil: 0 };
const STEM_DRUMS = STEM_KEYS.indexOf('drums'), STEM_BASS = STEM_KEYS.indexOf('bass');
function deckFilterInput(i) { return document.querySelector(`input.knob-state[data-param="filter"][data-deck="${i}"]`); }
function setDeckFilter(i, v) {
  if (i === handMode.deck) { hmSetFilter(v); return; }
  const inp = deckFilterInput(i); if (inp) { inp.value = v; setParam(inp); syncAllKnobs(); }
}
function buildStart(anchorY) {
  ensureEngine();
  const i = handMode.deck, ch = engine?.decks[i];
  if (!ch?.buffer || !ch.playing) { status(`SUBIDA ${'AB'[i]}: el deck no está sonando; dale a PLAY antes de armar.`); build.gate.reset(); return false; }
  build.active = true; build.anchorY = anchorY; build.level = 0; build.rollBeats = null; build.lostAt = 0; build.hpSet = null; build.together.reset();
  build.prevLevels = stemsReady(i) ? STEM_KEYS.map((_, k) => ch.stemLevelNow(k)) : null;
  build.prevFilter = Number(deckFilterInput(i)?.value || 0);
  status(`SUBIDA ${'AB'[i]} armada: sube las manos para más tensión · 🙏 junta las manos = DROP en el siguiente compás.${build.prevLevels ? '' : ' (Sin stems: el roll va sobre la pista entera.)'}`);
  hmEffectUI();
  return true;
}
function buildApply(level) {
  const i = handMode.deck, ch = engine?.decks[i]; if (!ch || !build.active) return;
  build.level = level;
  const st = buildStage(level);
  // Una vez empezado, el roll no se apaga al bajar un poco: se queda en 1 tiempo.
  const beats = st.rollBeats ?? (build.rollBeats !== null ? 1 : null);
  if (beats !== build.rollBeats && beats !== null) {
    const cut = nextBeatCut({ position: ch.position(), grid: decks[i].grid, rate: ch.rate || 1 });
    const whenCtx = engine.ctx.currentTime + (cut.quantized ? cut.delaySec : 0.01), sizeSec = beats * deckBeatSec(i);
    if (build.rollBeats !== null && ch.roll) ch.changeRollSize(sizeSec, whenCtx);
    else { ch.rollTargets = build.prevLevels ? [STEM_DRUMS] : null; ch.startSlipRoll({ segmentStart: cut.atPosition, sizeSec, whenCtx }); }
    build.rollBeats = beats;
  }
  if (build.prevLevels) ch.setStemLevel(STEM_BASS, build.prevLevels[STEM_BASS] * st.bass);
  const hp = Math.round(st.hp * 35); // hasta HP 70 %: la voz aun se oye entera
  if (hp !== build.hpSet) { build.hpSet = hp; setDeckFilter(i, Math.max(build.prevFilter, hp)); }
}
// Suelta la subida en whenCtx (reloj de audio): roll fuera, bajo y filtro de vuelta.
function buildRelease(whenCtx, drop) {
  const i = handMode.deck, ch = engine?.decks[i];
  build.active = false; build.dropping = true; build.gate.reset();
  if (ch?.roll) ch.exitSlipRollAt(whenCtx);
  if (ch && build.prevLevels) ch.setStemLevel(STEM_BASS, build.prevLevels[STEM_BASS], whenCtx);
  const ms = engine ? Math.max(0, (whenCtx - engine.ctx.currentTime) * 1000) : 0, prevF = build.prevFilter;
  setTimeout(() => {
    setDeckFilter(i, prevF); build.dropping = false; build.rollBeats = null;
    if (drop) { build.flashUntil = performance.now() + 500; showEcoNotice('¡DROP!', 'ok'); status(`SUBIDA ${'AB'[i]}: ¡DROP! Todo volvió en el compás.`); }
    hmEffectUI();
  }, ms);
}
function buildDrop() {
  const i = handMode.deck, ch = engine?.decks[i]; if (!build.active || !ch) return;
  const cut = nextBarCut({ position: ch.position(), grid: decks[i].grid, rate: ch.rate || 1 });
  buildRelease(engine.ctx.currentTime + (cut.quantized ? cut.delaySec : 0.01), true);
  status(cut.quantized ? `SUBIDA ${'AB'[i]}: DROP armado para el siguiente compás…` : `SUBIDA ${'AB'[i]}: DROP ya (sin rejilla fiable).`);
}
function buildCancel(msg) {
  const i = handMode.deck, ch = engine?.decks[i]; if (!build.active) return;
  if (!ch || !engine) { build.active = false; return; }
  const cut = nextBeatCut({ position: ch.position(), grid: decks[i].grid, rate: ch.rate || 1 });
  buildRelease(engine.ctx.currentTime + (cut.quantized ? cut.delaySec : 0.01), false);
  showEcoNotice('Subida cancelada (sin drop)', 'cancel');
  if (msg) status(msg);
}
function buildAbort() { if (build.active && engine) buildRelease(engine.ctx.currentTime + 0.01, false); }
function hideBuildVisual() {
  ['buildLabel', 'buildHint'].forEach(id => { const el = document.getElementById(id); if (el) el.hidden = true; });
  const g = $('#buildFx'); if (g) g.innerHTML = '';
}
function drawBuildVisual(now, centers) {
  const g = $('#buildFx'), label = $('#buildLabel'), hint = $('#buildHint'); if (!g) return;
  const col = handMode.deck === 1 ? '#FF4FA3' : '#22D3EE', W = stage.clientWidth, H = stage.clientHeight;
  let s = '';
  if (now < build.flashUntil) { const k = (build.flashUntil - now) / 500; s += `<rect x="0" y="0" width="${W}" height="${H}" fill="#fff" opacity="${(k * 0.55).toFixed(2)}"/><rect x="6" y="6" width="${W - 12}" height="${H - 12}" fill="none" stroke="${col}" stroke-width="${(18 * k).toFixed(1)}" opacity="${k.toFixed(2)}"/>`; }
  if (build.active && centers.length === 2) {
    const [a, b] = centers, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, L = build.level, beatK = handMode.beatEnv || 0;
    // Cuerda entre las manos que vibra mas rapido y fuerte con la tension.
    const n = 40, amp = 6 + L * 34 + beatK * 10, freq = 3 + L * 9;
    let d = '';
    for (let k = 0; k <= n; k++) { const t = k / n, x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t + Math.sin(Math.PI * t) * Math.sin(t * freq * Math.PI * 2 + now / (90 - L * 60)) * amp; d += `${k ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)} `; }
    s += `<path d="${d}" fill="none" stroke="${col}" stroke-width="${(8 + L * 10).toFixed(1)}" opacity="0.3"/><path d="${d}" fill="none" stroke="#fff" stroke-width="3" opacity="0.95"/>`;
    // Chevrones que suben desde el centro: mas y mas rapidos con la tension.
    const count = 2 + Math.round(L * 4);
    for (let k = 0; k < count; k++) { const ph = ((now / (700 - L * 450)) + k / count) % 1, y = my - 30 - ph * (120 + L * 120), w = 34 + L * 30; s += `<path d="M ${mx - w} ${y + 16} L ${mx} ${y} L ${mx + w} ${y + 16}" fill="none" stroke="${col}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" opacity="${(0.9 * (1 - ph)).toFixed(2)}"/>`; }
    if (label) { label.hidden = false; label.style.left = mx + 'px'; label.style.top = Math.max(84, my - 300) + 'px'; const tx = $('#buildLabelText'); if (tx) tx.textContent = `SUBIDA ${'AB'[handMode.deck]} · ${build.prevLevels ? 'BATERÍA' : 'PISTA'} ${rollBeatsLabel(build.rollBeats)} · ${Math.round(L * 100)} %`; }
  } else if (label) label.hidden = true;
  if (hint) { hint.hidden = false; hint.textContent = build.active ? '🙏 junta las manos = DROP en el siguiente compás · bájalas = cancelar' : build.dropping ? 'DROP en camino…' : 'abre las dos manos frente a ti para armar la subida'; }
  g.innerHTML = s;
}
$('#hmLaunchBtn')?.addEventListener('click', () => {
  if (!handMode.active || handMode.effect !== 'eco') return;
  handMode.mouseControl = true;
  if (!eco.grabbing && !eco.pending) ecoGrabStart(null, { x: stage.clientWidth / 2, y: stage.clientHeight / 2 });
  if (eco.grabbing) ecoLaunch({ x: stage.clientWidth / 2, y: stage.clientHeight / 2 });
});
function hmApplyMouse() { // sustituto sin camara: aplica al instante
  if (!handMode.active) return;
  if (handMode.effect === 'idle') setHandEffect('filter');
  if (handMode.effect === 'roll') {
    const fingers = handMode.apertura < 0.34 ? 3 : handMode.apertura < 0.67 ? 2 : 1;
    if (!roll.active) rollStart(fingers, -1, null); else rollChangeSize(fingers);
    return;
  }
  if (handMode.effect === 'brake') { if (!brake.active && !brake.returning) brakeStart(-1, { x: stage.clientWidth / 2, y: stage.clientHeight * (1 - handMode.apertura) }); return; }
  if (handMode.effect === 'eco') {
    if (!eco.grabbing && !eco.pending) ecoGrabStart(null, { x: stage.clientWidth / 2, y: stage.clientHeight / 2 });
    if (eco.grabbing) ecoSetDose(handMode.apertura);
    return;
  }
  handMode.smooth = handMode.apertura; handMode.ramp = null; handMode.anchor = null;
  hmSetFilter(aperturaToFilter(handMode.smooth, { highpass: hmHighpass() }));
}
$('#hmApertura')?.addEventListener('input', e => { handMode.apertura = Number(e.target.value) / 100; handMode.mouseControl = true; hmApplyMouse(); });
document.addEventListener('keydown', e => {
  if (!handMode.active) return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { handMode.apertura = Math.min(1, handMode.apertura + 0.04); handMode.mouseControl = true; $('#hmApertura').value = handMode.apertura * 100; hmApplyMouse(); }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { handMode.apertura = Math.max(0, handMode.apertura - 0.04); handMode.mouseControl = true; $('#hmApertura').value = handMode.apertura * 100; hmApplyMouse(); }
});
// El arco (Bloque 4): entre los puntos de pinza, forma de onda real del
// deck (AnalyserNode, dominio del tiempo) + ruido, contorno oscuro y
// brillo para verse sobre fondo claro y oscuro, esqueleto de las manos
// con el color del deck, marca al proximo tiempo 1 y etiqueta del valor.
const HAND_LINKS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[0,17],[17,18],[18,19],[19,20]];
let arcWaveBuf = null;
function drawHandsSkeleton(pts, pinchPts, col, { lineCol = null, dotCol = '#fff', pinchRings = true } = {}) {
  const g = $('#fxArcHands'); if (!g) return;
  let html = '';
  (pts || []).forEach((p, hi) => {
    if (!p?.lm) return;
    const mapped = p.lm.map(lm => coverPoint(lm));
    for (const [a, b] of HAND_LINKS) html += `<line x1="${mapped[a].x.toFixed(1)}" y1="${mapped[a].y.toFixed(1)}" x2="${mapped[b].x.toFixed(1)}" y2="${mapped[b].y.toFixed(1)}" stroke="${lineCol || col}" stroke-width="3" stroke-linecap="round" opacity="0.92"/>`;
    for (const m of mapped) html += `<circle cx="${m.x.toFixed(1)}" cy="${m.y.toFixed(1)}" r="4" fill="${dotCol}" opacity="0.95"/>`;
    const pp = pinchPts?.[hi];
    if (pp && pinchRings) html += `<circle cx="${pp.x.toFixed(1)}" cy="${pp.y.toFixed(1)}" r="30" fill="none" stroke="${col}" stroke-width="2" opacity="0.25"/><circle cx="${pp.x.toFixed(1)}" cy="${pp.y.toFixed(1)}" r="17" fill="none" stroke="#fff" stroke-width="3" opacity="0.9"/>`;
  });
  g.innerHTML = html;
}
function drawHandArc(pts, now, { pinchPts = null, gateState = 'reposo' } = {}) {
  const t0 = performance.now();
  const svg = $('#fxArc'); const active = handMode.active || (handMode.testUntil && now < handMode.testUntil);
  const ends = pinchPts || pts;
  const deckCol = handMode.deck === 1 ? '#FF4FA3' : '#22D3EE';
  drawHandsSkeleton(pts, pinchPts, deckCol);
  if (!active || !ends?.[0] || !ends?.[1]) {
    // Con una sola mano: sin arco (antes quedaba uno al 25% invisible).
    if (svg) svg.style.opacity = 0;
    const lb = $('#fxArcLabel'); if (lb) lb.hidden = true;
    return;
  }
  svg.style.opacity = gateState === 'agarrado' ? 1 : (gateState === 'congelado' ? 0.55 : 0.7);
  const [p0, p1] = ends, mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
  const dx = p1.x - p0.x, dy = p1.y - p0.y, len = Math.max(1, Math.hypot(dx, dy));
  const nx = -dy / len, ny = dx / len;
  const j = reducedMotion ? 0 : Math.sin(now / 55) * Math.min(26, len * 0.08) * (0.5 + handMode.beatEnv * 0.7);
  const ctrl = { x: mx + nx * j, y: my + ny * j };
  // Onda real del deck en el dominio del tiempo (buffer reutilizado).
  let wave = null;
  const an = engine?.decks[handMode.deck]?.analyser;
  if (an) { if (!arcWaveBuf || arcWaveBuf.length !== an.fftSize) arcWaveBuf = new Uint8Array(an.fftSize); an.getByteTimeDomainData(arcWaveBuf); wave = arcWaveBuf; }
  const isDown = handMode._beat ? (((handMode._beat.index % 4) + 4) % 4 === 0) : false;
  // Hilo expresivo: la forma de onda se normaliza a su pico (siempre se ve
  // la forma entera) y la altura sigue al volumen real del deck, al bombo
  // y al largo del hilo. Con el filtro cerrado (LP) la onda se suaviza;
  // con HP se vuelve mas nerviosa: el hilo «suena» como el filtro.
  let peak = 0;
  if (wave) for (let k = 0; k < wave.length; k++) peak = Math.max(peak, Math.abs(wave[k] - 128) / 128);
  handMode.arcLevel = (handMode.arcLevel || 0) + (Math.min(1, peak * 2.2) - (handMode.arcLevel || 0)) * (peak * 2.2 > (handMode.arcLevel || 0) ? 0.6 : 0.12);
  const norm = 1 / Math.max(0.08, peak);
  const amp = Math.min(90, 26 + len * 0.07) * (0.3 + 0.7 * handMode.arcLevel) * (1 + handMode.beatEnv * 0.7) * (isDown ? 1.25 : 1) * (reducedMotion ? 0.5 : 1);
  const lp = !hmHighpass() && handMode.filter < -2 ? Math.min(1, -handMode.filter / 50) : 0;
  const hp = hmHighpass() ? Math.min(1, Math.max(0, (handMode.filter + 50) / 100)) : (handMode.filter > 2 ? Math.min(1, handMode.filter / 50) : 0);
  const smoothW = Math.round(lp * 10); // muestras promediadas: LP = onda redonda
  const sampleAt = (t) => {
    if (!wave) return null;
    const c = Math.floor(t * (wave.length - 1)); let acc = 0, n = 0;
    for (let k = Math.max(0, c - smoothW); k <= Math.min(wave.length - 1, c + smoothW); k++) { acc += wave[k] - 128; n++; }
    return Math.max(-1, Math.min(1, (acc / n / 128) * norm));
  };
  const buildPath = (scale, seed) => {
    const N = 96; let d = '';
    for (let i = 0; i <= N; i++) {
      const t = i / N, env = Math.pow(Math.sin(Math.PI * t), 0.6), bp = bezierPoint(p0, ctrl, p1, t);
      const sv = sampleAt(t);
      const wv = sv !== null ? sv * (1 - lp * 0.35) + (reducedMotion ? 0 : Math.sin(t * (30 + hp * 70) + now / 60 + seed) * hp * 0.35) : Math.sin(t * 22 + seed) * 0.4;
      const noise = reducedMotion ? 0 : (Math.sin(i * 12.9898 + seed * 78.233 + Math.floor(now / 80)) * 0.5) * (1 - lp);
      const off = (wv * amp + noise * amp * 0.18) * env * scale;
      d += `${i === 0 ? 'M' : 'L'} ${(bp.x + nx * off).toFixed(1)} ${(bp.y + ny * off).toFixed(1)} `;
    }
    return d;
  };
  const dMain = buildPath(1, 1.7), dSecond = buildPath(0.55, 4.3);
  const knobInp = handMode.knob !== 'filter' ? hmKnobInput() : null;
  const col = knobInp ? '#9D8CFF' : filterColor(handMode.filter, hmHighpass());
  const outline = $('#fxArcOutline'), glow = $('#fxArcGlow'), core = $('#fxArcCore'), second = $('#fxArcSecond');
  if (outline) { outline.setAttribute('d', dMain); }
  if (glow) { glow.setAttribute('d', dMain); glow.setAttribute('stroke', col); glow.style.opacity = reducedMotion ? 0.25 : 0.3 + handMode.beatEnv * 0.45; }
  if (core) { core.setAttribute('d', dMain); core.setAttribute('stroke', col); core.style.opacity = 0.95; }
  if (second) { second.setAttribute('d', dSecond); second.style.opacity = 0.85; }
  // Etiqueta del valor real sobre el arco.
  const label = $('#fxArcLabel'), ltext = $('#fxArcLabelText'), lfill = $('#fxArcBarFill');
  if (label) {
    label.hidden = false;
    label.style.left = mx + 'px'; label.style.top = Math.max(76, my - 92) + 'px';
    if (knobInp) {
      if (ltext) ltext.textContent = `${HM_KNOBS[handMode.knob]} ${'AB'[handMode.deck]} · ${hmKnobText(handMode.knob, knobInp)}`;
      if (lfill) { lfill.style.width = Math.round(hmKnobPct(knobInp) * 100) + '%'; lfill.style.background = col; }
    } else {
      if (ltext) ltext.textContent = `FILTRO ${'AB'[handMode.deck]} · ${fmtFilter(handMode.filter)}`;
      if (lfill) { const hp = hmHighpass(); const pct = hp ? (handMode.filter + 50) : (handMode.filter + 50) * 2; lfill.style.width = Math.min(100, Math.max(0, pct)) + '%'; lfill.style.background = col; }
    }
  }
  const sparks = $('#fxArcSparks');
  if (hmParticlesOn() && handMode.spark > 0.02) {
    let html = '';
    for (let s = 0; s < 6; s++) {
      const t = (s + 0.5) / 6, bp = bezierPoint(p0, ctrl, p1, t);
      const off = Math.sin(now / 90 + s * 2.1) * 14 * handMode.spark;
      html += `<circle cx="${bp.x + nx * off}" cy="${bp.y + ny * off}" r="${1.5 + handMode.spark * 2}" fill="${col}" opacity="${0.35 + handMode.spark * 0.5}"/>`;
    }
    sparks.innerHTML = html;
  } else sparks.innerHTML = '';
  handMode.arcCostMs = performance.now() - t0;
  if ((drawHandArc._n = (drawHandArc._n || 0) + 1) % 30 === 0) { const el = $('#diagArcMs'); if (el) el.textContent = `${handMode.arcCostMs.toFixed(2)} ms/fotograma`; }
}
// ---------- Biblioteca ----------
function renderLibrary() {
  const q = $('#search').value.toLowerCase(), ul = $('#trackList'); ul.innerHTML = '';
  const rows = sortTracks(library.filter(t => t.name.toLowerCase().includes(q)), libSort.key, libSort.dir);
  rows.forEach(t => {
    const li = document.createElement('li');
    const inDeck = decks.map((d, i) => d.track === t ? i : -1).filter(i => i >= 0), tag = queueTag(deckQueues, t);
    li.className = 'lib-row' + (selectedTrack === t ? ' sel' : '') + (t.played && !inDeck.length ? ' played' : '');
    const state = inDeck.length ? inDeck.map(i => `<span class="tagdeck tag-${'ab'[i]}">EN ${'AB'[i]}</span>`).join('') : tag ? `<span class="tagq tag-${tag[0].toLowerCase()}">${tag}</span>` : t.played ? '<span class="tagplayed">sonó</span>' : '';
    li.innerHTML = `<span class="num">${library.indexOf(t) + 1}</span><span class="tt" title="${t.name.replace(/"/g, '&quot;')}">${displayTrackName(t.name)}</span><span>${t.metaBpm ? t.metaBpm.toFixed(0) : '—'}</span><span>${t.duration ? fmt(t.duration) : '—'}</span><span>${t.stemPeaks ? '<span class="tagstems">✓</span>' : ''}</span><span>${state}</span><span class="acts"><button class="btn small qa" data-qa="0" title="Agregar a la cola del deck A">+A</button><button class="btn small qb" data-qa="1" title="Agregar a la cola del deck B">+B</button><button class="btn small" data-qdel title="Quitar de la biblioteca">✕</button></span>`;
    li.onclick = () => { selectedTrack = t; renderLibrary(); };
    li.querySelectorAll('[data-qa]').forEach(b => b.onclick = (e) => { e.stopPropagation(); const d = Number(b.dataset.qa); deckQueues = addToDeck(deckQueues, d, t); renderQueue(); renderLibrary(); $('#libMsg').textContent = `Cola ${'AB'[d]} · ${deckQueues[d].length}: ${displayTrackName(t.name)}`; serviceDeckQueues(false); });
    li.querySelector('[data-qdel]').onclick = (e) => { e.stopPropagation(); const ix = library.indexOf(t); if (ix >= 0) library.splice(ix, 1); deckQueues = dropTrack(deckQueues, t); if (selectedTrack === t) selectedTrack = null; renderLibrary(); renderQueue(); $('#libMsg').textContent = `Quitada de la biblioteca: ${displayTrackName(t.name)} (si sonaba en un deck, sigue hasta que cargues otra).`; };
    ul.appendChild(li);
  });
  document.querySelectorAll('#trackHead [data-sort]').forEach(b => { const on = b.dataset.sort === libSort.key; b.classList.toggle('on', on); b.dataset.dir = on ? (libSort.dir > 0 ? '▲' : '▼') : ''; });
}
// Orden por columna: clic = ascendente, otro clic = descendente, tercero = orden original.
document.querySelectorAll('#trackHead [data-sort]').forEach(b => b.onclick = () => {
  const k = b.dataset.sort;
  libSort = libSort.key !== k ? { key: k, dir: 1 } : libSort.dir > 0 ? { key: k, dir: -1 } : { key: null, dir: 1 };
  renderLibrary();
});
$('#btnLibExpand').onclick = e => { const on = !document.body.classList.contains('lib-expanded'); document.body.classList.toggle('lib-expanded', on); e.currentTarget.setAttribute('aria-pressed', String(on)); e.currentTarget.textContent = on ? '⤡ Biblioteca normal' : '⤢ Ampliar biblioteca'; if (on) $('.panel.library').scrollIntoView({ behavior: 'smooth' }); };
$('#search').oninput = renderLibrary;
// Biblioteca por METADATOS (P3.5): la lista guarda nombre/duracion/BPM y la
// referencia al archivo; el AudioBuffer (~105 MB por tema de 5 min) solo se
// decodifica al cargar en un deck y se libera al salir de los decks.
async function trackFile(track) {
  if (track.file) return track.file;
  if (track.handle) { try { return await track.handle.getFile(); } catch { return null; } }
  return null;
}
async function ensureTrackBuffer(track) {
  if (track.buffer) return track.buffer;
  ensureEngine();
  if (track.url) {
    const r = await fetch(track.url); if (!r.ok) throw new Error('demo no encontrada');
    const ab = await r.arrayBuffer();
    track.buffer = await engine.ctx.decodeAudioData(ab);
  } else {
    const f = await trackFile(track);
    if (!f) throw new Error('sin archivo');
    track.buffer = await engine.decode(f);
  }
  track.duration = track.buffer.duration;
  return track.buffer;
}
function freeUnusedBuffers(keep) {
  const inDecks = new Set(decks.map(d => d.track).filter(Boolean));
  for (const t of library) if (t.buffer && !inDecks.has(t) && !keep?.includes(t)) { t.buffer = null; t.stemBuf = null; }
}
async function addTrack(name, blobOrUrl) {
  // Demos (URL): se decodifican al momento por compatibilidad; archivos del
  // usuario: solo metadatos, sin decodificar (memoria bajo control).
  if (typeof blobOrUrl === 'string') {
    ensureEngine();
    try {
      const t = { id: crypto.randomUUID(), name, url: blobOrUrl, buffer: null, duration: null };
      await ensureTrackBuffer(t);
      library.push(t); selectedTrack = t; renderLibrary();
      $('#libMsg').textContent = `Importada: ${name}`;
      return t;
    } catch (e) { $('#libMsg').textContent = `Error al leer "${name}": formato no soportado o archivo dañado.`; return null; }
  }
  const t = { id: crypto.randomUUID(), name, file: blobOrUrl, buffer: null, duration: null };
  library.push(t); selectedTrack = t;
  const objUrl = URL.createObjectURL(blobOrUrl);
  const au = new Audio();
  au.onloadedmetadata = () => { t.duration = au.duration; URL.revokeObjectURL(objUrl); renderLibrary(); };
  au.src = objUrl;
  renderLibrary();
  $('#libMsg').textContent = `Añadida: ${name} (se decodifica solo al cargarla en un deck).`;
  return t;
}
$('#fileImport').onchange = async e => { for (const f of e.target.files) await addTrack(f.name, f); e.target.value = ''; };
$('#btnDemo').onclick = async () => {
  $('#libMsg').textContent = 'Cargando demos generadas localmente…';
  await addTrack('Demo A — House 122 BPM (generada)', '/audio/demo-a.wav');
  await addTrack('Demo B — Electro 124 BPM (generada)', '/audio/demo-b.wav');
};
let lastUndoLoad = null; // {deck, prev} para deshacer con Esc mientras no suene
async function loadToDeck(i, track = selectedTrack, skipConfirm = false) {
  if (!track) { $('#libMsg').textContent = 'Selecciona primero una pista de la lista.'; return false; }
  ensureEngine(); const ch = engine.decks[i], d = decks[i];
  if (ch.playing && !skipConfirm) { if (!confirm(`El deck ${d.name} está sonando. ¿Detenerlo y reemplazar la pista?`)) return false; }
  try { await ensureTrackBuffer(track); }
  catch { $('#libMsg').textContent = `No se pudo leer "${track.name}": formato no soportado, archivo dañado o sin permiso (reabre la carpeta).`; status(`No se pudo cargar "${track.name}".`); return false; }
  lastUndoLoad = { deck: i, prev: d.track };
  ch.load(track.buffer); d.track = track; d.hotcues = Array(8).fill(null);
  d.loop = null; ch.clearLoop();
  d.el.querySelectorAll('.pad').forEach((b, p) => { b.classList.remove('set'); b.textContent = padLabel(p); });
  const lb = d.el.querySelector('.loopbtn'); if (lb) lb.textContent = 'LOOP 4';
  const tempoInp = d.el.querySelector('.tempo'); if (tempoInp) { tempoInp.value = 0; d.el.querySelector('.tempoval').textContent = fmtTempo(0); }
  setSyncLit(0, false); setSyncLit(1, false);
  ch.setRate(1);
  d.peaks = computePeaks(track.buffer);
  d.peaksZoom = computePeaks(track.buffer, 1440);
  d.grid = analyzeBeatgrid(track.buffer.getChannelData(0), track.buffer.sampleRate);
  d.bpm = d.grid?.bpm || null; d.taps = [];
  const tn = d.el.querySelector('.tname'); tn.textContent = displayTrackName(track.name); tn.title = track.name;
  track.metaBpm = d.bpm;
  freeUnusedBuffers([track]);
  updateGridUI(d);
  drawWave(d); renderLibrary(); status(`Pista cargada en deck ${d.name}. No suena hasta pulsar PLAY.`);
  startStems(i, track); // en segundo plano: la pista ya suena sin esperar a los stems
  return true;
}
// ---------- STEMS (Meta Demucs): separacion local al cargar la pista ----------
// El servidor stems-server/ corre Demucs en la GPU del usuario; si no esta,
// la pista funciona igual sin stems.
async function trackBytes(track) {
  if (track.url) return (await fetch(track.url)).arrayBuffer();
  const f = await trackFile(track); return f ? f.arrayBuffer() : null;
}
function stemsBadge(i) {
  const d = decks[i], st = d.stems; if (!d.el) return;
  let b = d.el.querySelector('.stems-badge');
  if (!b) { b = document.createElement('span'); b.className = 'stems-badge'; d.el.querySelector('.tname')?.after(b); }
  b.classList.toggle('ready', st?.state === 'ready');
  b.textContent = !st || st.state === 'off' ? '' : st.state === 'ready' ? 'STEMS ✓' : st.state === 'separating' ? `STEMS ${Math.round((st.progress || 0) * 100)} %` : st.state === 'error' ? 'STEMS ✕' : 'STEMS…';
  b.hidden = !b.textContent;
}
async function startStems(i, track) {
  const d = decks[i], token = (d.stemsToken = (d.stemsToken || 0) + 1);
  const alive = () => d.stemsToken === token && d.track === track;
  d.stems = { state: 'checking', progress: 0, levels: [1, 1, 1, 1], muted: [false, false, false, false], peaks: null };
  stemsBadge(i); hmStemsUI();
  if (track.stemBuf) { applyStems(i, track); return; }
  if (!await stemsServerUp()) { if (alive()) { d.stems.state = 'off'; stemsBadge(i); hmStemsUI(); } return; }
  try {
    d.stems.state = 'separating'; stemsBadge(i); hmStemsUI();
    const bytes = await trackBytes(track); if (!bytes || !alive()) return;
    const id = await separateStems(bytes, track.name, { onProgress: p => { if (alive()) { d.stems.progress = p; stemsBadge(i); hmStemsUI(); } }, isCancelled: () => !alive() });
    if (!id || !alive()) return;
    const bufs = await loadStemBuffers(engine.ctx, id); if (!alive() || !track.buffer) return;
    track.stemBuf = buildStemBuffer(engine.ctx, bufs, track.buffer.length, track.buffer.sampleRate);
    track.stemPeaks = bufs.map(b => computePeaks(b, 1200));
    applyStems(i, track);
  } catch (e) {
    if (!alive()) return;
    d.stems.state = 'error'; d.stems.error = String(e?.message || e); stemsBadge(i); hmStemsUI();
    status(`STEMS ${d.name}: no se pudieron separar (${d.stems.error}). La pista suena normal.`);
  }
}
function applyStems(i, track) {
  const d = decks[i];
  if (engine.decks[i].setStems(track.stemBuf)) {
    d.stems = { state: 'ready', progress: 1, levels: [1, 1, 1, 1], muted: [false, false, false, false], peaks: track.stemPeaks };
    status(`STEMS ${d.name}: Meta Demucs separó VOZ, BATERÍA, BAJO y RESTO.`);
  } else d.stems.state = 'error';
  stemsBadge(i); hmStemsUI();
}
function stemsReady(i) { return decks[i]?.stems?.state === 'ready'; }
// ROLL y ECO sobre una sola parte (p. ej. ROLL en la BATERIA, ECO en la VOZ).
// -1 = la pista entera. Solo cambia con el efecto en reposo.
function setFxTarget(effect, k) {
  if (!['roll', 'eco', 'brake'].includes(effect) || hmEffectBusy()) return;
  handMode.fxTarget = { ...(handMode.fxTarget || {}), [effect]: k };
  status(`${effect === 'roll' ? 'ROLL' : effect === 'brake' ? 'FRENO' : 'ECO'} ${'AB'[handMode.deck]} sobre ${k === -2 ? 'la MÚSICA (la VOZ sigue)' : k < 0 ? 'la pista entera' : STEM_LABELS[STEM_KEYS[k]]}.`);
  hmStemsUI();
}
// ECO sin elegir parte: por defecto la VOZ (echo out de la ultima frase).
// FRENO con stems: por defecto frena la MUSICA (-2) y la VOZ sigue sola.
// -1 = la pista entera (freno clasico de vinilo). null = sin stems.
function brakeSel() { return handMode.fxTarget?.brake ?? -2; }
function brakeTargets(i = handMode.deck) {
  const k = brakeSel(); if (k === -1 || !stemsReady(i)) return null;
  return k === -2 ? STEM_KEYS.map((_, j) => j).filter(j => STEM_KEYS[j] !== 'vocals') : [k];
}
function fxTarget(effect, i = handMode.deck) { const k = handMode.fxTarget?.[effect] ?? (effect === 'eco' ? STEM_KEYS.indexOf('vocals') : -1); return k >= 0 && stemsReady(i) ? k : -1; }
// Apaga/enciende un stem en el siguiente golpe (sin rejilla: al instante).
function toggleStem(i, k) {
  if (!stemsReady(i)) return;
  const d = decks[i], ch = engine.decks[i], st = d.stems;
  st.muted[k] = !st.muted[k];
  const cut = ch.playing ? nextBeatCut({ position: ch.position(), grid: d.grid, rate: ch.rate || 1 }) : null;
  const at = cut?.quantized ? engine.ctx.currentTime + cut.delaySec : null;
  ch.setStemLevel(k, st.muted[k] ? 0 : st.levels[k], at);
  handMode.stemSel = { deck: i, k };
  status(`STEMS ${d.name}: ${STEM_LABELS[STEM_KEYS[k]]} ${st.muted[k] ? 'apagada' : 'encendida'}${at ? ' en el golpe' : ''}.`);
  hmStemsUI();
}
function stemsMashup() {
  if (!stemsReady(0) || !stemsReady(1) || !engine?.decks[0].playing || !engine?.decks[1].playing) return false;
  const only = (i, k) => decks[i].stems.muted.every((m, j) => j === k ? !m : m);
  return (only(0, 0) && decks[1].stems.muted[0]) || (only(1, 0) && decks[0].stems.muted[0]);
}
function stemsDeckTitle(i) {
  const st = decks[i].stems;
  return st.state === 'ready' ? (stemsMashup() ? (st.muted[0] ? 'INSTRUMENTAL · sin voz' : 'ACAPELLA · solo voz') : 'LO QUE SUENA') : 'SEPARANDO…';
}
function stemsDeckSub(i) {
  const st = decks[i].stems;
  return st.state === 'ready' ? 'separado con Meta Demucs · en tu GPU' : st.state === 'error' ? 'no se pudo separar' : `Meta Demucs ${Math.round((st.progress || 0) * 100)} %`;
}
// Tarjeta de un deck: boton (apaga/enciende en el golpe), onda y fader de volumen
// por stem. Todo se maneja como la consola: aro, pinza y arrastre.
function stemsDeckHTML(i) {
  const d = decks[i], st = d.stems;
  if (!st || st.state === 'off') return '';
  const head = `<h3><b>${'AB'[i]}</b><span data-title>${stemsDeckTitle(i)}</span> <small data-sub>${stemsDeckSub(i)}</small></h3>`;
  if (st.state !== 'ready') return head;
  return head + STEM_KEYS.map((key, k) => `<div class="stem-row" style="--sc:${STEM_COLORS[key]}"><button type="button" class="stem-pill" data-stem="${k}" data-stemdeck="${i}" style="--sc:${STEM_COLORS[key]}">${STEM_LABELS[key]}</button><canvas width="560" height="46" data-lane="${k}"></canvas><input class="stem-fader" type="range" min="0" max="1" step="0.01" value="${st.levels[k]}" data-g="range" data-stemfader="${k}" data-stemdeck="${i}" aria-label="Volumen ${STEM_LABELS[key]} deck ${'AB'[i]}"></div>`).join('');
}
// Volumen de un stem desde su fader (raton o pinza). A 0 queda apagado; al
// subirlo se enciende solo.
function setStemFader(i, k, v) {
  if (!stemsReady(i)) return;
  const st = decks[i].stems; v = Math.min(1, Math.max(0, Number(v) || 0));
  st.levels[k] = v; st.muted[k] = v <= 0.01;
  engine.decks[i].setStemLevel(k, st.muted[k] ? 0 : v);
  hmStemsUI();
}
// ---------- Crossfader central y cambio A <-> B (SYNC + 8 golpes) ----------
let stemsXferTo = -1; // deck destino del cambio en curso (para iluminar su boton)
function stemsCrossUI() {
  const x = Number($('#cross')?.value || 0), sc = $('#stemsCross');
  if (sc && document.activeElement !== sc && !sc.hasAttribute('data-grabbed')) sc.value = x;
  const a = Math.round((1 - x) / 2 * 100), val = $('#stemsXVal'); if (val) val.textContent = `A ${a} % · B ${100 - a} %`;
  document.querySelectorAll('.stems-xbtn').forEach(b => {
    const t = Number(b.dataset.xfer);
    const running = !!smartTimer && stemsXferTo === t;
    b.disabled = !running && (!decks[t]?.track || (t === 0 ? x <= -0.95 : x >= 0.95) || !!smartTimer);
    b.classList.toggle('running', running);
  });
}
function stemsTransferTo(t) {
  ensureEngine();
  const from = 1 - t, chT = engine.decks[t];
  if (!decks[t]?.track) { status(`Carga una pista en el deck ${'AB'[t]} para pasar a ella.`); return; }
  if (smartTimer) { status('Ya hay un cambio en curso.'); return; }
  stemsXferTo = t;
  if (decks[from]?.track && engine.decks[from].playing) deckAction(t, 'sync', decks[t].el.querySelector('[data-act="sync"]'));
  if (!chT.playing) chT.play();
  const bpm = decks[t].grid?.bpm || decks[t].bpm || 120, ms = Math.round(8 * 60 / bpm * 1000);
  const grid = decks[from]?.grid, chF = engine.decks[from];
  const cut = chF?.playing && grid ? nextBeatCut({ position: chF.position(), grid, rate: chF.rate || 1 }) : null;
  setTimeout(() => { startAutoTransition(t === 1 ? 1 : -1, ms); stemsCrossUI(); }, cut?.quantized ? cut.delaySec * 1000 : 0);
  status(`Cambio a ${'AB'[t]}: SYNC y crossfader en 8 golpes (${(ms / 1000).toFixed(1)} s).`);
}
$('#stemsCross')?.addEventListener('input', e => { const c = $('#cross'); if (!c) return; c.value = e.target.value; setParam(c); stemsCrossUI(); });
document.querySelectorAll('.stems-xbtn').forEach(b => b.addEventListener('click', () => stemsTransferTo(Number(b.dataset.xfer))));
$('#stemsPanel')?.addEventListener('input', e => { const f = e.target.closest('[data-stemfader]'); if (f) setStemFader(Number(f.dataset.stemdeck), Number(f.dataset.stemfader), f.value); });
// Reconstruye la estructura solo si cambia (decks con stems, mashup); si no,
// actualiza clases y textos para no cortar un arrastre en curso.
function hmStemsUI() {
  const bar = $('#hmStems'), panel = $('#stemsPanel');
  const show = handMode.active && handMode.effect === 'stems';
  const tg = $('#hmTarget'), tEff = ['roll', 'eco', 'brake'].includes(handMode.effect) ? handMode.effect : null;
  if (tg) {
    tg.hidden = !(handMode.active && tEff && stemsReady(handMode.deck));
    if (!tg.hidden) tg.querySelectorAll('[data-target]').forEach(b => { b.classList.toggle('on', Number(b.dataset.target) === (tEff === 'brake' ? brakeSel() : fxTarget(tEff))); if (b.dataset.target === '-2') b.hidden = tEff !== 'brake'; });
  }
  if (bar) {
    bar.hidden = !show;
    const st = decks[handMode.deck]?.stems, ready = stemsReady(handMode.deck);
    bar.querySelectorAll('[data-stem]').forEach(b => {
      const k = Number(b.dataset.stem);
      b.disabled = !ready; b.classList.toggle('muted', ready && st.muted[k]); b.classList.toggle('on', ready && !st.muted[k]);
      b.classList.toggle('sel', ready && handMode.stemSel?.deck === handMode.deck && handMode.stemSel.k === k);
    });
  }
  const tint = $('#roomTint'); if (tint) tint.hidden = !show;
  if (!panel) return;
  panel.hidden = !show;
  if (!show) { panel._key = ''; return; }
  const other = handMode.deck === 0 ? 1 : 0, mashup = stemsReady(handMode.deck) && stemsReady(other);
  panel.classList.toggle('mashup', mashup);
  const key = `${handMode.deck}|${mashup}|${decks.map(d => d.stems?.state).join(',')}`;
  const rebuild = panel._key !== key; panel._key = key;
  panel.querySelectorAll('.stems-deck').forEach(el => {
    const i = Number(el.dataset.deck), st = decks[i]?.stems;
    el.style.setProperty('--dc', i === 1 ? 'var(--b)' : 'var(--a)');
    if (rebuild) el.innerHTML = i === handMode.deck || mashup ? stemsDeckHTML(i) : '';
    if (!el.innerHTML || !st) return;
    const tt = el.querySelector('[data-title]'); if (tt) tt.textContent = stemsDeckTitle(i);
    const sb = el.querySelector('[data-sub]'); if (sb) sb.textContent = stemsDeckSub(i);
    el.querySelectorAll('.stem-pill').forEach(p => { const k = Number(p.dataset.stem); p.classList.toggle('muted', !!st.muted?.[k]); p.classList.toggle('on', !st.muted?.[k]); });
    el.querySelectorAll('[data-stemfader]').forEach(f => { if (!f.hasAttribute('data-grabbed') && document.activeElement !== f) f.value = st.muted[Number(f.dataset.stemfader)] ? 0 : st.levels[Number(f.dataset.stemfader)]; });
  });
  const ml = $('#mashupLabel'); if (ml) ml.hidden = !stemsMashup();
  stemsCrossUI();
  if (rebuild) rebuildRegistry();
}
// Entorno (solo en STEMS): la luz de la habitacion pasa de cian (A) a magenta
// (B) con el crossfader, y cada golpe de BATERIA da un pulso en los bordes.
const roomFx = { pulse: 0, prev: [0, 0] };
function drawRoomFx() {
  const el = $('#roomTint'); if (!el || el.hidden || !engine) return;
  const x = Number($('#cross')?.value || 0), a = (1 - x) / 2, b = 1 - a;
  // Bombo: subida brusca de energia del stem BATERIA de los decks que se oyen.
  let hit = 0;
  [0, 1].forEach(i => {
    const e = stemsReady(i) && engine.decks[i].playing ? engine.decks[i].stemEnergy(1) * (i ? b : a) : 0;
    if (e - roomFx.prev[i] > 0.18) hit = Math.max(hit, Math.min(1, e));
    roomFx.prev[i] = e;
  });
  roomFx.pulse = reducedMotion ? 0 : Math.max(hit, roomFx.pulse * 0.86);
  const p = roomFx.pulse;
  el.style.background = `linear-gradient(90deg, rgba(34,211,238,${(0.16 * a).toFixed(3)}), rgba(255,79,163,${(0.16 * b).toFixed(3)}))`;
  el.style.boxShadow = `inset 0 0 ${Math.round(60 + p * 120)}px ${Math.round(p * 40)}px rgba(251,146,60,${(p * 0.55).toFixed(3)})`;
}
// Ondas por stem alrededor del cabezal (12 s), atenuadas si el stem esta apagado.
function drawStemLanes() {
  document.querySelectorAll('#stemsPanel .stems-deck').forEach(el => {
    const i = Number(el.dataset.deck), st = decks[i]?.stems; if (!stemsReady(i) || !st.peaks) return;
    const ch = engine.decks[i], dur = ch.buffer?.duration || 1, pos = ch.position(), win = 12;
    el.querySelectorAll('canvas[data-lane]').forEach(cv => {
      const k = Number(cv.dataset.lane), pk = st.peaks[k], c = cv.getContext('2d'), w = cv.width, h = cv.height;
      c.clearRect(0, 0, w, h);
      const col = st.muted[k] ? '#3a434f' : STEM_COLORS[STEM_KEYS[k]], bars = 104;
      c.fillStyle = col;
      for (let b = 0; b < bars; b++) {
        const t = pos - win / 2 + (b / bars) * win; if (t < 0 || t > dur) continue;
        const v = pk[Math.min(pk.length - 1, Math.floor(t / dur * pk.length))] || 0;
        const bh = st.muted[k] ? 2 : Math.max(2, Math.min(1, v * 1.4) * (h - 6) * (ch.stemLevelNow(k) || 0.05));
        c.fillRect(b * (w / bars), (h - bh) / 2, w / bars - 1.5, bh);
      }
      c.fillStyle = 'rgba(255,255,255,.8)'; c.fillRect(w / 2 - 1, 0, 2, h);
    });
  });
  stemsCrossUI(); drawRoomFx();
  lastStemsDraw = performance.now();
}
// Sin camara (raton/tactil) el bucle de manos no dibuja: este reloj mantiene
// vivas ondas, crossfader y luces de la consola de stems.
let lastStemsDraw = 0;
setInterval(() => { if (handMode.active && handMode.effect === 'stems' && engine && performance.now() - lastStemsDraw > 120) drawStemLanes(); }, 60);
function updateGridUI(d) {
  // Solo lectura (Etapa 13): BPM estimado y estado de la rejilla, sin controles.
  const g = d.grid;
  d.el.querySelectorAll('.bpm').forEach(el => { el.textContent = g?.bpm ? `BPM ~${fmtEs(g.bpm, 1)} (estimado${g.ambiguous && g.bpm < 90 ? ' · posible fracción' : ''})` : 'BPM —'; });
  const st = d.el.querySelector('.gridstate');
  if (st) st.textContent = !g?.bpm ? 'Sin rejilla: este deck funciona sin SYNC de golpes ni eco al ritmo' : `Rejilla estimada · confianza ${g.confidence.toFixed(2)}${g.ambiguous ? (g.bpm < 90 ? ' · estimado · posible fracción (mitad o tercio)' : ' · tempo dudoso entre dos octavas') : ''} · mira la onda ampliada`;
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
  if (p === 'tempo') { const bpm = decks[i].bpm || 120; ch.setRate(bpm ? (1 + v / 100) : 1); decks[i].el.querySelector('.tempoval').textContent = fmtTempo(v); refreshEcoTimes(); }
  if (p === 'vol') { ch.fader.gain.setTargetAtTime(v, t, 0.03); ch.ecoFader.gain.setTargetAtTime(v, t, 0.03); }
  if (p === 'trim') ch.trim.gain.setTargetAtTime(v, t, 0.03);
  if (p === 'low') ch.low.gain.setTargetAtTime(v, t, 0.03);
  if (p === 'mid') ch.mid.gain.setTargetAtTime(v, t, 0.03);
  if (p === 'high') ch.high.gain.setTargetAtTime(v, t, 0.03);
  if (p === 'eco') { lastEcoDeck = i; ch.delaySend.gain.setTargetAtTime(v, t, 0.05); refreshEcoTimes(); }
  if (p === 'filter') { const f = filterFreqs(v); ch.filter.frequency.setTargetAtTime(f.lp, t, 0.03); ch.filterHp.frequency.setTargetAtTime(f.hp, t, 0.03); }
}
document.addEventListener('input', e => { if (e.target.matches('input[type=range][data-param]')) { if (e.target.dataset.param === 'tempo') { const nv = tempoDetent(Number(e.target.value)); if (nv !== Number(e.target.value)) e.target.value = nv; } setParam(e.target); } });
// SYNC encendido: queda iluminado hasta que alguien mueva un TEMPO o cambie la pista.
function setSyncLit(i, on) { decks[i]?.el.querySelector('.syncbtn')?.classList.toggle('sync-on', on); }
document.addEventListener('input', (e) => { if (e.target.classList?.contains('tempo')) { setSyncLit(0, false); setSyncLit(1, false); } });
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
    setSyncLit(i, true);
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
let deckQueues = emptyQueues(), libSort = { key: null, dir: 1 }, queueLoading = [false, false];
function deleteCue(i, p, btn) {
  const d = decks[i];
  if (d.hotcues[p] === null) { status(`El pad ${p + 1} del deck ${d.name} ya está vacío.`); return; }
  d.hotcues[p] = null;
  if (btn) { btn.classList.remove('set'); btn.textContent = padLabel(p); }
  drawWave(d);
  status(`Hot cue ${p + 1} del deck ${d.name} borrado. Un clic en el pad lo vuelve a guardar (reemplazar = borrar y guardar).`);
}
function renderQueue() {
  [0, 1].forEach(d => {
    const ol = $(d === 0 ? '#queueA' : '#queueB'); if (!ol) return;
    ol.innerHTML = '';
    deckQueues[d].forEach((t, ix) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="qn">${ix + 1}</span><span class="tt" title="${t.name.replace(/"/g, '&quot;')}">${displayTrackName(t.name)}</span><button class="btn small" data-mv="-1" title="Subir">▲</button><button class="btn small" data-mv="1" title="Bajar">▼</button><button class="btn small" data-rm title="Quitar de la cola">✕</button>`;
      li.querySelectorAll('[data-mv]').forEach(b => b.onclick = () => { deckQueues = moveAt(deckQueues, d, ix, Number(b.dataset.mv)); renderQueue(); renderLibrary(); });
      li.querySelector('[data-rm]').onclick = () => { deckQueues = removeAt(deckQueues, d, ix); renderQueue(); renderLibrary(); };
      ol.appendChild(li);
    });
    if (!deckQueues[d].length) ol.innerHTML = `<li class="empty">vacía · usa +${'AB'[d]} en la lista</li>`;
    // «SIGUE:» en la cabecera del deck.
    const nu = decks[d].el.querySelector('.nextup'), nx = deckQueues[d][0];
    if (nu) { nu.hidden = !nx; nu.textContent = nx ? `⏭ SIGUE: ${displayTrackName(nx.name)}${deckQueues[d].length > 1 ? ` (+${deckQueues[d].length - 1})` : ''}` : ''; }
  });
  const n = deckQueues[0].length + deckQueues[1].length;
  $('#queueInfo').textContent = n ? 'Cuando un deck queda libre (su tema terminó o mezclaste al otro lado), se carga solo el siguiente de su cola, sin darle PLAY.' : 'Prepara el lineup: +A o +B en cada tema, en el orden en que quieras que suenen.';
}
// ⏭ SIGUE en la cabecera del deck: carga ya el siguiente de su cola. Si el
// deck suena, pide confirmacion (igual que LOAD) antes de reemplazar.
function loadNextFor(i) {
  const taken = takeFromDeck(deckQueues, i);
  if (!taken.track) { status(`La cola ${'AB'[i]} está vacía: usa +${'AB'[i]} en la biblioteca.`); return; }
  if (queueLoading[i]) return;
  queueLoading[i] = true;
  loadToDeck(i, taken.track, false).then(ok => {
    queueLoading[i] = false;
    if (ok) { deckQueues = dropTrack(deckQueues, taken.track); status(`Deck ${'AB'[i]}: cargado «${displayTrackName(taken.track.name)}» desde su cola (no suena hasta PLAY).`); }
    renderQueue(); renderLibrary();
  });
}
decks.forEach((d, i) => d.el.querySelector('.nextup')?.addEventListener('click', () => loadNextFor(i)));
// Marca «sonó» como Serato: el deck suena con su canal abierto y el crossfader de su lado.
function markPlayed() {
  if (!engine) return;
  decks.forEach((d, i) => {
    const ch = engine.decks[i], t = d.track; if (!t) { d._wasPlaying = false; return; }
    // «Mezclado afuera»: se paro (o lo paro el ECO/Auto DJ) con el crossfader del
    // otro lado. Si despues lo vuelves a mover o a tocar, deja de estarlo: lo preparaste.
    if (ch.playing) { t._ended = false; t._mixedOut = false; }
    else if (d._wasPlaying && t.played && ch.xGain.gain.value < 0.1) { t._mixedOut = true; t._mixedPos = ch.position(); }
    else if (t._mixedOut && Math.abs(ch.position() - (t._mixedPos ?? 0)) > 0.05) t._mixedOut = false;
    d._wasPlaying = ch.playing;
    if (!t.played && ch.playing && ch.xGain.gain.value > 0.5 && ch.fader.gain.value > 0.05) { t.played = true; renderLibrary(); }
  });
}
// Carga el siguiente de la cola de cada deck libre (nunca pisa lo que suena
// ni una pista preparada que aun no sono). manual = boton «Cargar siguientes».
function serviceDeckQueues(manual) {
  let loaded = 0;
  [0, 1].forEach(i => {
    if (queueLoading[i] || !deckQueues[i].length) return;
    const d = decks[i], ch = engine?.decks[i];
    const pos = ch && d.track ? ch.position() : 0, dur = d.track?.buffer?.duration || 0;
    const free = deckFree({ hasTrack: !!d.track, playing: !!ch?.playing, played: !!d.track?.played, ended: !!d.track && (!!d.track._ended || pos >= dur - 0.5), crossAway: !!ch && ch.xGain.gain.value < 0.1 && !!d.track?._mixedOut });
    if (!free && !(manual && !ch?.playing && !d.track)) return;
    const taken = takeFromDeck(deckQueues, i); if (!taken.track) return;
    deckQueues = taken.queues; queueLoading[i] = true; loaded++;
    loadToDeck(i, taken.track, true).then(ok => {
      queueLoading[i] = false;
      if (ok) status(`Cola ${'AB'[i]}: «${displayTrackName(taken.track.name)}» cargada en el deck ${'AB'[i]} (no suena hasta PLAY o Auto DJ).`);
      else deckQueues = addToDeck(deckQueues, i, taken.track);
      renderQueue(); renderLibrary();
    });
  });
  if (manual && !loaded) status('Ningún deck libre con cola: un deck se considera libre si no tiene pista, o si su tema ya sonó y terminó o mezclaste al otro lado.');
  if (loaded) renderQueue();
}
// ---------- Demo guiada y guardarraíl de graves (P4) ----------
const DEMO_STEPS = [
  '1. Pulsa «Activar audio» y luego «Cargar demos»: son dos pistas generadas por la app, sin música con derechos.',
  '2. Carga la Demo A con LOAD A (o desde PISTAS en el deck) y pulsa PLAY. Haz lo mismo con la Demo B en el otro deck, sin darle a PLAY todavía.',
  '3. Activa la cámara y los gestos. Haz una pinza sobre el CROSSFADER y muévela: mezclas con la mano, sin tocar el ratón.',
  '4. En Vista fácil, pulsa «Igualar y mezclar»: iguala el tempo y hace la mezcla suave sola. En Vista DJ, el botón SYNC hace el tempo y la fase.',
  '5. Prueba una perilla con la pinza: apunta al LOW, pinza y arrastra en horizontal. La barra muestra el valor y al soltar se queda.',
  '6. Busca con el jog: gira el centro del jog del deck parado para oír la pista hacia delante y hacia atrás; gira el borde para empujar el tempo.',
  '7. Termina grabando: pulsa «Grabar mezcla», haz una mezcla corta y vuelve a pulsar para descargar el archivo. ¡Fin de la demo!'
];
let demoIx = -1;
function demoShow() { $('#demoGuide').hidden = demoIx < 0; if (demoIx >= 0) $('#demoStep').textContent = DEMO_STEPS[demoIx]; }
$('#btnDemoGuide').onclick = () => { demoIx = 0; demoShow(); status('Demo guiada: sigue los pasos en pantalla. No cambia el audio por ti.'); };
$('#demoNext').onclick = () => { demoIx = Math.min(DEMO_STEPS.length - 1, demoIx + 1); demoShow(); };
$('#demoPrev').onclick = () => { demoIx = Math.max(0, demoIx - 1); demoShow(); };
$('#demoExit').onclick = () => { demoIx = -1; demoShow(); };
function checkBassWarn() {
  const bw = $('#bassWarn'); if (!bw) return;
  const low = i => Number(document.querySelector(`input.knob-state[data-param="low"][data-deck="${i}"]`)?.value || 0);
  bw.style.visibility = bassClash(low(0), low(1), Number($('#cross')?.value || 0)) ? 'visible' : 'hidden';
}
// ---------- Selector PISTAS a pantalla completa (P3.5.b) ----------
const picker = { deck: 0, start: 0, pageSize: 7, selectedId: null, holdTimer: null, lastActivityAt: 0, gestureHold: null, palmsSince: null };
function saveOrder() { try { localStorage.setItem('motiondj-order', JSON.stringify(library.map(t => t.name))); } catch {} }
function applySavedOrder() { try { const ord = JSON.parse(localStorage.getItem('motiondj-order') || '[]'); library.sort((a, b) => { const ia = ord.indexOf(a.name), ib = ord.indexOf(b.name); return (ia < 0 ? 9999 : ia) - (ib < 0 ? 9999 : ib); }); } catch {} }
function openTrackPicker(i) {
  picker.deck = i; picker.start = 0; picker.selectedId = null;
  picker.lastActivityAt = performance.now(); picker.gestureHold = null; picker.palmsSince = null;
  $('#trackPicker').hidden = false; document.body.classList.add('picker-open');
  $('#pickerTitle').textContent = `Elegir pista para el deck ${'AB'[i]}`;
  renderPicker(); rebuildRegistry();
}
function closeTrackPicker(why = '') {
  $('#trackPicker').hidden = true; document.body.classList.remove('picker-open');
  if (picker.holdTimer) { clearTimeout(picker.holdTimer); picker.holdTimer = null; }
  picker.gestureHold = null; picker.palmsSince = null;
  if (why) status(why);
  rebuildRegistry();
}
function renderPicker() {
  const list = $('#pickerList'); if (!list) return;
  const total = library.length;
  picker.start = Math.max(0, Math.min(picker.start, Math.max(0, total - picker.pageSize)));
  list.innerHTML = '';
  library.slice(picker.start, picker.start + picker.pageSize).forEach((t, off) => {
    const ix = picker.start + off, b = document.createElement('button');
    b.className = 'pickcard' + (picker.selectedId === t.id ? ' sel' : '');
    b.dataset.trackId = t.id;
    b.innerHTML = `<span class="num">${ix + 1}</span><span>${displayTrackName(t.name)}${t.duration ? ` · ${fmt(t.duration)}` : ''}${t.metaBpm ? ` · ~${t.metaBpm.toFixed(0)} BPM` : ''}</span>${queueTag(deckQueues, t) ? `<span class="tagq">cola ${queueTag(deckQueues, t)}</span>` : ''}${decks.map((d, di) => d.track === t ? `<span class="tagdeck">${'AB'[di]}${engine?.decks[di].playing ? ' (sonando)' : ''}</span>` : '').join('')}<span class="holdbar"><i></i></span>`; b.title = t.name;
    const choose = async () => {
      picker.selectedId = t.id;
      const ok = await loadToDeck(picker.deck, t, engine?.decks[picker.deck].playing);
      if (ok) closeTrackPicker();
    };
    b.addEventListener('pointerdown', () => {
      picker.selectedId = t.id; renderPickerSel();
      if (engine?.decks[picker.deck].playing) {
        b.classList.add('holding');
        $('#pickerHint').textContent = `Mantén para reemplazar el deck ${'AB'[picker.deck]} (está sonando)…`;
        picker.holdTimer = setTimeout(choose, 1000);
      }
    });
    b.addEventListener('pointerup', () => { if (picker.holdTimer) { clearTimeout(picker.holdTimer); picker.holdTimer = null; b.classList.remove('holding'); } else if (!engine?.decks[picker.deck].playing) { b._choseAt = Date.now(); choose(); } else { picker.selectedId = t.id; } });
    b.addEventListener('click', () => { if (Date.now() - (b._choseAt || 0) > 400 && !engine?.decks[picker.deck].playing) choose(); }); // pinza/clic sintetico
    b.addEventListener('pointerleave', () => { if (picker.holdTimer) { clearTimeout(picker.holdTimer); picker.holdTimer = null; b.classList.remove('holding'); } });
    list.appendChild(b);
  });
  const rg = $('#pickerRange'); rg.max = Math.max(0, total - 1); rg.value = picker.start;
  $('#pickerPos').textContent = total ? `pista ${picker.start + 1}–${Math.min(total, picker.start + picker.pageSize)} de ${total}` : 'sin pistas: importa música o elige una carpeta';
  rebuildRegistry();
}
function renderPickerSel() { document.querySelectorAll('.pickcard').forEach((c, ix) => c.classList.toggle('sel', library[picker.start + ix]?.id === picker.selectedId)); }
$('#pickerRange')?.addEventListener('input', e => { picker.start = Number(e.target.value); renderPicker(); });
$('#pickerPrev').onclick = () => { picker.start -= picker.pageSize; renderPicker(); };
$('#pickerNext').onclick = () => { picker.start += picker.pageSize; renderPicker(); };
$('#pickerClose').onclick = () => closeTrackPicker();
$('#pickerBackBig')?.addEventListener('click', () => closeTrackPicker('Selector cerrado: no se cargó ninguna pista.'));
$('#trackPicker')?.addEventListener('pointermove', () => { picker.lastActivityAt = performance.now(); });
$('#trackPicker')?.addEventListener('pointerdown', () => { picker.lastActivityAt = performance.now(); });
function moveSelected(dir) {
  const ix = library.findIndex(t => t.id === picker.selectedId);
  if (ix < 0) { $('#pickerHint').textContent = 'Primero toca una pista para elegirla y luego muévela con ▲/▼ orden.'; return; }
  const jx = ix + dir; if (jx < 0 || jx >= library.length) return;
  [library[ix], library[jx]] = [library[jx], library[ix]];
  picker.start = Math.max(0, Math.min(picker.start, jx)); saveOrder(); renderPicker(); renderLibrary();
}
$('#pickerUp').onclick = () => moveSelected(-1);
$('#pickerDown').onclick = () => moveSelected(1);
// ---------- Carpeta de musica persistente (P3.5.a, IndexedDB) ----------
function idbSet(key, val) { return new Promise(res => { const rq = indexedDB.open('motiondj', 1); rq.onupgradeneeded = () => rq.result.createObjectStore('kv'); rq.onsuccess = () => { const tx = rq.result.transaction('kv', 'readwrite'); tx.objectStore('kv').put(val, key); tx.oncomplete = () => res(true); }; rq.onerror = () => res(false); }); }
function idbGet(key) { return new Promise(res => { const rq = indexedDB.open('motiondj', 1); rq.onupgradeneeded = () => rq.result.createObjectStore('kv'); rq.onsuccess = () => { const g = rq.result.transaction('kv').objectStore('kv').get(key); g.onsuccess = () => res(g.result || null); g.onerror = () => res(null); }; rq.onerror = () => res(null); }); }
async function scanFolder(handle) {
  let count = 0;
  for await (const entry of handle.values()) {
    if (entry.kind === 'file' && /\.(mp3|wav|ogg|m4a|flac)$/i.test(entry.name) && !library.some(t => t.name === entry.name)) {
      library.push({ id: crypto.randomUUID(), name: entry.name, handle: entry, buffer: null, duration: null }); count++;
    }
  }
  applySavedOrder(); renderLibrary();
  $('#libMsg').textContent = count ? `Carpeta abierta: ${count} pista(s) nuevas en la lista (se decodifican al cargarlas).` : 'Carpeta abierta: sin pistas nuevas que añadir.';
}
$('#btnFolder')?.addEventListener('click', async () => {
  if (!window.showDirectoryPicker) { $('#libMsg').textContent = 'Este navegador no permite elegir una carpeta (sin File System Access): usa «Importar música». Chrome/Edge de escritorio sí.'; return; }
  try {
    const handle = await window.showDirectoryPicker();
    await idbSet('folder', handle);
    await scanFolder(handle);
  } catch { /* cancelado por el usuario */ }
});
$('#btnFolderOpen')?.addEventListener('click', async () => {
  const handle = await idbGet('folder');
  if (!handle) { $('#libMsg').textContent = 'Todavía no hay carpeta guardada: elige una con «Elegir carpeta».'; return; }
  try {
    if (await handle.requestPermission({ mode: 'read' }) !== 'granted') { $('#libMsg').textContent = 'Sin permiso para la carpeta guardada: concédelo o elige otra.'; return; }
    await scanFolder(handle);
  } catch { $('#libMsg').textContent = 'La carpeta guardada ya no está disponible (¿movida o disco desconectado?). Elige otra.'; }
});
$('#btnNextTrack')?.addEventListener('click', () => serviceDeckQueues(true));
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
    if (e.target.closest?.('[data-manos]')) { openHandModeIntro(i); return; }
    if (e.target.classList.contains('cuephones')) { toggleCue(i, e.target); return; }
    if (e.target.classList.contains('pistasbtn')) { openTrackPicker(i); return; }
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
    const distC = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
    startScratch('mouse' + i, i, e.clientY, distC > r.width * 0.36); // borde = empuje; plato = busqueda
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
    const b = d.el.querySelector('.play'); const ico = b.querySelector('.play-ico'); if (ico) ico.textContent = playing ? '❚❚' : '▶'; b.classList.toggle('play-on', !!playing); b.setAttribute('aria-label', `${playing ? 'Pausar' : 'Reproducir'}, Deck ${d.name}`);
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
// ---------- Mesa holografica 3D (prueba, apagada por defecto) ----------
var holo = { on: false, angle: 20 }; // var: applyCal puede correr antes de esta linea
try { const h = JSON.parse(localStorage.getItem('motiondj-3d') || 'null'); if (h) { holo.on = !!h.on; holo.angle = Math.min(40, Math.max(5, Number(h.angle) || 20)); } } catch { /* valor corrupto: 3D apagado */ }
function applyHolo(save = true) {
  document.body.dataset.holo = holo.on ? '1' : '0';
  const b = $('#btn3d'); if (b) { b.setAttribute('aria-pressed', String(holo.on)); b.textContent = holo.on ? '3D: ON' : '3D'; }
  const c = $('#cal3d'); if (c) c.checked = holo.on;
  const a = $('#cal3dAngle'); if (a) a.value = holo.angle;
  const v = $('#cal3dVal'); if (v) v.textContent = holo.angle;
  if (save) localStorage.setItem('motiondj-3d', JSON.stringify(holo));
  if (typeof applyCal === 'function') applyCal(false);
  requestAnimationFrame(() => { if (typeof hands !== 'undefined') hands.forEach(h => { h.smoothX.reset(); h.smoothY.reset(); }); if (typeof rebuildRegistry === 'function') rebuildRegistry(); });
}
function applyCal(save = true) {
  const s = $('#calScale').value, x = $('#calX').value, y = $('#calY').value;
  // Mesa holografica 3D (prueba): la inclinacion va al final del transform.
  // Los gestos siguen sirviendo porque rebuildRegistry usa getBoundingClientRect,
  // que ya devuelve la caja proyectada de cada control.
  const tilt = holo && holo.on && window.innerWidth > 640 ? ` rotateX(${holo.angle}deg)` : '';
  consoleEl.style.transform = `translateX(calc(-50% + ${x}px)) scale(${s * consoleFit})${tilt}`;
  consoleEl.style.bottom = `calc(3% + ${-y}px)`;
  document.documentElement.style.setProperty('--ctl', $('#calSize').value);
  document.documentElement.style.setProperty('--alpha', $('#calOpacity')?.value || 0.86);
  const kv = $('#calKnobVal'); if (kv) kv.textContent = $('#calKnob')?.value || 220;
  if (save) localStorage.setItem('motiondj-cal', JSON.stringify({ s, x, y, size: $('#calSize').value, sens: $('#calSens').value, knob: $('#calKnob')?.value || 220 }));
}
try { const c = sanitizeCal(JSON.parse(localStorage.getItem('motiondj-cal') || 'null')); $('#calScale').value = c.s; $('#calX').value = c.x; $('#calY').value = c.y; $('#calSize').value = c.size; $('#calSens').value = c.sens; if ($('#calKnob')) $('#calKnob').value = c.knob; } catch { /* calibracion corrupta: se ignoran los valores y se usan los de fabrica */ }
// Restablecer (P1): calibracion y mezclador a fabrica, sin recargar y sin
// tocar las pistas cargadas ni lo que esta sonando.
function resetAll() {
  const c = RESET_DEFAULTS.cal;
  $('#calScale').value = c.scale; $('#calX').value = c.x; $('#calY').value = c.y; $('#calSens').value = c.sens; $('#calSize').value = c.size; if ($('#calKnob')) $('#calKnob').value = c.knob;
  localStorage.removeItem('motiondj-cal'); applyCal(false);
  document.querySelectorAll('input[data-param]').forEach(inp => {
    const p = inp.dataset.param;
    if (!(p in RESET_DEFAULTS.params)) return;
    inp.value = RESET_DEFAULTS.params[p];
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  });
  decks.forEach(d => { const tv = d.el.querySelector('.tempoval'); if (tv) tv.textContent = fmtTempo(0); });
  syncAllKnobs(); fitConsole();
  status('Restablecido: calibración y mezclador a valores de fábrica. Las pistas y la música no se tocaron.');
}
['calScale', 'calX', 'calY', 'calSize', 'calSens', 'calHit', 'calOpacity', 'calKnob'].forEach(id => { const el = $('#' + id); if (el) el.addEventListener('input', () => applyCal()); });
// ---------- Vistas Facil / DJ (mismo estado y motor; solo cambia visibilidad) ----------
function setView(v) { requestAnimationFrame(() => { if (typeof hands !== 'undefined') hands.forEach(h => { h.smoothX.reset(); h.smoothY.reset(); }); if (typeof fitConsole === 'function') fitConsole(); if (typeof rebuildRegistry === 'function') rebuildRegistry(); });
  document.body.dataset.view = v;
  $('#btnViewEasy').setAttribute('aria-pressed', v === 'easy'); $('#btnViewDJ').setAttribute('aria-pressed', v === 'dj');
  localStorage.setItem('motiondj-view', v);
}
$('#btnViewEasy').onclick = () => setView('easy'); $('#btnViewDJ').onclick = () => setView('dj');
setView(localStorage.getItem('motiondj-view') || 'dj');
$('#btn3d').onclick = () => { holo.on = !holo.on; applyHolo(); };
$('#cal3d').onchange = e => { holo.on = e.target.checked; applyHolo(); };
$('#cal3dAngle').oninput = e => { holo.angle = Number(e.target.value); applyHolo(); };
applyHolo(false);
applyCal(false);
let locked = false;
$('#btnReset').onclick = () => resetAll();
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
  if ($('#autoDjEnabled').checked && plan0.active !== null && plan0.next !== null) serviceDeckQueues(false);
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
$('#autoDjEnabled').onchange = () => { $('#autoDjEnabled').closest('.autodj-toggle')?.classList.toggle('on', $('#autoDjEnabled').checked); if (!$('#autoDjEnabled').checked) { cancelAutoDj(); return; } autoDjLastKey = null; const p = autoDjPlanNow(); autoDjRender(p); if ($('#autoDjEnabled').checked) { $('#autoDjStatus').textContent = p.reason; status(`AUTO DJ encendido: ${p.reason}`); } };
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
// Suavizado One Euro: quieto no tiembla, rapido responde sin retraso.
function euroAxis() { const f = new OneEuroFilter({ minCutoff: 1.0, beta: 0.007, dCutoff: 1.0 }); return { update: v => f.filter(v, performance.now()), reset: () => f.reset() }; }
// Controles pequenos a los que el cursor se pega (no ondas, no jogs ni tarjetas grandes).
function magnetTargets() {
  const out = [], pickerOpen = !$('#trackPicker').hidden;
  for (const c of registry.controls.values()) {
    if (c.disabled || c.z === 0 || Math.max(c.rect.w, c.rect.h) > 150) continue;
    if (handMode.active ? !c.el.closest('#handModeBar, #gestureIntro, #stemsPanel') : pickerOpen ? !c.el.closest('#trackPicker') : false) continue;
    out.push({ id: c.id, ...c.rect });
  }
  return out;
}
const hands = [0, 1].map(() => ({ pinch: new PinchDetector(), smoothX: euroAxis(), smoothY: euroAxis(), posHist: new ValueHistory({ keepMs: 400 }), focus: new StickyFocus({ switchMs: 120 }), seen: 0, el: null, needRelease: true, wrist: null, missingSince: null }));
let mirrored = true;
function rebuildRegistry() {
  registry.controls.clear();
  const pad = Number($('#calHit')?.value || 16), sr = stage.getBoundingClientRect();
  // TODOS los controles de la mesa: sliders, botones (PLAY/CUE/SYNC/LOOP/pads/modo) y onda.
  document.querySelectorAll('.console [data-g], .console button, .console .wave, #fxPalette [data-fx-card], #trackPicker .pickcard, #trackPicker [data-g], #trackPicker button, #handModeBar button, #handModeBar input, #gestureIntro .g-card, #stemsPanel .stem-pill, #stemsPanel input, #stemsPanel .stems-xbtn').forEach((el, idx) => {
    const r = el.getBoundingClientRect();
    if (!r.width) return;
    if (!el._gid) el._gid = `ctl-${idx}-${el.dataset.param || el.dataset.act || el.className}`;
    const base = { x: r.left - sr.left - stage.clientLeft, y: r.top - sr.top - stage.clientTop, w: r.width, h: r.height };
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
const knobDrags = new Map();
function knobInput(knob) { return knob?.closest('.knobwrap')?.querySelector('.knob-state') || null; }
function knobPx() { return Number($('#calKnob')?.value || 220); }
function fmtKnobVal(inp, v) {
  const p = inp.dataset.param;
  if (p === 'trim') return fmtTrimDb(v); // ganancia real en dB
  if (p === 'filter') return fmtFilter(v); // Neutro / LP nn % / HP nn %
  if (inp.dataset.display === 'pct') return fmtPct(v / (Number(inp.max) || 1) * 100);
  if (inp.dataset.unit === 'dB') return fmtDb(v);
  return fmtEs(v, 0);
}
function syncKnob(knob) {
  const inp = knobInput(knob); if (!inp) return;
  const v = Number(inp.value), mn = Number(inp.min), mx = Number(inp.max), f = knobPos01(v, mn, mx);
  const dragging = [...knobDrags.values()].some(d => d.knob === knob), key = v + '|' + dragging + '|' + (document.activeElement === knob);
  if (knob._syncKey === key) return; knob._syncKey = key;
  knob.style.setProperty('--ang', knobAngle(v, mn, mx) + 'deg');
  knob.style.setProperty('--frac', f);
  const kv = knob.closest('.knobwrap')?.querySelector('.knobval');
  if (kv) { kv.textContent = fmtKnobVal(inp, v); kv.classList.toggle('active', [...knobDrags.values()].some(d => d.knob === knob) || document.activeElement === knob); }
}
function syncAllKnobs() { document.querySelectorAll('.knob').forEach(syncKnob); }
syncAllKnobs(); // valores bajo cada perilla visibles desde el arranque
// Sin barra flotante de valor: la unica lectura es la de debajo de la
// perilla, que se resalta mientras se arrastra o tiene el foco.
function startKnobDrag(knob, x, hand) {
  const inp = knobInput(knob); if (!inp) return false;
  knobDrags.set(hand, { knob, input: inp, hand, startValue: Number(inp.value), startX: x });
  syncKnob(knob);
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
  const gone = hand !== undefined ? [knobDrags.get(hand)] : [...knobDrags.values()];
  if (hand !== undefined) knobDrags.delete(hand); else knobDrags.clear();
  gone.forEach(d => { if (d?.knob) syncKnob(d.knob); });
  syncAllKnobs();
}
function endAllKnobs() { endKnobDrag(); }
document.querySelectorAll('.knob').forEach(knob => {
  const inp = knobInput(knob);
  knob.addEventListener('pointerdown', e => { e.preventDefault(); knob.focus(); try { knob.setPointerCapture(e.pointerId); } catch {} startKnobDrag(knob, e.clientX, 'mouse'); });
  knob.addEventListener('pointermove', e => { if (knobDrags.get('mouse')?.knob === knob) moveKnobDrag('mouse', e.clientX); });
  knob.addEventListener('pointerup', () => endKnobDrag('mouse'));
  knob.addEventListener('pointercancel', () => endKnobDrag('mouse'));
  knob.addEventListener('focus', () => syncKnob(knob));
  knob.addEventListener('blur', () => syncKnob(knob));
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
    if (nv !== null) { e.preventDefault(); inp.value = Math.min(Number(inp.max), Math.max(Number(inp.min), nv)); inp.dispatchEvent(new Event('input', { bubbles: true })); syncKnob(knob); }
  });
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
// ---------- Jog: busqueda/scrub (plato), empuje (borde) y respaldo ----------
// El plato usa el AudioWorklet de scrub (P3.a): suena hacia delante y hacia
// atras con posicion continua. El borde aplica un empuje temporal de
// velocidad y al soltar vuelve EXACTAMENTE al rate previo. Si el worklet no
// carga, queda el scratch minimo anterior por velocidad (solo hacia delante).
const scrubWorkletUrl = '/worklets/scrub-processor.js'; // en public/: URL real para audioWorklet.addModule
import { jogSpeed, nudgeFactor } from '../audio/scrub.js';
const scratches = new Map();
function jogSecPerRev() { return Number($('#calJogSec')?.value || 1.8); }
function startScratch(key, i, y, rim = false) {
  if (i < 0 || !engine) return;
  ensureEngine(); const ch = engine.decks[i];
  if (!ch.buffer || scratches.has(key)) return;
  if (rim) {
    scratches.set(key, { deck: i, mode: 'nudge', baseRate: ch.rate, lastY: y, lastT: performance.now(), rev: 0 });
    status(`Empuje deck ${decks[i].name}: gira el borde para empujar el tempo; al soltar vuelve solo a su sitio.`);
    return;
  }
  if (ch.scrubNode && ch.startScrub()) {
    scratches.set(key, { deck: i, mode: 'scrub', baseRate: ch.rate, wasPaused: !ch._scrubWasPlaying, lastY: y, lastT: performance.now(), rev: 0 });
    status(`Búsqueda deck ${decks[i].name}: gira el plato para buscar el punto (suena en ambos sentidos); suelta para dejarlo ahí.`);
    return;
  }
  const wasPaused = !ch.playing;
  if (wasPaused) ch.play();
  scratches.set(key, { deck: i, mode: 'legacy', baseRate: ch.rate, wasPaused, lastY: y, lastT: performance.now(), rev: 0 });
  status(`Scratch (respaldo) deck ${decks[i].name}: el worklet no cargó; solo hacia delante.`);
}
function applyScratchRev(key, rev) {
  const s = scratches.get(key); if (!s || !engine) return;
  s.rev = 0.55 * rev + 0.45 * s.rev;
  const ch = engine.decks[s.deck];
  if (s.mode === 'scrub') ch.setScrubSpeed(jogSpeed(s.rev, jogSecPerRev()));
  else if (s.mode === 'nudge') ch.setRate(s.baseRate * nudgeFactor(s.rev));
  else ch.setRate(scratchRate(s.rev, s.baseRate));
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
  if (s.mode === 'scrub') {
    ch.endScrub();
    if (s.wasPaused && $('#calSnap')?.checked && decks[s.deck].grid) ch.seek(quantizeToBeat(ch.position(), decks[s.deck].grid));
  }
  else if (s.mode === 'nudge') ch.setRate(s.baseRate); // regreso exacto
  else if (s.wasPaused) ch.pause();
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
const CAM_KEY = 'motiondj.camera';
function savedCam() { try { return localStorage.getItem(CAM_KEY) || ''; } catch { return ''; } }
function camLabel() {
  const s = video.srcObject?.getVideoTracks?.()[0]?.getSettings?.() || {};
  return s.width ? ` · ${s.width}×${s.height}` : '';
}
async function fillCamSelect() {
  const sel = $('#camSelect'); if (!sel) return;
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
  const cur = video.srcObject?.getVideoTracks?.()[0]?.getSettings?.().deviceId;
  sel.innerHTML = cams.map((d, i) => `<option value="${d.deviceId}">${(d.label || `Cámara ${i + 1}`).replace(/</g, '&lt;')}</option>`).join('');
  if (cur) sel.value = cur;
  sel.hidden = cams.length < 2;
}
async function enableCamera() {
  try {
    const want = savedCam();
    try { await startCamera(video, want || undefined); }
    catch (e) { if (!want) throw e; await startCamera(video); } // la cámara guardada ya no existe
    $('#noCam').style.display = 'none'; $('#chipCam').textContent = 'Cámara: activa' + camLabel(); $('#chipCam').classList.add('on');
    fillCamSelect().catch(() => {});
    if (tracker) { status('Cámara activa.' + camLabel()); return; }
    status('Cámara activa. Cargando el modelo de manos local…');
    tracker = await createHandTracker(video, () => status('El modelo de manos no pudo cargar ni en local ni desde el CDN. La mesa sigue usable con mouse, teclado y táctil.'));
    status(tracker ? 'Manos listas. Activa Gestos y haz una pinza sobre un control.' : 'Sin seguimiento de manos; mouse/teclado activos.');
  } catch (e) {
    if (!navigator.mediaDevices?.getUserMedia) status('Este navegador no permite usar la cámara (sin getUserMedia o sin HTTPS). La mesa sigue completa con mouse, teclado y táctil.');
    else if (e?.name === 'NotAllowedError') status('Permiso de cámara denegado: permite la cámara en el candado de la barra de direcciones y vuelve a pulsar «Activar cámara». Sin cámara, todo funciona con mouse/teclado.');
    else if (e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError') status('No se encontró cámara en este equipo. Conecta una (o DroidCam) y reintenta; mientras, mouse/teclado/táctil funcionan.');
    else status(`La cámara no arrancó (${e?.name || 'error'}). Revisa que ninguna otra app la esté usando; la mesa sigue con mouse/teclado.`);
  }
}
$('#gCamera').onclick = enableCamera; $('#btnCam2').onclick = enableCamera;
$('#camSelect')?.addEventListener('change', async (e) => {
  try { localStorage.setItem(CAM_KEY, e.target.value); } catch {}
  try { await startCamera(video, e.target.value); $('#chipCam').textContent = 'Cámara: activa' + camLabel(); status('Cámara cambiada.' + camLabel()); }
  catch (err) { status(`No se pudo abrir esa cámara (${err?.name || 'error'}). ¿La está usando otra app?`); fillCamSelect().catch(() => {}); }
});
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
  if (!gesturesOn) { registry.releaseAll(); endKnobDrag(); endAllScratches(); two.reset(); freezeExpressive('Gestos pausados.'); if (fx.freeze()) fxRender(); if (handMode.active) exitHandMode('Modo manos cerrado al pausar los gestos: filtro a Neutro.'); document.querySelectorAll('[data-focus]').forEach(el => el.removeAttribute('data-focus')); $('#focusTag').hidden = true; }
};
$('#btnDiag').onclick = e => { diag = !diag; e.target.setAttribute('aria-pressed', diag); if (!diag) overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height); };
$('#btnGuide').onclick = () => { guideForced = true; const g = $('#guide'); g.hidden = false; g.scrollIntoView({ behavior: 'smooth' }); $('#menuHelp').open = false; };
$('#btnDemoGuide')?.addEventListener('click', () => { $('#menuHelp').open = false; });
// Ajustes: panel lateral; menus de la barra se cierran al elegir o al hacer clic fuera.
function setSettings(open) { $('#settingsDrawer').hidden = !open; $('#btnSettings').setAttribute('aria-expanded', String(open)); }
$('#btnSettings').onclick = () => setSettings($('#settingsDrawer').hidden);
$('#btnSettingsClose').onclick = () => setSettings(false);
document.addEventListener('click', e => { document.querySelectorAll('.topbar details.menu[open]').forEach(d => { if (!d.contains(e.target)) d.open = false; }); });
// La guia de 5 pasos se esconde sola con el audio y la camara ya activos.
let guideForced = false;
function updateGuide() { const g = $('#guide'); if (!g || guideForced) return; const camOn = !!video.srcObject?.getVideoTracks?.().some(t => t.readyState === 'live'); g.hidden = !!engine && camOn; }
// Pantalla completa SOLO del escenario (camara + consola o Modo manos encima),
// sin la barra superior ni la biblioteca: para grabar la demo. Esc o F para salir.
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else stage.requestFullscreen?.().catch(() => status('El navegador no permitió la pantalla completa: prueba con F11.'));
}
$('#btnFullscreen')?.addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', () => {
  const on = !!document.fullscreenElement, b = $('#btnFullscreen');
  if (b) { b.setAttribute('aria-pressed', String(on)); b.textContent = on ? '⛶ Salir de pantalla completa' : '⛶ Pantalla completa'; }
  // Recalcular encuadre, cursores y zonas de pinza con el tamaño nuevo.
  setTimeout(() => window.dispatchEvent(new Event('resize')), 120);
});
document.addEventListener('keydown', e => {
  if (e.target.matches('input,select,textarea')) return;
  const k = e.key.toLowerCase();
  if (k === 'q') deckAction(0, 'play'); if (k === 'a') deckAction(0, 'cue', decks[0].el.querySelector('.cue'));
  if (k === 'p') deckAction(1, 'play'); if (k === 'l') deckAction(1, 'cue', decks[1].el.querySelector('.cue'));
  if (k === 'g') $('#btnGestures').click();
  if (k === 'f') toggleFullscreen();
  if (k === 'enter' && fx.state === 'palette') { fx.prepare(fxCurrentValue()); fxRender(); }
  if (k === 'escape') {
    if (handMode.active) { exitHandMode('Modo manos cerrado: filtro de vuelta a Neutro.'); return; }
    if (!$('#trackPicker').hidden) { closeTrackPicker(); return; }
    if (lastUndoLoad && engine && !engine.decks[lastUndoLoad.deck].playing && lastUndoLoad.prev) { const { deck, prev } = lastUndoLoad; lastUndoLoad = null; loadToDeck(deck, prev, true); status('Carga deshecha: volvió la pista anterior (el deck no estaba sonando).'); return; }
    if (fx.state === 'adjusting') fx.freeze(); else fx.closePalette(); fxRender();
  }
  if ((k === 'arrowdown' || k === 'arrowup') && !$('#trackPicker').hidden) { picker.start += k === 'arrowdown' ? 1 : -1; renderPicker(); }
  if (k === 'x') { fx.unprepare(); fxRender(); }
  if (k === 'c' && $('#clawEnabled').checked) setClawEnabled(false);
  if (k === 'arrowleft' || k === 'arrowright') { const c = $('#cross'); c.value = clamp(Number(c.value) + (k === 'arrowright' ? 0.08 : -0.08), -1, 1); c.dispatchEvent(new Event('input', { bubbles: true })); }
});
// ---------- Bucle principal ----------
function loop() {
  requestAnimationFrame(loop);
  // El ECO lanzado termina siempre (crossfader, cola y pausa del deck de
  // origen) aunque se salga del Modo manos o se cambie de efecto; si no,
  // eco.tail quedaba colgado y bloqueaba elegir cualquier efecto.
  if (!(handMode.active && handMode.effect === 'eco')) ecoService(performance.now());
  // Medicion de FPS real del bucle (P1): media de 500 ms, visible en Diagnostico.
  const fpsNow = performance.now();
  loop._fpsCount = (loop._fpsCount || 0) + 1;
  if (!loop._fpsAt) loop._fpsAt = fpsNow;
  if (fpsNow - loop._fpsAt >= 500) { loop._fps = Math.round(loop._fpsCount * 1000 / (fpsNow - loop._fpsAt)); loop._fpsCount = 0; loop._fpsAt = fpsNow; }
  loop._frame = (loop._frame || 0) + 1;
  if (performance.now() - (loop._fitAt || 0) > 1200) { loop._fitAt = performance.now(); fitConsole(); updateGuide(); }
  if (performance.now() - (loop._queueAt || 0) > 500) { loop._queueAt = performance.now(); markPlayed(); serviceDeckQueues(false); }
  if (engine) {
    decks.forEach((d, i) => {
      const ch = engine.decks[i];
      if (d.track) { const pe = d.el.querySelector('.pos'), re = d.el.querySelector('.rem'), ps = fmt(ch.position()), rs = '-' + fmt(d.track.buffer.duration - ch.position()); if (pe.textContent !== ps) pe.textContent = ps; if (re.textContent !== rs) re.textContent = rs; if (loop._frame % 2 === 0) drawWave(d); if (loop._frame % 3 === 0) drawZoomWave(d); if (loop._frame % 3 === 0) drawDeckSpectrum(d, i); }
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
    refreshTransport(); syncAllKnobs(); drawSpectrum(); if (performance.now() - autoDjLastCheck > 250) { autoDjLastCheck = performance.now(); checkAutoDj(autoDjLastCheck); checkBassWarn(); if (!gesturesOn) $('#stateDetail').textContent = `FPS del bucle: ${loop._fps || '—'} (con Diagnóstico y gestos se suma el detalle de manos)`; if (!$('#fxPanel').hidden) fxRender(); }
  }
  // Probar arco sin camara: dos puntos fijos, aunque no haya gestos/tracker.
  if (handMode.testUntil) {
    const nowT = performance.now();
    if (nowT < handMode.testUntil) { const w = stage.clientWidth, h = stage.clientHeight; const fake = [{ x: w * 0.32, y: h * 0.52, lm: null, det: { pinched: true } }, { x: w * 0.68, y: h * 0.52, lm: null, det: { pinched: true } }]; drawHandArc(fake, nowT, { pinchPts: fake, gateState: 'agarrado' }); }
    else { handMode.testUntil = 0; showFxArc(false); const lb = $('#fxArcLabel'); if (lb) lb.hidden = true; }
  }
  if (!gesturesOn || !tracker) {
    hands.forEach((h, i) => { const c = $(`#handCursor${i}`); if (c) c.style.display = 'none'; });
    if (handMode.active && handMode.effect === 'stems' && engine) drawStemLanes(); // sin camara: raton/tactil
    return;
  }
  const res = tracker.detect();
  // Mapa de controles para las manos: medir 100+ botones en cada cuadro forzaba
  // recalcular toda la pagina (~5 ms/cuadro). Basta cada 150 ms; los cambios de
  // interfaz (menus, efectos, paneles) ya lo reconstruyen al momento.
  if (performance.now() - (loop._regAt || 0) > 150) { loop._regAt = performance.now(); rebuildRegistry(); }
  const ctx = overlay.getContext('2d'); if (overlay.width !== stage.clientWidth) overlay.width = stage.clientWidth; if (overlay.height !== stage.clientHeight) overlay.height = stage.clientHeight; ctx.clearRect(0, 0, overlay.width, overlay.height);
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
    // El cursor es el PUNTO DE PINZA (medio pulgar-indice): al cerrar la
    // pinza los dos dedos convergen ahi, asi el blanco no se mueve al pinzar.
    const tipI = coverPoint(lm[8]), tipT = coverPoint(lm[4]);
    let x = h.smoothX.update((tipI.x + tipT.x) / 2), y = h.smoothY.update((tipI.y + tipT.y) / 2);
    h.pinch.on = Number($('#calSens').value); h.pinch.off = h.pinch.on + 0.14;
    const det = h.pinch.update(pinchRatio(lm));
    // Iman: sin pinza, el aro se pega suavemente al control pequeno mas cercano.
    if (!det.pinched) { const m = magnetPoint({ x, y }, magnetTargets(), { radius: 16, strength: 0.5 }); x = m.x; y = m.y; }
    // Al empezar la pinza se toma el punto de ~110 ms antes (antes del
    // temblor del cierre), para que el control apuntado sea el que se coge.
    if (det.started) { const before = h.posHist.valueAgo(110, now); if (before) { x = before.x; y = before.y; } }
    h.posHist.push({ x, y }, now);
    cursor.style.display = 'block'; cursor.style.left = x + 'px'; cursor.style.top = y + 'px'; cursor.classList.toggle('pinched', det.pinched);
    const fi = cursor.querySelector('.fd-i'), ft = cursor.querySelector('.fd-t'), fl = cursor.querySelector('.fd-l');
    if (fi && ft && fl) {
      const mx = (tipI.x + tipT.x) / 2, my = (tipI.y + tipT.y) / 2, ix = tipI.x - mx, iy = tipI.y - my, len = Math.hypot(ix, iy) * 2;
      fi.style.transform = `translate(${ix}px, ${iy}px)`; ft.style.transform = `translate(${-ix}px, ${-iy}px)`;
      fl.style.width = len + 'px'; fl.style.transform = `translate(${-ix}px, ${-iy}px) rotate(${Math.atan2(iy, ix)}rad)`;
    }
    if (handMode.active) { const sp = cursor.querySelector('span'); if (sp) sp.textContent = ''; }
    return { lm, x, y, det };
  });
  // --- Modo manos: orden de control unico sobre la mesa ---
  // Medir y dibujar usan el MISMO punto: el punto de pinza de cada mano.
  if (handMode.active) {
    serviceEcoNotice(now);
    // Pinza sobre la barra o el menu: elegir efecto, Cambiar efecto y SALIR.
    // Con el efecto en uso solo vale SALIR (no se cambia a mitad de un agarre).
    const busyNow = hmEffectBusy();
    const menuCards = [...document.querySelectorAll('#gestureIntro .g-card, #hmKnobs .hm-knob, #hmStems .hm-stem, #hmTarget .hm-stem, #stemsPanel .stem-pill, #stemsPanel .stems-xbtn')];
    const hovered = new Set();
    pts.forEach((p, hi) => {
      if (!p) { handMode._barPrev[hi] = false; return; }
      const hit = registry.hit(p.x, p.y, c => !!c.el.closest('#handModeBar, #gestureIntro, #stemsPanel'));
      if ((hit?.el?.dataset.pick || hit?.el?.dataset.knob || hit?.el?.dataset.stem || hit?.el?.dataset.target || hit?.el?.dataset.xfer) && !p.det.pinched) hovered.add(hit.el);
      if (p.det.pinched && !handMode._barPrev[hi] && hit?.el) {
        if (hit.el.id === 'handModeExit') hit.el.click();
        else if (hit.el.dataset.knob) setHandKnob(hit.el.dataset.knob); // perilla del FILTRO
        else if (hit.el.dataset.target !== undefined) setFxTarget(handMode.effect, Number(hit.el.dataset.target));
        else if (hit.el.dataset.stem && handMode.gate.state !== 'agarrado') toggleStem(hit.el.dataset.stemdeck !== undefined ? Number(hit.el.dataset.stemdeck) : handMode.deck, Number(hit.el.dataset.stem));
        else if (!busyNow && hit.el.dataset.pick) chooseHandEffect(hit.el.dataset.pick); // tarjetas del menu de entrada
        else if (!busyNow && hit.el.click) hit.el.click();
      }
      handMode._barPrev[hi] = !!p.det.pinched;
    });
    menuCards.forEach(c => c.classList.toggle('hover', hovered.has(c)));
    if (!handMode.active) return; // salio con pinza en SALIR
    const gi = $('#gestureIntro');
    if (gi && !gi.hidden && (handMode.effect !== 'idle' || now > handMode.introUntil)) hideGestureIntro();
    const chgBtn = $('#hmChange'); if (chgBtn) chgBtn.disabled = busyNow;
    const anyHand = !!(pts[0] || pts[1]), bothHands = !!(pts[0] && pts[1]);
    if (anyHand) { handMode.seenHands = true; handMode.lostSince = null; } else if (handMode.lostSince === null) handMode.lostSince = now;
    const pinchPts = pts.map(p => { if (!p) return null; const pp = pinchPoint(p.lm); return pp ? coverPoint(pp) : { x: p.x, y: p.y }; });
    const pinchCount = pts.filter(p => p?.det.pinched).length;
    if (handModeShouldExit({ anyHandPresent: anyHand, lostSince: handMode.lostSince, now, marginMs: handExitMarginMs(), seenHands: handMode.seenHands, mouseControl: handMode.mouseControl && handMode.gate.state !== 'agarrado' })) {
      exitHandMode('Modo manos cerrado al sacar las manos: filtro de vuelta a Neutro.', { byHands: true });
    } else if (handMode.effect === 'idle') {
      // --- Sin efecto elegido: ningun gesto activa nada; se elige con pinza en el menu/barra ---
      // Solo el cursor de pinza (aro + indice + pulgar), igual que en la consola: sin esqueleto.
      handMode.gate.reset(); eco.gate.reset(); resetFingerDetectors();
      const svgEl0 = $('#fxArc'); if (svgEl0) svgEl0.style.opacity = 1;
      ['fxArcOutline', 'fxArcGlow', 'fxArcCore', 'fxArcSecond'].forEach(id => document.getElementById(id)?.setAttribute('d', ''));
      drawHandsSkeleton([], null, '#22D3EE');
      hmDeckCardUpdate();
      const hm0 = $('#hmHandMsg'); if (hm0) hm0.hidden = true;
      return;
    } else if (handMode.effect === 'roll') {
      // --- ROLL: dedos estables cambian el tamano; cerrar/bajar/perder sale ---
      const chR = engine?.decks[handMode.deck];
      if (roll.exitAtMs && now >= roll.exitAtMs) {
        // El ROLL sigue elegido: listo para otro roll al levantar dedos.
        roll.active = false; roll.exitAtMs = 0; handMode.mouseControl = false; resetFingerDetectors(); hideRollVisual(); hmEffectUI(); status(`ROLL ${'AB'[handMode.deck]}: la canción sigue normal. Levanta 1, 2 o 3 dedos para otro roll.`); return;
      }
      if (!roll.active && !handMode.mouseControl) {
        // Efecto elegido con ratón pero sin arrancar (deck en pausa): espera gesto.
        const { rollEv } = updateFingerDetectors(pts, now);
        if (rollEv && rollSizeBeats(rollEv.count)) { if (rollStart(rollEv.count, rollEv.slot, rollEv.center)) return; }
      } else if (roll.active) {
        const p = roll.slot >= 0 ? pts[roll.slot] : pts.find(Boolean);
        if (p) {
          roll.center = handCenterOf(p);
          // ROLL momentaneo: solo suena mientras se ven 1, 2 o 3 dedos.
          // Bajar la mano, puno, pinza (al cerrar, el pulgar toca el indice)
          // o mano abierta = sale en el golpe y la cancion sigue normal.
          if (roll.center && roll.center.y > roll.startCenterY + stage.clientHeight * 0.20) rollExit(); // bajar la mano
          else if (p.det.pinched) rollExit(); // cerrar la mano suele leerse como pinza
          else if (p.lm) {
            const c = roll.counters[roll.slot >= 0 ? roll.slot : 0].update({ landmarks: p.lm, now });
            if (c.event === 'stable') {
              if (rollSizeBeats(c.count)) rollChangeSize(c.count);
              else rollExit(); // 0 dedos (puno) o 4+ (mano abierta)
            }
          }
        } else if (!handMode.mouseControl) rollExit(); // perder la mano
      }
      if (chR && decks[handMode.deck]?.grid?.bpm) { const bp = beatPhaseAt(chR.position(), decks[handMode.deck].grid.firstBeat, 60 / decks[handMode.deck].grid.bpm); if (bp && bp.index !== handMode.lastBeatIdx) { handMode.lastBeatIdx = bp.index; if (hmBeatOn()) handMode.beatEnv = 1; } }
      handMode.beatEnv *= reducedMotion ? 0 : 0.92; if (!hmBeatOn()) handMode.beatEnv = 0;
      drawHandsSkeleton(pts, pinchPts, '#4ADE80', { pinchRings: false });
      drawRollVisual(now);
      hmDeckCardUpdate();
      const bpmElR = $('#hmDeckBpm'); if (bpmElR && roll.active) bpmElR.textContent = `${decks[handMode.deck].grid?.bpm ? fmtEs(decks[handMode.deck].grid.bpm, 1) + ' BPM · ' : ''}ROLL ${rollSizeLabel(roll.sizeBeats).toLowerCase()} · la pista sigue por debajo`;
      const hmR = $('#hmHandMsg'); if (hmR) hmR.hidden = true;
      return;
    } else if (handMode.effect === 'build') {
      // --- SUBIDA y DROP: dos manos abiertas arman, altura = tension, manos juntas = DROP ---
      const centers = pts.filter(p => p?.lm).map(p => handCenterOf(p)).filter(Boolean);
      if (!build.active && !build.dropping) {
        const ext = pts.map(p => p?.lm ? handExtension01(p.lm) : null);
        if (build.gate.update({ ext0: ext[0], ext1: ext[1], now }) && centers.length === 2) buildStart((centers[0].y + centers[1].y) / 2);
      } else if (build.active) {
        const palm = p => p?.lm ? coverPoint(p.lm[9]) : null;
        const sc = pts.filter(p => p?.lm).map(p => { const w = coverPoint(p.lm[0]), m = coverPoint(p.lm[9]); return Math.hypot(w.x - m.x, w.y - m.y); });
        const scale = sc.length ? sc.reduce((s, v) => s + v, 0) / sc.length : 80;
        if (build.together.update({ a: palm(pts[0]), b: palm(pts[1]), scale, now })) buildDrop();
        else if (centers.length === 2) {
          build.lostAt = 0;
          const y = (centers[0].y + centers[1].y) / 2;
          if (y > build.anchorY + stage.clientHeight * 0.2) buildCancel(`SUBIDA ${'AB'[handMode.deck]}: bajaste las manos, cancelada sin drop.`);
          else buildApply(buildLevel({ anchorY: build.anchorY, y, stageH: stage.clientHeight }));
        } else {
          // Una mano tapada un instante: la tension se queda donde esta.
          if (!build.lostAt) build.lostAt = now;
          if (now - build.lostAt > 700) buildCancel(`SUBIDA ${'AB'[handMode.deck]}: se perdieron las manos, cancelada sin drop.`);
        }
      }
      if (engine && decks[handMode.deck]?.grid?.bpm) {
        const d = decks[handMode.deck], bp = beatPhaseAt(engine.decks[handMode.deck].position(), d.grid.firstBeat, 60 / d.grid.bpm);
        if (bp && bp.index !== handMode.lastBeatIdx) { handMode.lastBeatIdx = bp.index; if (hmBeatOn()) handMode.beatEnv = 1; }
      }
      handMode.beatEnv *= reducedMotion ? 0 : 0.9;
      const svgB = $('#fxArc'); if (svgB) svgB.style.opacity = 1;
      ['fxArcOutline', 'fxArcGlow', 'fxArcCore', 'fxArcSecond'].forEach(id => document.getElementById(id)?.setAttribute('d', ''));
      const flB = $('#fxArcLabel'); if (flB) flB.hidden = true;
      drawHandsSkeleton(pts, null, '#FF5A5F', { pinchRings: false });
      drawBuildVisual(now, centers);
      hmDeckCardUpdate();
      const hmB = $('#hmHandMsg'); if (hmB) hmB.hidden = true;
      return;
    } else if (handMode.effect === 'brake') {
      // --- FRENO: curva a 0, silencio con la palma, vuelta slip en el golpe ---
      const chB = engine?.decks[handMode.deck];
      if (brake.returning) {
        if (engine && engine.ctx.currentTime >= brake.returnCtx) {
          brake.active = false; brake.returning = false; brake.stopped = false; brake.stems = null; handMode.mouseControl = false; resetFingerDetectors(); hideBrakeVisual(); hmEffectUI(); status(`FRENO ${'AB'[handMode.deck]}: de vuelta en el golpe, en su sitio.`); return;
        }
      } else if (!brake.active && !handMode.mouseControl) {
        { const ph = pts.find(Boolean); brake.previewH01 = ph ? palmHeight01(handCenterOf(ph), stage.clientHeight) : null; }
        if (!palmSuppressed(now)) { const { palmEv } = updateFingerDetectors(pts, now); if (palmEv && brakeStart(palmEv.slot, palmEv.center)) return; }
      } else if (brake.active && chB && engine) {
        const p = brake.slot >= 0 ? pts[brake.slot] : pts.find(Boolean);
        let palmHeld = false;
        if (p?.lm) {
          brake.center = handCenterOf(p); brake.handLostAt = 0;
          palmHeld = roll.palms[brake.slot >= 0 ? brake.slot : 0].isPalm(p.lm);
          if (brake.center && brake.center.y > brake.startCenterY + stage.clientHeight * 0.18) palmHeld = false; // bajar la palma
        } else if (!handMode.mouseControl) {
          if (!brake.handLostAt) brake.handLostAt = now;
          if (now - brake.handLostAt > 140) palmHeld = false;
          else palmHeld = true; // parpadeo breve de deteccion: no soltar aun
        } else palmHeld = true;
        if (!palmHeld && !brake.stopped) brakeScheduleReturn();
        else if (!palmHeld && brake.stopped) brakeScheduleReturn();
        else {
          brake.progress = Math.min(1, (engine.ctx.currentTime - brake.startCtx) / Math.max(0.05, brake.durationSec));
          if (!brake.stopped && brake.stems) { if (brake.progress >= 1) { brake.stopped = true; status(`FRENO ${'AB'[handMode.deck]}: partes paradas; quita la palma y vuelven en el golpe.`); } }
          else if (!brake.stopped) {
            chB.setRate(brake.baseRate * Math.max(0.001, brakeRate(brake.progress)));
            if (brake.progress >= 1) { chB.pause(); brake.stopped = true; status(`FRENO ${'AB'[handMode.deck]}: deck parado; quita la palma y vuelve en el golpe.`); }
          }
        }
      }
      drawHandsSkeleton(pts, pinchPts, '#F5B13D', { pinchRings: false });
      drawBrakeVisual(now);
      hmDeckCardUpdate();
      const bpmElB = $('#hmDeckBpm'); if (bpmElB && brake.active) bpmElB.textContent = brake.stopped ? 'FRENANDO · parado · la pista sigue por debajo' : `FRENANDO · ${Math.round(brakeRate(brake.progress) * 100)} % · la pista sigue por debajo`;
      const hmB = $('#hmHandMsg'); if (hmB) hmB.hidden = true;
      return;
    } else if (handMode.effect === 'stems') {
      // --- STEMS: pellizcar una parte (barra o panel) la apaga/enciende en el
      // golpe; dos pinzas mueven el volumen del stem elegido, sin saltos.
      // Consola de stems: como la consola principal (aro, pinza y arrastre).
      // Faders de volumen por stem y crossfader central; los botones se
      // pulsan en el bucle de la barra de arriba.
      handMode.gate.reset();
      pts.forEach((p, hi) => {
        const grabbed = registry.grabbedBy(hi), gc = grabbed ? registry.controls.get(grabbed) : null;
        if (!p) { if (grabbed) { registry.release(hi); rangeDrags.delete(hi); gc?.el?.removeAttribute('data-grabbed'); } return; }
        if (gc) {
          const q = p.det.ended ? (hands[hi].posHist.valueAgo(110, now) || p) : p; // soltar sin mover
          moveRangeDrag(hi, gc.el, q.x, q.y); gc.el.setAttribute('data-grabbed', '1');
          if (p.det.ended) { registry.release(hi); rangeDrags.delete(hi); gc.el.removeAttribute('data-grabbed'); }
          return;
        }
        const hit = registry.hit(p.x, p.y, c => c.el.matches?.('#stemsPanel input[type=range]'));
        document.querySelectorAll('#stemsPanel input[type=range]').forEach(el => el.toggleAttribute('data-focus', el === hit?.el && !p.det.pinched));
        if (p.det.started && hit && registry.grab(hi, hit.id)) startRangeDrag(hi, hit.el, p.x, p.y);
      });
      const lbS = $('#fxArcLabel'); if (lbS) lbS.hidden = true;
      ['fxArcOutline', 'fxArcGlow', 'fxArcCore', 'fxArcSecond'].forEach(id => document.getElementById(id)?.setAttribute('d', ''));
      drawHandsSkeleton([], null, '#FACC15'); // solo el aro de pinza, como en la consola
      document.body.classList.add('hm-picking');
      drawStemLanes(); hmDeckCardUpdate();
      const mlS = $('#mashupLabel'), mash = stemsMashup(); if (mlS && mlS.hidden === mash) hmStemsUI();
      const hmS = $('#hmHandMsg'); if (hmS) hmS.hidden = true;
      return;
    } else if (handMode.effect === 'eco') {
      // --- ECO a una mano: puno, altura y apertura rapida hacia el otro deck ---
      ecoService(now);
      // ECO fijo: los gestos de los otros efectos no hacen nada aqui.
      handMode._beat = null;
      if (engine && decks[handMode.deck]?.grid?.bpm) {
        const d = decks[handMode.deck], bp = beatPhaseAt(engine.decks[handMode.deck].position(), d.grid.firstBeat, 60 / d.grid.bpm);
        if (bp) { handMode._beat = bp; if (bp.index !== handMode.lastBeatIdx) { handMode.lastBeatIdx = bp.index; if (hmBeatOn()) handMode.beatEnv = 1; } }
      }
      handMode.beatEnv *= reducedMotion ? 0 : 0.92; if (!hmBeatOn()) handMode.beatEnv = 0;
      const candidates = pts.filter(Boolean);
      let hand = null;
      if (candidates.length === 1) hand = candidates[0];
      else if (candidates.length > 1) hand = handMode.deck === 0 ? candidates.reduce((a, b) => a.x < b.x ? a : b) : candidates.reduce((a, b) => a.x > b.x ? a : b);
      let center = null;
      if (hand?.lm) center = coverPoint({ x: (hand.lm[0].x + hand.lm[9].x) / 2, y: (hand.lm[0].y + hand.lm[9].y) / 2 });
      else if (hand) center = { x: hand.x, y: hand.y };
      // Lanzar = pulgar arriba ~0,25 s con el puno cerrado; abrir la mano cancela.
      if (hand && center) {
        eco.lastHandAt = now;
        const g = eco.gate.update({ extension01: handExtension01(hand.lm), now });
        if (g.event === 'grabbed') { ecoGrabStart(hand, center); eco.thumb.reset(); }
        if (eco.grabbing && eco.anchor) {
          if (center.y > eco.anchor.y + stage.clientHeight * 0.34) ecoCancel('Eco cancelado: bajaste la mano, sin lanzamiento.', { notice: true });
          else if (eco.thumb.update({ thumb01: thumbUp01(hand.lm), now }) === 'confirmed') { eco.grabbing = false; ecoLaunch(center); }
          else if (thumbUp01(hand.lm) < 0.4) ecoSetDose(anchoredDose({ anchorY: eco.anchor.y, y: center.y, stageH: stage.clientHeight, anchorDose: eco.anchor.dose }));
        }
        if (g.event === 'opened' && eco.grabbing) ecoCancel('Eco cancelado: abriste la mano (pulgar arriba = lanzar).', { notice: true });
      } else if (eco.grabbing && eco.lastHandAt && now - eco.lastHandAt > 260) ecoCancel(null);
      serviceEcoNotice(now);
      const svgEl = $('#fxArc'); if (svgEl) svgEl.style.opacity = 1;
      ['fxArcOutline', 'fxArcGlow', 'fxArcCore', 'fxArcSecond'].forEach(id => document.getElementById(id)?.setAttribute('d', ''));
      const fl = $('#fxArcLabel'); if (fl) fl.hidden = true;
      const deckCol = handMode.deck === 1 ? '#FF4FA3' : '#22D3EE';
      drawHandsSkeleton(hand ? [hand] : [], null, deckCol, { lineCol: '#fff', dotCol: deckCol, pinchRings: false });
      drawEcoVisual(center, now);
      hmDeckCardUpdate(); hmTargetCardUpdate();
      const beatsEl2 = $('#hmBeats');
      if (beatsEl2 && handMode._beat) { const cur = ((handMode._beat.index % 4) + 4) % 4; [...beatsEl2.children].forEach((el, ix) => el.classList.toggle('on', ix === cur)); }
      const hm2 = $('#hmHandMsg'); if (hm2) hm2.hidden = true;
      return;
    } else {
      const gate = handMode.gate.update({ pinchCount: bothHands ? pinchCount : (anyHand ? pinchCount : 0), now });
      // FILTRO fijo: puno, dedos y palma no cambian de efecto.
      const dist01 = bothHands && pinchPts[0] && pinchPts[1] ? aperturaFromDistance(Math.hypot(pinchPts[0].x - pinchPts[1].x, pinchPts[0].y - pinchPts[1].y), stage.clientWidth) : null;
      if (gate.event === 'grabbed') {
        // Nueva pinza a dos manos: devuelve el control a las manos (aunque
        // antes mandara el deslizador/flechas) y ancla sin salto.
        handMode.mouseControl = false; handMode.ramp = null;
        const kInp = handMode.knob !== 'filter' ? hmKnobInput() : null;
        handMode.anchor = { dist01: dist01 ?? handMode.apertura, filter: handMode.filter, value: kInp ? Number(kInp.value) : 0 };
      }
      if (gate.event === 'froze') { handMode.anchor = null; }
      // Solo el FILTRO vuelve a Neutro al soltar; las demas perillas se quedan donde las dejas.
      if (gate.event === 'released-both') { handMode.anchor = null; if (handMode.knob === 'filter') handMode.ramp = { from: handMode.filter, since: now }; }
      if (gate.state === 'agarrado' && dist01 !== null && handMode.anchor) {
        handMode.apertura = dist01; const sl = $('#hmApertura'); if (sl) sl.value = dist01 * 100;
        if (handMode.knob === 'filter') {
          const target = anchoredFilter({ anchorDist01: handMode.anchor.dist01, anchorFilter: handMode.anchor.filter, dist01, highpass: hmHighpass() });
          hmSetFilter(handMode.filter + (target - handMode.filter) * 0.45);
        } else {
          // Mismo anclaje relativo que el filtro: arranca desde el valor actual, sin saltos.
          const inp = hmKnobInput();
          if (inp) {
            const mn = Number(inp.min), mx = Number(inp.max), d = dist01 - handMode.anchor.dist01;
            const target = Math.min(mx, Math.max(mn, handMode.anchor.value + (Math.abs(d) <= 0.008 ? 0 : d) * (mx - mn)));
            inp.value = Number(inp.value) + (target - Number(inp.value)) * 0.45; setParam(inp); syncAllKnobs();
          }
        }
        handMode.smooth = dist01;
      } else if (handMode.ramp) {
        const v = neutralRampValue(handMode.ramp.from, now - handMode.ramp.since, 600);
        hmSetFilter(v);
        if (Math.abs(v) < 0.01) handMode.ramp = null;
      }
      // Latido con la rejilla del deck: golpe -> env=1 y decae.
      handMode._beat = null;
      if (hmBeatOn() && engine && decks[handMode.deck]?.grid?.bpm) {
        const d = decks[handMode.deck], period = 60 / d.grid.bpm;
        const bp = beatPhaseAt(engine.decks[handMode.deck].position(), d.grid.firstBeat, period);
        if (bp) {
          handMode._beat = bp;
          if (bp.index !== handMode.lastBeatIdx) { handMode.lastBeatIdx = bp.index; handMode.beatEnv = 1; }
          const vel = Math.abs(handMode.apertura - (handMode._prevAp ?? handMode.apertura));
          if (vel > 0.012 && onBeat(bp.phase)) handMode.spark = 1;
        }
      } else if (engine && decks[handMode.deck]?.grid?.bpm) {
        const d = decks[handMode.deck];
        handMode._beat = beatPhaseAt(engine.decks[handMode.deck].position(), d.grid.firstBeat, 60 / d.grid.bpm);
      }
      handMode._prevAp = handMode.apertura;
      handMode.beatEnv *= reducedMotion ? 0 : 0.92; handMode.spark *= reducedMotion ? 0 : 0.9;
      if (!hmBeatOn()) handMode.beatEnv = 0;
      hmDeckCardUpdate();
      // Compas de 4 tiempos en la ficha del deck.
      const beatsEl = $('#hmBeats');
      if (beatsEl && handMode._beat) { const cur = ((handMode._beat.index % 4) + 4) % 4; [...beatsEl.children].forEach((el, ix) => el.classList.toggle('on', ix === cur)); }
      const handMsg = $('#hmHandMsg');
      if (handMsg) { const show = anyHand && !bothHands; handMsg.hidden = !show; if (show) handMsg.textContent = 'falta una mano'; }
      drawHandArc(pts, now, { pinchPts, gateState: gate.state });
      return;
    }
  }
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
  // --- Selector PISTAS con gestos: apunte fijo, cierre sin manos, palmas ---
  if (!$('#trackPicker').hidden) {
    const anyHand = !!(pts[0] || pts[1]);
    if (anyHand) picker.lastActivityAt = now;
    // Cartel fijo de apunte: la primera mano que apunte a una tarjeta manda.
    let pointedName = null, pointedCard = null;
    for (const p of pts) {
      if (!p) continue;
      const hit = registry.hit(p.x, p.y, c => !!c.el.closest('#trackPicker'));
      if (hit?.el.classList.contains('pickcard')) { pointedCard = hit.el; const raw = library.find(t => t.id === hit.el.dataset.trackId)?.name || null; pointedName = raw ? displayTrackName(raw) : null; break; }
    }
    $('#pickerPointing').textContent = pickerPointingText(pointedName);
    if (pointedCard) pointedCard.setAttribute('data-focus', '1');
    // Cuenta atras / cierre automatico (solo con gestos activos).
    const idle = pickerIdleState({ open: true, gesturesOn, handsPresent: anyHand, lastActivityAt: picker.lastActivityAt, now, timeoutMs: Math.max(3, Math.min(20, Number($('#pickerIdleSec')?.value || 7))) * 1000 });
    $('#pickerCount').textContent = idle.state === 'countdown' ? pickerCountdownText(idle.remainingMs) : '';
    if (idle.state === 'close') closeTrackPicker('Selector cerrado por falta de manos: no se cargó ninguna pista.');
    else {
      // Dos palmas abiertas 1 s: salir sin cargar.
      const bothPalms = !!(pts[0] && pts[1] && !pts[0].det.pinched && !pts[1].det.pinched);
      if (bothPalms) {
        if (!picker.palmsSince) picker.palmsSince = now;
        if (now - picker.palmsSince >= 1000) closeTrackPicker('Selector cerrado con las dos palmas: no se cargó ninguna pista.');
      } else picker.palmsSince = null;
      // Confirmacion gestual mantenida si el deck suena (barra de progreso).
      if (pointedCard && engine?.decks[picker.deck].playing) {
        const pinching = pts.some(p => p?.det.pinched && registry.hit(p.x, p.y, c => c.el === pointedCard));
        if (pinching) {
          if (!picker.gestureHold || picker.gestureHold.id !== pointedCard.dataset.trackId) picker.gestureHold = { id: pointedCard.dataset.trackId, since: now };
          const pct = Math.min(100, (now - picker.gestureHold.since) / 1000 * 100);
          const bar = pointedCard.querySelector('.holdbar i'); if (bar) bar.style.width = pct + '%';
          if (pct >= 100) { const t = library.find(x => x.id === pointedCard.dataset.trackId); picker.gestureHold = null; if (t) loadToDeck(picker.deck, t, true).then(ok => { if (ok) closeTrackPicker(); }); }
        } else { picker.gestureHold = null; const bar = pointedCard.querySelector('.holdbar i'); if (bar) bar.style.width = '0%'; }
      }
    }
  }
  // --- Mano individual: foco visible antes de pinzar ---
  document.querySelectorAll('[data-focus]').forEach(el => el.removeAttribute('data-focus'));
  document.querySelectorAll('[data-grabbed]').forEach(el => el.removeAttribute('data-grabbed'));
  let focusLabel = '';
  hands.forEach((h, hi) => {
    const p = pts[hi]; if (!p) return;
    const inPicker = c => !!c.el.closest('#trackPicker'), pickerOpen = !$('#trackPicker').hidden;
    const rawHit = pickerOpen ? registry.hit(p.x, p.y, inPicker) : registry.hit(p.x, p.y);
    // Foco estable: el control enfocado se mantiene mientras el aro siga
    // cerca (10 px); otro control solo toma el foco tras ~120 ms encima.
    let cur = h.focus.current ? registry.controls.get(h.focus.current) : null;
    if (h.focus.current && (!cur || (pickerOpen && !inPicker(cur)))) { h.focus.reset(); cur = null; }
    const inside = !!cur && p.x >= cur.rect.x - 10 && p.x <= cur.rect.x + cur.rect.w + 10 && p.y >= cur.rect.y - 10 && p.y <= cur.rect.y + cur.rect.h + 10;
    const focusId = h.focus.update({ hitId: rawHit?.id ?? null, insideCurrent: inside, now });
    const hit = focusId ? registry.controls.get(focusId) || null : null;
    if (hit && !p.det.pinched) { hit.el.setAttribute('data-focus', '1'); focusLabel = controlLabel(hit.el); $(`#handCursor${hi}`).querySelector('span').textContent = focusLabel; }
    else $(`#handCursor${hi}`).querySelector('span').textContent = p.det.pinched ? 'TOMADO' : '';
    if (twoBusy || fxBusy || expressiveActive || hi === clawHand) return;
    const grabbedId = registry.grabbedBy(hi);
    // Soltar sin mover: en el fotograma de soltar se usa el punto de ~110 ms
    // antes, para que la apertura de los dedos no mueva la perilla o el fader.
    const q = p.det.ended ? (h.posHist.valueAgo(110, now) || p) : p;
    if (grabbedId) { const c = registry.controls.get(grabbedId); if (c?.el?.dataset.g === 'range') moveRangeDrag(hi, c.el, q.x, q.y); if (c?.el?.dataset.g === 'knob') moveKnobDrag(hi, q.x); if (c?.el?.classList.contains('wave')) moveWaveDragGesture(hi, p.x); if (c?.el?.dataset.g === 'jog') moveScratchGesture(hi, p.y); if (c) c.el.setAttribute('data-grabbed', '1'); }
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
  const ft = $('#focusTag'); ft.hidden = !focusLabel; ft.textContent = focusLabel ? `Enfocado: ${focusLabel} — haz pinza para tomarlo` : ''; ft.title = ft.textContent;
  const cf = $('#chipFocus'); cf.textContent = `Foco: ${focusLabel || '—'}`; cf.title = cf.textContent;
  $('#stateDetail').textContent = `Cámara: ${video.srcObject ? 'activa' : 'apagada'} (${mirrored ? 'espejo' : 'normal'}) · Gestos: ${gesturesOn ? 'activos' : 'pausados'} · FPS: ${loop._fps || '—'} · Foco: ${focusLabel || '—'} · Garra: ${$('#clawEnabled').checked ? (clawHand >= 0 ? 'enganchada' : 'activa sin enganchar') : 'desactivada'} · Dos manos: ${two.state}`;
}
loop();
