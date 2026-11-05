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
  hit(x, y, predicate = null) {
    let best = null;
    for (const c of this.controls.values()) {
      if (predicate && !predicate(c)) continue;
      if (c.disabled) continue;
      const r = c.rect;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
        // Gana mayor z; a igual z, la zona mas pequena (la mas especifica).
        // Asi, con zonas ampliadas solapadas, no se toma la perilla vecina.
        if (!best || (c.z || 0) > (best.z || 0) || ((c.z || 0) === (best.z || 0) && r.w * r.h < best.rect.w * best.rect.h)) best = c;
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
// Perilla con arrastre horizontal relativo: empieza en el valor actual
// (dx=0 => sin salto) y recorre el rango completo en pxFull pixeles.
// Posicion de la perilla [0..1]. Si el rango cruza 0 (EQ de -26 a +6 dB),
// el 0 queda SIEMPRE al centro, arriba, como en una mesa real: cada lado
// tiene su propia escala. Con rango simetrico es igual a lineal.
export function knobPos01(value, min, max) {
  if (!(max > min)) return 0;
  const v = clamp(Number(value) || 0, min, max);
  if (min < 0 && max > 0) return v < 0 ? 0.5 * (v - min) / -min : 0.5 + 0.5 * v / max;
  return (v - min) / (max - min);
}
export function knobValueAt(pos01, min, max) {
  const f = clamp(pos01);
  if (min < 0 && max > 0) return f < 0.5 ? min + (f / 0.5) * -min : ((f - 0.5) / 0.5) * max;
  return min + f * (max - min);
}
export function knobDragValue(startValue, dxPx, min, max, pxFull = 220) {
  const px = pxFull > 0 ? pxFull : 220;
  return clamp(knobValueAt(knobPos01(startValue, min, max) + dxPx / px, min, max), min, max);
}
// Scratch minimo por velocidad: el jog gira a revPerSec vueltas/s y cada
// vuelta equivale a secPerRev segundos de pista. Sin velocidad negativa:
// playbackRate no admite reverse (eso exigiria un worklet, ver estado.md).
export function scratchRate(revPerSec, baseRate, secPerRev = 1.8) {
  const speed = Math.abs(revPerSec) * secPerRev;
  return Math.min(3, Math.max(0, speed)) * (baseRate || 1);
}
// Diferencia angular desenvuelta (-PI..PI) entre dos muestras del jog.
export function jogAngleDelta(prev, curr) {
  let d = curr - prev;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
// Ventana de la onda ampliada (Etapa 12): [start,end] en segundos, centrada
// en la posicion y pegada a los bordes; frac = posicion de la posicion
// dentro de la ventana (0..1) para dibujar el cursor.
export function zoomWindow(pos, duration, winSec = 8) {
  const win = Math.min(Math.max(winSec || 8, 1), Math.max(duration || 0, 1));
  if (!(duration > 0)) return { start: 0, end: win, frac: 0 };
  let start = Math.min(Math.max(pos - win / 2, 0), Math.max(0, duration - win));
  return { start, end: start + win, frac: Math.min(1, Math.max(0, (pos - start) / win)) };
}
// Valores por defecto del boton Restablecer (P1): calibracion conocida y
// mezclador neutro. Las pistas cargadas y lo que suena NO se tocan.
export const RESET_DEFAULTS = Object.freeze({
  cal: Object.freeze({ scale: 1, x: 0, y: 0, sens: 0.38, size: 1, knob: 220 }),
  params: Object.freeze({ high: 0, mid: 0, low: 0, trim: 1, filter: 0, eco: 0, vol: 0.85, tempo: 0, cross: 0, master: 0.85 })
});
// Saneado de la calibracion persistida: campo invalido -> valor por defecto.
export function sanitizeCal(raw) {
  const d = RESET_DEFAULTS.cal, c = raw && typeof raw === 'object' ? raw : {};
  const num = (v, lo, hi, def) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
  return {
    s: num(c.s, 0.7, 1.15, d.scale), x: num(c.x, -120, 120, d.x), y: num(c.y, -360, 80, d.y),
    sens: num(c.sens, 0.25, 0.55, d.sens), size: num(c.size, 0.9, 1.3, d.size), knob: num(c.knob, 120, 420, d.knob)
  };
}
// Guardarrail de graves (P4): aviso cuando ambos LOW estan fuertes y el
// crossfader esta en zona central. Propone, nunca bloquea.
export function bassClash(lowA, lowB, cross, { lowThreshold = 3, crossZone = 0.35 } = {}) {
  return Number(lowA) >= lowThreshold && Number(lowB) >= lowThreshold && Math.abs(Number(cross) || 0) <= crossZone;
}
// Reten del tempo: cerca de 0 % el fader se queda en 0 (Etapa 11).
export function tempoDetent(v, zone = 0.3) { return Math.abs(v) <= zone ? 0 : v; }
// Arrastre en la onda: clic/pinza = salto al punto; mantener y mover =
// ajuste fino relativo anclado. pxPer10s: pixeles para recorrer 10 s de
// pista (defecto 220, igual que el recorrido de perilla).
export function waveDragPosition(startPos, dxPx, duration, pxPer10s = 220) {
  const px = pxPer10s > 0 ? pxPer10s : 220;
  const pos = startPos + (dxPx / px) * 10;
  return Math.min(duration, Math.max(0, pos));
}
// Angulo de la aguja de una perilla: -135° (min) .. +135° (max).
export function knobAngle(value, min, max) {
  return -135 + knobPos01(value, min, max) * 270;
}
// Amplia una zona de interaccion y garantiza un tamano minimo (44px recomendado).
export function expandRect(r, pad = 14, minW = 44, minH = 40) {
  const w = Math.max(r.w + pad * 2, minW), h = Math.max(r.h + pad * 2, minH);
  return { x: r.x + r.w / 2 - w / 2, y: r.y + r.h / 2 - h / 2, w, h };
}
// Rectangulo del contenido del video dentro de una caja (la del elemento
// <video>), segun object-fit y object-position (fracciones 0..1, def. centro).
// Sin deformar: escala uniforme; en 'cover' el rectangulo excede la caja.
export function videoContentRect(vw, vh, boxW, boxH, fit = 'contain', pos = { x: 0.5, y: 0.5 }) {
  const safeW = vw > 0 ? vw : 1280, safeH = vh > 0 ? vh : 720;
  const sc = fit === 'cover' ? Math.max(boxW / safeW, boxH / safeH) : Math.min(boxW / safeW, boxH / safeH);
  const w = safeW * sc, h = safeH * sc;
  return { x: (boxW - w) * (pos?.x ?? 0.5) + 0, y: (boxH - h) * (pos?.y ?? 0.5) + 0, w, h };
}
// Ajuste efectivo a partir del object-fit REALMENTE aplicado al video.
// El mapeo usa siempre este valor (leido del estilo computado), para que
// puntero y video no puedan desincronizarse aunque difieran el estado JS,
// la hoja de estilos o el atributo data-* del escenario.
export function fitFromObjectFit(objectFit) {
  return objectFit === 'cover' ? 'cover' : 'contain';
}
// Interpreta el object-position calculado ('50% 50%', 'left top', ...).
export function parseObjectPosition(str) {
  const kw = { left: 0, top: 0, center: 0.5, right: 1, bottom: 1 };
  const t = String(str || '50% 50%').trim().split(/\s+/);
  const val = (tok, isX) => {
    if (tok === undefined) return 0.5;
    if (tok.endsWith('%')) return clamp(parseFloat(tok) / 100);
    if (tok in kw) return kw[tok];
    const n = parseFloat(tok); return Number.isFinite(n) ? n : 0.5;
  };
  // Palabras clave verticales/horizontales pueden venir en cualquier orden.
  let xTok = t[0], yTok = t[1];
  if (t[0] === 'top' || t[0] === 'bottom') { yTok = t[0]; xTok = t[1] ?? 'center'; }
  if (t[1] === 'left' || t[1] === 'right') { xTok = t[1]; yTok = t[0]; }
  return { x: val(xTok, true), y: val(yTok, false) };
}
// Convierte un landmark a coordenadas de una caja en (0,0), corrigiendo
// espejo y ajuste. fit='contain': imagen completa, con bandas.
// fit='cover': llena el area recortando.
export function mapVideoPoint(lm, vw, vh, stageW, stageH, mirrored = true, fit = 'contain', pos = { x: 0.5, y: 0.5 }) {
  const r = videoContentRect(vw, vh, stageW, stageH, fit, pos);
  const nx = mirrored ? 1 - lm.x : lm.x;
  return { x: r.x + nx * r.w, y: r.y + lm.y * r.h };
}
// Igual, pero la caja del video esta desplazada (box = rectangulo REAL del
// elemento <video> en coordenadas del escenario). Es la via que usa la app:
// no supone que el video mida lo mismo que el escenario.
export function mapVideoPointInBox(lm, vw, vh, box, mirrored = true, fit = 'contain', pos = { x: 0.5, y: 0.5 }) {
  const p = mapVideoPoint(lm, vw, vh, box.w, box.h, mirrored, fit, pos);
  return { x: box.x + p.x, y: box.y + p.y };
}
// Ventana normalizada de la fuente que realmente se ve en la caja.
// En contain es toda; en cover es el recorte efectivo.
export function visibleVideoWindow(vw, vh, boxW, boxH, fit = 'contain', pos = { x: 0.5, y: 0.5 }) {
  const r = videoContentRect(vw, vh, boxW, boxH, fit, pos);
  return {
    u0: clamp(-r.x / r.w), v0: clamp(-r.y / r.h),
    u1: clamp((boxW - r.x) / r.w), v1: clamp((boxH - r.y) / r.h)
  };
}
// Compatibilidad: nombre anterior, equivalente a fit='cover'.
export function mapCoverPoint(lm, vw, vh, stageW, stageH, mirrored = true) {
  return mapVideoPoint(lm, vw, vh, stageW, stageH, mirrored, 'cover');
}
// Rectangulo del contenido del video dentro del escenario (diagnostico).
export function videoViewport(vw, vh, stageW, stageH, fit = 'contain', pos = { x: 0.5, y: 0.5 }) {
  return videoContentRect(vw, vh, stageW, stageH, fit, pos);
}
// Identidad estable de manos: MediaPipe puede devolver las detecciones en
// otro orden al cruzarse las manos. Empareja cada deteccion con el hueco
// (slot 0/1) cuya muneca anterior este mas cerca; asi un hueco no hereda la
// mano de la otra. Devuelve, por hueco, el indice de deteccion o -1.
// Huecos sin muneca anterior o detecciones sin pareja van al primer hueco
// libre, sin robar uno ocupado. maxDist en coordenadas normalizadas.
export function assignHandSlots(prevSlots, detections, maxDist = 0.35) {
  const slots = prevSlots || [], dets = detections || [];
  const out = slots.map(() => -1);
  const used = new Set(), pairs = [];
  slots.forEach((s, si) => {
    if (!s?.wrist) return;
    dets.forEach((d, di) => { if (d?.wrist) pairs.push({ d: Math.hypot(s.wrist.x - d.wrist.x, s.wrist.y - d.wrist.y), si, di }); });
  });
  pairs.sort((a, b) => a.d - b.d);
  for (const p of pairs) {
    if (p.d > maxDist || out[p.si] !== -1 || used.has(p.di)) continue;
    out[p.si] = p.di; used.add(p.di);
  }
  dets.forEach((d, di) => {
    if (used.has(di)) return;
    const free = out.indexOf(-1);
    if (free >= 0) { out[free] = di; used.add(di); }
  });
  return out;
}
export function handsDistance(p0, p1, stageW) {
  return clamp(Math.hypot(p0.x - p1.x, p0.y - p1.y) / (stageW * 0.6));
}
// Maquina de estados a dos manos: nunca se activa por accidente.
// idle --(ambas pinzas >=holdMs)--> prepared --(soltar)--> armed
// armed --(ambas pinzas)--> confirmed (automatico) / engaged (expresivo)
// En engaged, perder una mano >lossMs produce 'freeze' y vuelve a idle.
export class TwoHandSession {
  constructor({ holdMs = 700, lossMs = 300 } = {}) {
    this.holdMs = holdMs; this.lossMs = lossMs;
    this.state = 'idle'; this._since = null; this._lostSince = 0;
  }
  reset() { this.state = 'idle'; this._since = null; this._lostSince = 0; }
  update({ bothPinched, bothPresent }, now) {
    let event = null;
    if (this.state === 'idle') {
      if (bothPinched) { if (this._since === null) this._since = now; if (now - this._since >= this.holdMs) { this.state = 'prepared'; event = 'prepared'; this._since = null; } }
      else this._since = null;
    } else if (this.state === 'prepared') {
      if (!bothPinched && bothPresent) { this.state = 'armed'; event = 'armed'; }
    } else if (this.state === 'armed') {
      if (bothPinched) { this.state = 'active'; event = 'confirmed'; }
    } else if (this.state === 'active') {
      if (!bothPresent) { if (!this._lostSince) this._lostSince = now; if (now - this._lostSince >= this.lossMs) { this.state = 'idle'; event = 'freeze'; this._lostSince = 0; } }
      else this._lostSince = 0;
      if (event !== 'freeze' && bothPresent && !bothPinched) { this.state = 'idle'; event = 'released'; }
    }
    return { state: this.state, event };
  }
}
