// Efectos a dos pinzas (prototipo): maquina de estados pura y testeable.
// Seleccionar/preparar NUNCA cambia el audio: el valor solo se mueve en
// 'adjusting', anclado al valor y a la posicion actuales (sin salto).
// Soltar una pinza o perder una mano >300 ms congela el valor donde esta.
// Efectos del prototipo: Filtro (1 parametro) y Eco (cantidad + distancia
// entre manos = realimentacion, con techo 0,5).
import { clamp } from '../gestures/logic.js';
export const FX_PARAMS = Object.freeze({
  filter: Object.freeze({ min: -50, max: 50, label: 'Filtro' }),
  delay: Object.freeze({ min: 0, max: 0.8, label: 'Eco' })
});
export function fxCanAdjust({ anyGrabbed = false, twoHandBusy = false, autoTransition = false } = {}) {
  return !anyGrabbed && !twoHandBusy && !autoTransition;
}
export class FxSession {
  constructor({ pxFull = 260, lossMs = 300 } = {}) {
    this.pxFull = pxFull; this.lossMs = lossMs;
    this.state = 'idle'; // idle | palette | prepared | adjusting | frozen
    this.effectId = 'filter'; this.deck = 0;
    this.value = 0; this.feedback = 0.32;
    this.anchor = null; this._return = 'idle'; this._lostSince = null;
  }
  openPalette() {
    if (this.state === 'adjusting' || this.state === 'palette') return;
    this._return = (this.state === 'prepared' || this.state === 'frozen') ? this.state : 'idle';
    this.state = 'palette';
  }
  closePalette() { if (this.state === 'palette') this.state = this._return || 'idle'; }
  select(effectId, deck) {
    if (!FX_PARAMS[effectId]) return;
    this.effectId = effectId;
    if (deck === 0 || deck === 1) this.deck = deck;
  }
  prepare(currentValue) {
    this.value = Number.isFinite(currentValue) ? currentValue : 0;
    this.state = 'prepared'; this.anchor = null; this._lostSince = null;
  }
  unprepare() { this.state = 'idle'; this.anchor = null; this._lostSince = null; }
  beginAdjust({ value, y, dist01 = 0, feedback = 0.32 }) {
    if (this.state !== 'prepared' && this.state !== 'frozen') return null;
    this.value = value; this.feedback = feedback;
    this.anchor = { value, y, dist01, feedback };
    this.state = 'adjusting'; this._lostSince = null;
    return this.value; // anclado: sin movimiento no hay salto
  }
  adjust({ y, dist01 = 0 }) {
    if (this.state !== 'adjusting' || !this.anchor) return null;
    const p = FX_PARAMS[this.effectId];
    this.value = clamp(this.anchor.value + (this.anchor.y - y) / this.pxFull * (p.max - p.min), p.min, p.max);
    if (this.effectId !== 'delay') return { value: this.value };
    this.feedback = clamp(this.anchor.feedback + (dist01 - this.anchor.dist01) * 0.6, 0, 0.5);
    return { value: this.value, feedback: this.feedback };
  }
  freeze() {
    if (this.state !== 'adjusting') return null;
    this.state = 'frozen'; this.anchor = null; this._lostSince = null;
    return 'frozen'; // el valor queda donde esta
  }
  notePresence({ bothPresent, bothPinched }, now) {
    if (this.state !== 'adjusting') return null;
    if (!bothPresent) {
      if (this._lostSince === null) this._lostSince = now;
      return now - this._lostSince >= this.lossMs ? this.freeze() : null;
    }
    this._lostSince = null;
    return bothPinched ? null : this.freeze();
  }
}
