// Logica pura de la transicion "Mezcla suave" (sin DOM ni Web Audio).
// k en [0,1]. Devuelve valores listos para aplicar a los controles existentes.
export function smooth(k) { const t = Math.min(1, Math.max(0, k)); return t * t * (3 - 2 * t); }
export function transitionValues(k, fromCross, target) {
  const e = smooth(k);
  return {
    cross: fromCross + (target - fromCross) * e,
    lowOut: -18 * e,        // graves del deck que sale
    lowIn: 0,               // graves del deck que entra (sin recorte)
    delay: Math.sin(Math.PI * Math.min(1, Math.max(0, k))) * 0.3 // eco solo en el centro
  };
}
// Modo expresivo: progreso por posicion X de una mano y filtro por distancia.
export function expressiveValues(handX01, distance01, target) {
  const p = Math.min(1, Math.max(0, handX01));
  const cross = target === 1 ? -1 + 2 * p : 1 - 2 * p;
  return {
    progress: p, cross,
    lowOut: -18 * p, lowIn: 0,
    filter: -50 + Math.min(1, Math.max(0, distance01)) * 100 // -50 cerrado .. 50 abierto
  };
}
