// Modo manos: logica pura del barrido de filtro a dos manos,
// el latido con la rejilla y la salida instantanea. Sin DOM.
// Apertura normalizada a [0,1]: 0 = manos juntas, 1 = muy separadas.
// Mapeo acordado (correcciones Bloque 3): juntas = LP cerrado (-50),
// separadas = Neutro (0, sonido completo). El pasa-altos (+50) solo
// existe si se activa el interruptor «Pasa-altos» en la barra del modo.
import { clamp } from '../gestures/logic.js';
export function aperturaToFilter(a, { highpass = false } = {}) {
  const t = clamp(Number(a) || 0, 0, 1);
  if (highpass) return clamp((t - 0.5) * 100, -50, 50);
  return clamp(-50 + t * 50, -50, 0);
}
export function filterRange(highpass = false) { return highpass ? { min: -50, max: 50 } : { min: -50, max: 0 }; }
export function aperturaFromDistance(distPx, stageW, near = 0.15, far = 0.75) {
  if (!(stageW > 0)) return 0.5;
  return clamp(((distPx / stageW) - near) / (far - near), 0, 1);
}
// Punto de pinza de una mano: medio entre pulgar (4) e indice (8).
// Es el mismo punto para medir la distancia y para dibujar el arco.
export function pinchPoint(lm) {
  if (!lm || !lm[4] || !lm[8]) return null;
  return { x: (lm[4].x + lm[8].x) / 2, y: (lm[4].y + lm[8].y) / 2 };
}
// Anclaje relativo: al agarrar, la distancia actual vale el filtro
// actual; solo se aplica el cambio de distancia. Sin salto.
export function anchoredFilter({ anchorDist01, anchorFilter, dist01, highpass = false, dead01 = 0.008 } = {}) {
  const { min, max } = filterRange(highpass);
  const range = max - min;
  const d = (Number(dist01) || 0) - (Number(anchorDist01) || 0);
  const delta = Math.abs(d) <= dead01 ? 0 : d;
  return clamp((Number(anchorFilter) || 0) + delta * range, min, max);
}
// Rampa corta a Neutro (0) al soltar las dos pinzas.
export function neutralRampValue(from, elapsedMs, durationMs = 600) {
  const f = Number(from) || 0;
  if (!(durationMs > 0)) return 0;
  const t = clamp((Number(elapsedMs) || 0) / durationMs, 0, 1);
  const s = t * t * (3 - 2 * t);
  return f + (0 - f) * s;
}
// Puerta de agarre a dos pinzas: hace falta pinza en LAS DOS manos
// mantenida >= holdMs (con la histeresis que ya trae PinchDetector).
// Una pinza soltada congela; las dos soltadas piden rampa a Neutro.
export class DoublePinchGate {
  constructor({ holdMs = 150 } = {}) { this.holdMs = holdMs; this.state = 'reposo'; this._since = null; }
  reset() { this.state = 'reposo'; this._since = null; }
  update({ pinchCount = 0, now = 0 } = {}) {
    let event = null;
    const both = pinchCount >= 2, one = pinchCount === 1, none = pinchCount <= 0;
    if (this.state === 'reposo') {
      if (both) { this.state = 'armando'; this._since = now; }
    } else if (this.state === 'armando') {
      if (both) {
        if (now - this._since >= this.holdMs) { this.state = 'agarrado'; this._since = null; event = 'grabbed'; }
      } else { this.state = none ? 'reposo' : 'congelado'; this._since = null; if (!none) event = 'froze'; }
    } else if (this.state === 'agarrado') {
      if (one) { this.state = 'congelado'; event = 'froze'; }
      else if (none) { this.state = 'reposo'; event = 'released-both'; }
    } else if (this.state === 'congelado') {
      if (both) { this.state = 'armando'; this._since = now; }
      else if (none) { this.state = 'reposo'; event = 'released-both'; }
    }
    return { state: this.state, event };
  }
}
// Latido: indice de golpe y fase [0,1) desde la posicion y la rejilla.
export function beatPhaseAt(pos, firstBeat, period) {
  if (!(period > 0)) return null;
  const rel = (Number(pos) || 0) - (Number(firstBeat) || 0);
  const idx = Math.floor(rel / period);
  return { index: idx, phase: rel / period - idx };
}
// Ventana ritmica: el gesto "cae en el golpe" si llega dentro de la
// tolerancia (15% del periodo) alrededor del golpe esperado.
export function onBeat(phase, tolerance = 0.15) {
  if (phase === null || phase === undefined) return false;
  return phase <= tolerance || phase >= 1 - tolerance;
}
// Punto de una curva cuadratica (el arco) en t [0,1].
export function bezierPoint(p0, c, p1, t) {
  const u = 1 - t;
  return { x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x, y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y };
}
// Proximo tiempo 1 (downbeat, cada 4 golpes): golpes que faltan y
// progreso [0,1] de la marca que viaja por el arco hasta el.
export function downbeatInfo(beat) {
  if (!beat || !Number.isFinite(beat.index)) return null;
  const pos = beat.index + (Number(beat.phase) || 0);
  const next = Math.ceil((pos - 1e-6) / 4) * 4;
  const remaining = Math.max(0, next - pos);
  return { remainingBeats: remaining, beatsCount: Math.ceil(Math.max(0, remaining - 1e-9)), progress: clamp(1 - remaining / 4, 0, 1) };
}
// Color del arco segun el filtro: cian (LP cerrado) -> violeta -> magenta (abierto).
export function filterColor(filter, highpass = false) {
  const { min, max } = filterRange(highpass);
  const t = clamp(((Number(filter) || 0) - min) / Math.max(1, max - min), 0, 1);
  const stops = [[34, 211, 238], [157, 140, 255], [255, 79, 163]];
  const seg = t < 0.5 ? 0 : 1, f = t < 0.5 ? t * 2 : (t - 0.5) * 2;
  const a = stops[seg], b = stops[seg + 1];
  const rgb = a.map((v, i) => Math.round(v + (b[i] - v) * f));
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}
// El gesto elige el efecto (4B-B): pinza con las dos manos -> FILTRO,
// puno con una mano -> ECO. Si un efecto esta en uso (busy), el otro
// gesto no activa nada. La pinza manda si ambos llegan a la vez.
export function gestureEffectChoice({ doublePinchGrabbed = false, fistGrabbed = false, fingers = null, palmBrake = false, palmSuppressed = false, busy = false } = {}) {
  if (busy) return null;
  if (doublePinchGrabbed) return 'filter';
  if (fistGrabbed) return 'eco';
  if (fingers === 1 || fingers === 2 || fingers === 3) return 'roll';
  if (palmBrake && !palmSuppressed) return 'brake';
  return null; // 0 ya lo cubre el puno/ECO; 4 dedos = zona muerta
}
// Salida instantanea: sin ninguna mano durante marginMs -> salir.
// Solo tras haber visto manos (entrar y levantarlas no es "sacarlas")
// y nunca si el usuario esta usando el sustituto mouse/teclado.
export function handModeShouldExit({ anyHandPresent, lostSince, now, marginMs = 180, seenHands = true, mouseControl = false }) {
  if (anyHandPresent || mouseControl || !seenHands) return false;
  if (lostSince === null || lostSince === undefined) return false;
  return now - lostSince >= marginMs;
}
