// Garra de cinco dedos: apertura de la mano -> parametro continuo.
// Separada de la pinza y de la sesion a dos manos. Sin DOM ni audio.
import { dist, clamp } from './logic.js';
// Apertura: media de puntas (8,12,16,20) a la muneca, normalizada por la
// escala de la mano (muneca->nudillo medio). Mano abierta > puño cerrado.
export function handAperture(landmarks) {
  if (!landmarks || landmarks.length < 21) return 0;
  const scale = dist(landmarks[0], landmarks[9]) || 1e-6;
  const tips = [8, 12, 16, 20];
  const avg = tips.reduce((s, i) => s + dist(landmarks[0], landmarks[i]), 0) / tips.length;
  return avg / scale;
}
// Normaliza apertura al rango util observado [1.05 puño .. 1.85 abierta]
export function aperture01(landmarks) {
  return clamp((handAperture(landmarks) - 1.05) / 0.8);
}
// Captura suave: al enganchar ancla apertura y valor actuales; despues el
// parametro sigue el DELTA de apertura. Al perder la mano conserva el valor.
export class ClawController {
  constructor({ engageMs = 500 } = {}) { this.engageMs = engageMs; this.reset(); }
  reset() { this.engaged = false; this._since = null; this._anchorA = 0; this._anchorV = 0; this.value = null; }
  // opts: { min, max, sensitivity, invert, rangeMin01, rangeMax01 }
  update(sample, now, opts) {
    // sample: null (sin mano) | { aperture01, pinched }
    if (!sample || sample.pinched) { // la pinza manda: la garra se suelta sin tocar el valor
      const was = this.engaged; this.engaged = false; this._since = null;
      return { engaged: false, value: this.value, event: was ? 'released' : null };
    }
    if (!this.engaged) {
      if (this._since === null) this._since = now;
      if (now - this._since >= this.engageMs && this.value !== null) {
        this.engaged = true; this._anchorA = sample.aperture01; this._anchorV = this.value;
        return { engaged: true, value: this.value, event: 'engaged' }; // sin salto al enganchar
      }
      return { engaged: false, value: this.value, event: null };
    }
    const span = (opts.max - opts.min) * (opts.rangeMax01 - opts.rangeMin01);
    const base = opts.min + (opts.max - opts.min) * opts.rangeMin01;
    let delta = (sample.aperture01 - this._anchorA) * opts.sensitivity;
    if (opts.invert) delta = -delta;
    const target = clamp(this._anchorV + delta * span, base, base + span);
    // Suavizado exponencial hacia el objetivo
    this.value = this.value + (target - this.value) * 0.25;
    return { engaged: true, value: this.value, event: null };
  }
  // Mientras no esta enganchada, sigue el valor real: si el usuario mueve el
  // parametro a mano, al re-enganchar no hay salto de vuelta al valor viejo.
  prime(currentValue) { if (!this.engaged) this.value = currentValue; }
  setValue(v) { this.value = v; this.engaged = false; this._since = null; }
}
// Compuerta de arbitraje: la garra solo puede correr en condiciones muy
// estrechas, para que nunca robe una pinza, un agarre ni un gesto a dos manos.
// Exige exactamente una mano presente, sin pinzas, sin agarres y sin ninguna
// sesion/transicion en curso. Si algo de eso cambia, la garra se suelta.
export function clawGate({ enabled, handCount, anyPinched, anyGrabbed, twoHandBusy, expressiveActive, autoTransition } = {}) {
  if (!enabled) return { run: false, reason: 'desactivada' };
  if (autoTransition) return { run: false, reason: 'transicion automatica en curso' };
  if (expressiveActive) return { run: false, reason: 'modo expresivo activo' };
  if (twoHandBusy) return { run: false, reason: 'gesto a dos manos en curso' };
  if (handCount !== 1) return { run: false, reason: handCount === 0 ? 'sin mano' : 'dos manos presentes' };
  if (anyPinched) return { run: false, reason: 'pinza activa' };
  if (anyGrabbed) return { run: false, reason: 'control tomado con pinza' };
  return { run: true, reason: 'una mano libre, sin pinza' };
}
