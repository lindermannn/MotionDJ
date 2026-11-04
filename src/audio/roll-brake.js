// LOOP ROLL y FRENO (Encargo 4C): logica pura, sin DOM ni audio.
// Dedos contados de indice a menique con los 21 landmarks (no la garra
// continua); palma de «alto» solo si esta extendida, junta y QUIETA.
import { clamp, dist } from '../gestures/logic.js';
const FINGERS = [[5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
// Rectitud de un dedo: distancia nudillo->punta dividida por la suma de
// sus tramos. Extendidio ~1, plegado mucho menor.
export function fingerStraightness(lm, chain) {
  if (!lm) return 0;
  const [a, b, c, d] = chain.map(i => lm[i]);
  if (!a || !b || !c || !d) return 0;
  const path = dist(a, b) + dist(b, c) + dist(c, d);
  return path > 0 ? dist(a, d) / path : 0;
}
export function fingerExtensions(lm) {
  return FINGERS.map(chain => fingerStraightness(lm, chain));
}
export function thumbExtension(lm) {
  if (!lm || !lm[1] || !lm[2] || !lm[3] || !lm[4]) return 0;
  const path = dist(lm[1], lm[2]) + dist(lm[2], lm[3]) + dist(lm[3], lm[4]);
  return path > 0 ? dist(lm[1], lm[4]) / path : 0;
}
// Conteo estable de dedos (sin pulgar): histeresis por dedo
// (on >= 0,86 / off <= 0,76) y estabilidad de ~150 ms del conteo.
// 0 y 4 tambien son conteos (0 = cerrar/salir, 4 = zona muerta).
export class FingerCounter {
  constructor({ stableMs = 150, on = 0.86, off = 0.76 } = {}) {
    this.stableMs = stableMs; this.on = on; this.off = off;
    this.extended = [false, false, false, false];
    this.count = -1; this._candidate = null; this._since = null;
  }
  reset() { this.extended = [false, false, false, false]; this.count = -1; this._candidate = null; this._since = null; }
  rawCount(lm) {
    const ext = fingerExtensions(lm);
    let n = 0;
    ext.forEach((v, i) => { if (this.extended[i] ? v <= this.off : v >= this.on) this.extended[i] = !this.extended[i]; if (this.extended[i]) n++; });
    return n;
  }
  update({ landmarks, now = 0 } = {}) {
    const raw = this.rawCount(landmarks);
    let event = null;
    if (raw !== this._candidate) { this._candidate = raw; this._since = now; }
    else if (raw !== this.count && now - this._since >= this.stableMs) { this.count = raw; event = 'stable'; }
    return { count: this.count, raw, event };
  }
}
// Palma de «alto»: 4 dedos + pulgar extendidos, dedos juntos (puntas
// cercanas entre si) y mano quieta (el centro no se mueve del ancla)
// durante >= holdMs. Una mano abierta que pasa nunca dispara.
export function fingersTogether01(lm) {
  if (!lm || !lm[0] || !lm[9]) return 1;
  const scale = dist(lm[0], lm[9]) || 1e-6;
  const tips = [8, 12, 16, 20];
  let sum = 0;
  for (let i = 0; i < 3; i++) sum += dist(lm[tips[i]], lm[tips[i + 1]]);
  return (sum / 3) / scale; // bajo = dedos juntos
}
export class PalmGate {
  constructor({ holdMs = 400, moveTol01 = 0.025, togetherMax = 0.78 } = {}) {
    this.holdMs = holdMs; this.moveTol01 = moveTol01; this.togetherMax = togetherMax;
    this.state = 'libre'; this._since = null; this._anchor = null;
  }
  reset() { this.state = 'libre'; this._since = null; this._anchor = null; }
  isPalm(lm) {
    if (!lm) return false;
    const ext = fingerExtensions(lm);
    return ext.every(v => v >= 0.82) && thumbExtension(lm) >= 0.78 && fingersTogether01(lm) <= this.togetherMax;
  }
  update({ landmarks, center, now = 0, stageW = 1 } = {}) {
    let event = null;
    const palm = this.isPalm(landmarks) && !!center;
    if (!palm) { this.reset(); return { state: this.state, event }; }
    const moved = this._anchor ? Math.hypot(center.x - this._anchor.x, center.y - this._anchor.y) : 0;
    if (this.state === 'libre' || moved > Math.max(1, stageW) * this.moveTol01) {
      this.state = 'quieta'; this._since = now; this._anchor = { x: center.x, y: center.y };
    } else if (this.state === 'quieta' && now - this._since >= this.holdMs) {
      this.state = 'palma'; event = 'brake';
    }
    return { state: this.state, event };
  }
}
export function rollSizeBeats(fingers) { return fingers === 1 ? 1 : fingers === 2 ? 0.5 : fingers === 3 ? 0.25 : null; }
export function rollSizeLabel(beats) { return beats === 1 ? '1 TIEMPO' : beats === 0.5 ? '½ TIEMPO' : beats === 0.25 ? '¼ TIEMPO' : ''; }
// FRENO: altura de la palma (0 abajo .. 1 arriba) -> duracion en
// tiempos: arriba seco (1), abajo largo (3).
export function brakeDurationBeats(height01) { return 3 - 2 * clamp(Number(height01) || 0, 0, 1); }
// Curva del freno (vinilo): velocidad 1 -> 0 que cae YA desde el primer
// instante (sin meseta inicial) y se arrastra al final: (1-t)^1,5.
export const BRAKE_K = 1.5;
export function brakeRate(p) { const t = clamp(Number(p) || 0, 0, 1); return Math.pow(1 - t, BRAKE_K); }
// Lo que avanza la posicion durante el freno (integral de la curva),
// en segundos de pista por cada segundo real a rate 1.
export function brakeAdvance(elapsedSec, durationSec) {
  const d = Math.max(1e-6, Number(durationSec) || 1), e = clamp(Number(elapsedSec) || 0, 0, d), p = e / d;
  return d * (1 - Math.pow(1 - p, BRAKE_K + 1)) / (BRAKE_K + 1);
}
// Posicion «slip»: donde estaria la cancion sin el efecto encima.
export function slipPosition(startPos, elapsedSec, rate) {
  return (Number(startPos) || 0) + (Number(elapsedSec) || 0) * (Number(rate) || 0);
}
// Altura normalizada de la palma: 0 abajo, 1 arriba, en una franja corta
// (del pecho a la cara, 75 % -> 40 % de la pantalla) para llegar a los
// extremos sin sacar la mano de camara.
export const PALM_BAND = Object.freeze({ low: 0.75, high: 0.4 });
export function palmHeight01(center, stageH) {
  if (!center || !(stageH > 0)) return 0.5;
  const y = (Number(center.y) || 0) / stageH;
  return clamp((PALM_BAND.low - y) / (PALM_BAND.low - PALM_BAND.high), 0, 1);
}
// Plan del freno al disparar: duracion real segun altura y BPM efectivo.
export function brakePlan({ height01 = 0.5, bpm = null, rate = 1 } = {}) {
  const beats = brakeDurationBeats(height01);
  const beatSec = bpm > 0 ? 60 / bpm : 0.5;
  const r = Number(rate) > 0 ? Number(rate) : 1;
  return { beats, durationSec: beats * beatSec / r, label: beats <= 1.5 ? 'SECO' : beats >= 2.5 ? 'LARGO' : 'MEDIO' };
}
