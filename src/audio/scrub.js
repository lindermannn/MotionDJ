// Logica pura del scrub/busqueda con el jog (P3), testeable sin DOM.
// Velocidades con signo: negativo = hacia atras (el worklet lo reproduce).
export function clampSpeed(v, max = 3) { return Math.max(-max, Math.min(max, Number(v) || 0)); }
// Velocidad de scrub desde el giro del jog: vueltas/s x segundos por vuelta.
export function jogSpeed(revPerSec, secPerRev = 1.8) {
  return clampSpeed((Number(revPerSec) || 0) * (secPerRev > 0 ? secPerRev : 1.8));
}
// Posicion tras avanzar dt segundos a una velocidad dada, con vuelta al
// llegar al final/principio (la pista es circular para el scrub).
export function scrubPosition(pos, speed, dtSec, duration) {
  if (!(duration > 0)) return 0;
  let p = (Number(pos) || 0) + (Number(speed) || 0) * (Number(dtSec) || 0);
  p %= duration;
  return p < 0 ? p + duration : p;
}
// Empuje (nudge): factor temporal de velocidad al girar el anillo.
// Al soltar, el llamador restaura exactamente el rate previo.
export function nudgeFactor(revPerSec) {
  return 1 + Math.max(-0.16, Math.min(0.16, (Number(revPerSec) || 0) * 0.08));
}
