// SUBIDA y DROP a dos manos: logica pura, sin DOM ni audio.
// Las dos manos abiertas arman la subida; subirlas (un palmo como mucho,
// desde donde se armo) sube la tension: la BATERIA se repite cada vez mas
// corta, el BAJO sale y la musica va al pasa-altos, con la VOZ limpia.
// Juntar las manos (palma con palma, sostenido) suelta el DROP en el siguiente
// compas. Todo testeable con puntos sinteticos.
import { clamp, dist } from '../gestures/logic.js';

// Nivel de la subida [0..1]: subir = y menor. Un palmo (25 % del alto de
// la pantalla) recorre la subida entera, para no cansar los brazos.
export function buildLevel({ anchorY = 0, y = 0, stageH = 1 } = {}) {
  const span = Math.max(1, (Number(stageH) || 1) * 0.25);
  return clamp(((Number(anchorY) || 0) - (Number(y) || 0)) / span, 0, 1);
}
// Que suena en cada nivel: tamano del roll de la bateria (en tiempos),
// volumen del bajo y apertura del pasa-altos (0..1).
export function buildStage(level) {
  const l = clamp(Number(level) || 0, 0, 1);
  const rollBeats = l < 0.1 ? null : l < 0.35 ? 1 : l < 0.6 ? 0.5 : l < 0.85 ? 0.25 : 0.125;
  return { rollBeats, bass: clamp(1 - l * 2, 0, 1), hp: l };
}
export function rollBeatsLabel(b) { return b === 1 ? '1 TIEMPO' : b === 0.5 ? '½' : b === 0.25 ? '¼' : b === 0.125 ? '⅛' : '—'; }

// Armar: las dos manos abiertas a la vez durante holdMs.
export class OpenHandsGate {
  constructor({ holdMs = 300, openMin = 0.55 } = {}) { this.holdMs = holdMs; this.openMin = openMin; this.reset(); }
  reset() { this._since = null; }
  update({ ext0 = null, ext1 = null, now = 0 } = {}) {
    const open = ext0 !== null && ext1 !== null && ext0 >= this.openMin && ext1 >= this.openMin;
    if (!open) { this._since = null; return false; }
    if (this._since === null) this._since = now;
    return now - this._since >= this.holdMs;
  }
}

// DROP = manos juntas: la distancia entre palmas (en escalas de mano) baja
// de nearMax y se sostiene holdMs. Solo cuenta si desde que se armo las
// manos estuvieron separadas (>= farMin): armar con las manos ya juntas no
// suelta el drop. Al juntarse, MediaPipe a veces pierde una mano: si se
// pierde justo despues de estar cerca (<= lostNear), tambien cuenta.
export class HandsTogetherGate {
  constructor({ nearMax = 1.0, farMin = 1.6, lostNear = 1.2, holdMs = 150 } = {}) {
    Object.assign(this, { nearMax, farMin, lostNear, holdMs });
    this.reset();
  }
  reset() { this._wasApart = false; this._since = null; this._last = null; }
  // a, b: centros de palma (o null si esa mano no se ve); scale: tamano de mano.
  update({ a = null, b = null, scale = 1, now = 0 } = {}) {
    if (!a || !b) {
      const l = this._last;
      if (this._wasApart && l && l.d <= this.lostNear && now - l.t <= 150) return this._fire();
      this._since = null;
      return false;
    }
    const d = dist(a, b) / Math.max(1e-6, Number(scale) || 1);
    this._last = { d, t: now };
    if (d >= this.farMin) this._wasApart = true;
    if (!this._wasApart || d > this.nearMax) { this._since = null; return false; }
    if (this._since === null) this._since = now;
    return now - this._since >= this.holdMs ? this._fire() : false;
  }
  _fire() { this.reset(); return true; }
}

// Siguiente primer tiempo de compas (cada 4 golpes desde firstBeat). Sin
// rejilla fiable, inmediato.
export function nextBarCut({ position = 0, grid = null, rate = 1, minConfidence = 0.3 } = {}) {
  const pos = Number(position) || 0;
  if (!grid?.bpm || grid.firstBeat === null || grid.firstBeat === undefined || (grid.confidence ?? 1) < minConfidence) {
    return { quantized: false, atPosition: pos, delaySec: 0 };
  }
  const bar = 4 * 60 / grid.bpm;
  const k = Math.ceil((pos - grid.firstBeat) / bar - 1e-6);
  let at = grid.firstBeat + k * bar;
  if (at < pos) at += bar;
  const r = Number(rate) > 0 ? Number(rate) : 1;
  return { quantized: true, atPosition: at, delaySec: Math.max(0, (at - pos) / r) };
}
