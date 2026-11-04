// ECO «agarrar y lanzar» (Encargo 4B): logica pura, sin DOM ni audio.
// El gesto NO usa pinza: puno cerrado (extension de dedos baja) para
// agarrar, altura del puno para dosificar y pulgar arriba para lanzar
// (abrir la mano cancela). Todo testeable con landmarks sinteticos.
import { clamp, dist } from '../gestures/logic.js';
// Extension de la mano [0 puno .. 1 abierta]: media de las puntas de los
// 4 dedos a la muneca, normalizada por la escala muneca->nudillo medio.
// Misma medida observada en la garra: puno ~1,05 y abierta ~1,85 (sin
// normalizar); aqui se devuelve ya en [0,1].
export function handExtension01(landmarks) {
  if (!landmarks || landmarks.length < 21) return 1;
  const scale = dist(landmarks[0], landmarks[9]) || 1e-6;
  const tips = [8, 12, 16, 20];
  const avg = tips.reduce((s, i) => s + dist(landmarks[0], landmarks[i]), 0) / tips.length;
  return clamp(((avg / scale) - 1.05) / 0.8);
}
// Puerta del puno con histeresis: agarrar exige extension baja mantenida
// >= holdMs; abrir se detecta al cruzar el umbral alto y se mide cuanto
// tardo la apertura (rapida = posible lanzamiento, lenta = cancelar).
export class FistGate {
  constructor({ holdMs = 300, fistOn = 0.35, fistOff = 0.5, openOn = 0.65 } = {}) {
    this.holdMs = holdMs; this.fistOn = fistOn; this.fistOff = fistOff; this.openOn = openOn;
    this.state = 'abierta'; this._since = null; this._openSince = null;
  }
  reset() { this.state = 'abierta'; this._since = null; this._openSince = null; }
  update({ extension01 = 1, now = 0 } = {}) {
    let event = null, openMs = null;
    const ext = Number(extension01);
    if (this.state === 'abierta') {
      if (ext <= this.fistOn) { this.state = 'cerrando'; this._since = now; }
    } else if (this.state === 'cerrando') {
      if (ext > this.fistOff) { this.state = 'abierta'; this._since = null; }
      else if (now - this._since >= this.holdMs) { this.state = 'puno'; this._since = null; this._openSince = null; event = 'grabbed'; }
    } else if (this.state === 'puno') {
      if (ext > this.fistOff && this._openSince === null) this._openSince = now;
      if (ext >= this.openOn) {
        openMs = this._openSince === null ? 0 : now - this._openSince;
        this.state = 'abierta'; this._openSince = null; event = 'opened';
      } else if (ext <= this.fistOn) this._openSince = null;
    }
    return { state: this.state, event, openMs };
  }
}
// Pulgar arriba (lanzar el ECO): los 4 dedos siguen cerrados y la punta
// del pulgar queda claramente por encima del nudillo del indice. Se mide
// en escalas muneca->nudillo medio; subir = y menor. En un puno normal el
// pulgar queda a la altura del nudillo (~0); levantado, ~0,7-0,9.
export function thumbUp01(landmarks) {
  if (!landmarks || landmarks.length < 21) return 0;
  const scale = dist(landmarks[0], landmarks[9]) || 1e-6;
  if (handExtension01(landmarks) > 0.5) return 0;
  return clamp(((landmarks[5].y - landmarks[4].y) / scale - 0.25) / 0.4);
}
// Puerta del pulgar: confirma con el pulgar arriba mantenido >= holdMs.
// Un solo disparo hasta que el pulgar baja (histeresis on/off).
export class ThumbGate {
  constructor({ holdMs = 250, on = 0.75, off = 0.4 } = {}) { this.holdMs = holdMs; this.on = on; this.off = off; this.reset(); }
  reset() { this._since = null; this._fired = false; }
  update({ thumb01 = 0, now = 0 } = {}) {
    const v = Number(thumb01) || 0;
    if (v <= this.off) { this._since = null; this._fired = false; return null; }
    if (v >= this.on && this._since === null) this._since = now;
    if (!this._fired && this._since !== null && now - this._since >= this.holdMs) { this._fired = true; return 'confirmed'; }
    return null;
  }
}
// Dosis anclada: al agarrar, la altura actual vale la dosis actual;
// subir el puno suma y bajar resta, sin salto. Subir = y menor.
export function anchoredDose({ anchorY = 0, y = 0, stageH = 1, anchorDose = 0 } = {}) {
  const span = Math.max(1, (Number(stageH) || 1) * 0.25); // ~un palmo: de 0 a 100 % sin salir de camara
  return clamp((Number(anchorDose) || 0) + ((Number(anchorY) || 0) - (Number(y) || 0)) / span, 0, 1);
}
// Lanzar o cancelar al abrir: solo tras puno mantenido (lo garantiza la
// puerta), apertura rapida y movimiento hacia el otro deck con
// velocidad y recorrido minimos. En cualquier otro caso, cancelar.
export function throwDecision({ wasGrabbing = false, openMs = null, dxPx = 0, dtMs = 1, dirSign = 1, stageW = 1 } = {}) {
  if (!wasGrabbing) return 'cancelar';
  const w = Math.max(1, Number(stageW) || 1);
  const toward = (Number(dxPx) || 0) * (dirSign < 0 ? -1 : 1);
  const dt = Math.max(1, Number(dtMs) || 1) / 1000;
  const speed = toward / w / dt; // anchos de escenario por segundo
  const fastOpen = openMs !== null && openMs !== undefined && openMs <= 220;
  return fastOpen && toward >= w * 0.08 && speed >= 0.9 ? 'lanzar' : 'cancelar';
}
// Decision en VENTANA (correccion): el lanzamiento ya no se decide en
// el instante de abrir. Vale barrer antes de abrir, abrir y luego
// barrer, o las dos cosas a la vez: se mira el recorrido hacia el otro
// deck en las muestras de la ventana (~300 ms antes a ~400 ms despues
// de la apertura). openMs NO bloquea: a 30 fps cada fotograma son
// ~33 ms y la apertura se mide solo entre dos umbrales cercanos, asi
// que exigirla <= 220 ms junto al barrido simultaneo era fragil; basta
// con que la puerta haya confirmado puno->abierta y haya barrido real.
// Cancelar: la ventana acaba sin barrido, o la mano baja del ancla.
export function throwWindowDecision({ samples = [], dirSign = 1, stageW = 1, anchorY = null, stageH = 1 } = {}) {
  const list = (samples || []).filter(s => s && Number.isFinite(s.x) && Number.isFinite(s.t)).slice().sort((a, b) => a.t - b.t);
  if (!list.length) return { decision: 'sin-lanzamiento', advance01: 0, speed: 0, reason: 'sin-muestras' };
  if (anchorY !== null && anchorY !== undefined) {
    const limit = (Number(anchorY) || 0) + 0.34 * Math.max(1, Number(stageH) || 1);
    if (list.some(s => Number.isFinite(s.y) && s.y > limit)) return { decision: 'cancelar', advance01: 0, speed: 0, reason: 'bajada' };
  }
  const w = Math.max(1, Number(stageW) || 1), dir = dirSign < 0 ? -1 : 1;
  // Mejor tramo: cualquier par de muestras cuyo recorrido hacia el otro
  // deck supere el minimo con velocidad suficiente (el barrido puede
  // ocupar solo una parte de la ventana, antes o despues de abrir).
  let maxAdvance = 0, launch = null;
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const advance = (list[j].x - list[i].x) * dir;
    if (advance > maxAdvance) maxAdvance = advance;
    if (!launch && advance >= 0.08 * w) {
      const dt = Math.max(0.05, (list[j].t - list[i].t) / 1000), speed = advance / w / dt;
      if (speed >= 0.9) launch = { advance01: advance / w, speed };
    }
  }
  return launch ? { decision: 'lanzar', advance01: launch.advance01, speed: launch.speed, reason: 'barrido' }
    : { decision: 'sin-lanzamiento', advance01: maxAdvance / w, speed: 0, reason: 'sin-barrido' };
}
// Siguiente golpe de la rejilla donde cae el corte. Sin rejilla fiable,
// corte inmediato (la UI avisa «Sin rejilla fiable: el corte sera inmediato»).
export function nextBeatCut({ position = 0, grid = null, rate = 1, minConfidence = 0.3 } = {}) {
  const pos = Number(position) || 0;
  if (!grid?.bpm || grid.firstBeat === null || grid.firstBeat === undefined || (grid.confidence ?? 1) < minConfidence) {
    return { quantized: false, atPosition: pos, delaySec: 0, period: null };
  }
  const period = 60 / grid.bpm;
  const k = Math.ceil((pos - grid.firstBeat) / period - 1e-6);
  let at = grid.firstBeat + k * period;
  if (at < pos) at += period;
  const r = Number(rate) > 0 ? Number(rate) : 1;
  return { quantized: true, atPosition: at, delaySec: Math.max(0, (at - pos) / r), period };
}
// Posicion de arranque del deck destino: donde lo dejaste preparado (si
// lo moviste del principio), si no su CUE, si no el primer golpe de su
// rejilla, si no el principio.
export function targetStartPosition({ position = 0, cue = null, firstBeat = null } = {}) {
  if (Number(position) > 0.05) return Number(position);
  if (cue !== null && cue !== undefined && Number(cue) > 0) return Number(cue);
  if (firstBeat !== null && firstBeat !== undefined) return Number(firstBeat);
  return 0;
}
// Plan de lanzamiento segun el estado del deck destino. syncAtGrab dice
// que hay que igualar al cerrar el puno (antes de lanzar); el tempo de
// un destino que YA se oye nunca se cambia (se notaria).
export function launchPlan({ targetHasTrack = false, targetPlaying = false, targetAudible = false, tempoSyncOk = false, alreadySynced = true } = {}) {
  if (!targetHasTrack) return { action: 'eco-solo', syncAtGrab: 'none', aviso: 'sin-pista' };
  if (!targetPlaying) return { action: 'arranca-en-el-golpe', syncAtGrab: tempoSyncOk ? 'tempo' : 'none', aviso: tempoSyncOk ? null : 'tempo-distinto' };
  if (targetAudible) return { action: 'lanzar', syncAtGrab: 'none', aviso: alreadySynced ? null : 'no-sincronizada' };
  return { action: 'lanzar', syncAtGrab: 'completo', aviso: tempoSyncOk ? null : 'tempo-distinto' };
}
export function crossTargetFor(sourceDeck) { return sourceDeck === 0 ? 1 : -1; }
export function throwDirSign(sourceDeck) { return sourceDeck === 0 ? 1 : -1; }
