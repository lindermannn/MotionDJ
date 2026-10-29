// Logica pura de gestos: testeable sin camara ni DOM.
export function dist(a, b) {
  if (!a || !b) return Infinity;
  const dx = a.x - b.x, dy = a.y - b.y, dz = (a.z || 0) - (b.z || 0);
  return Math.hypot(dx, dy, dz);
}
// Ratio pinza: distancia pulgar(4)-indice(8) / escala mano muneca(0)-nudillo medio(9)
export function pinchRatio(landmarks) {
  if (!landmarks || landmarks.length < 10) return 1;
  const scale = dist(landmarks[0], landmarks[9]) || 1e-6;
  return dist(landmarks[4], landmarks[8]) / scale;
}
export class PinchDetector {
  constructor({ on = 0.38, off = 0.52 } = {}) { this.on = on; this.off = off; this.pinched = false; }
  update(ratio) {
    const prev = this.pinched;
    if (!this.pinched && ratio < this.on) this.pinched = true;
    else if (this.pinched && ratio > this.off) this.pinched = false;
    return { pinched: this.pinched, started: this.pinched && !prev, ended: !this.pinched && prev };
  }
  reset() { this.pinched = false; }
}
export class Smoother {
  constructor(alpha = 0.35) { this.alpha = alpha; this.v = null; }
  update(v) { this.v = this.v === null ? v : this.v + this.alpha * (v - this.v); return this.v; }
  reset() { this.v = null; }
}
// Curva equal-power del crossfader. x en [-1,1]
export function crossfaderGains(x) {
  const t = (Math.min(1, Math.max(-1, x)) + 1) / 2;
  return { a: Math.cos(t * Math.PI / 2), b: Math.cos((1 - t) * Math.PI / 2) };
}
export function clamp(v, lo = 0, hi = 1) { return Math.min(hi, Math.max(lo, v)); }
// Registro de controles: foco y agarre independiente por mano.
export class ControlRegistry {
  constructor() { this.controls = new Map(); this.grabs = new Map(); }
  register(id, rect, opts = {}) { this.controls.set(id, { id, rect, ...opts }); }
  unregister(id) { this.controls.delete(id); }
  hit(x, y) {
    let best = null;
    for (const c of this.controls.values()) {
      if (c.disabled) continue;
      const r = c.rect;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
        if (!best || (c.z || 0) >= (best.z || 0)) best = c;
      }
    }
    return best;
  }
  grab(handId, controlId) {
    if ([...this.grabs.values()].includes(controlId)) return false;
    this.grabs.set(handId, controlId); return true;
  }
  grabbedBy(handId) { return this.grabs.get(handId) || null; }
  release(handId) { const id = this.grabs.get(handId) || null; this.grabs.delete(handId); return id; }
  releaseAll() { this.grabs.clear(); }
}
// Valor de un fader vertical/horizontal segun posicion del dedo dentro del rect
export function faderValue(control, x, y) {
  const r = control.rect;
  if (control.orientation === 'vertical') return clamp(1 - (y - r.y) / r.h);
  return clamp((x - r.x) / r.w);
}
export function knobValue(control, y, current) {
  // Arrastre vertical: subir el dedo sube el valor
  return clamp(current - y * 1.6);
}
