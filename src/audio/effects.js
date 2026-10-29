// Base para el futuro control de efectos a dos manos.
// Solo catalogo y seleccion: seleccionar un efecto NUNCA cambia el audio.
// El control expresivo a dos manos actual (transicion) no usa este modulo.
export const EFFECT_CATALOG = Object.freeze([
  Object.freeze({ id: 'filter', label: 'Filtro', targetParam: 'filter', range: [-50, 50], unit: '', note: 'Pase bajo del deck elegido' }),
  Object.freeze({ id: 'delay', label: 'Eco (delay)', targetParam: 'delay', range: [0, 0.8], unit: '%', note: 'Envio de eco del deck elegido' }),
  Object.freeze({ id: 'low', label: 'Graves (LOW)', targetParam: 'low', range: [-24, 24], unit: ' dB', note: 'Estante de graves del deck elegido' })
]);
export function createEffectSelection() {
  return { effectId: EFFECT_CATALOG[0].id, deck: 0 };
}
// step: +1 siguiente, -1 anterior. Devuelve una seleccion nueva.
export function cycleEffect(selection, step = 1) {
  const idx = Math.max(0, EFFECT_CATALOG.findIndex(e => e.id === selection?.effectId));
  const next = EFFECT_CATALOG[(idx + step + EFFECT_CATALOG.length) % EFFECT_CATALOG.length];
  return { effectId: next.id, deck: selection?.deck === 1 ? 1 : 0 };
}
export function effectById(id) {
  return EFFECT_CATALOG.find(e => e.id === id) || EFFECT_CATALOG[0];
}
