// Cola de reproduccion: logica pura, sin DOM.
// La cola guarda referencias a pistas; "siguiente" siempre va al deck que
// NO esta sonando. Nunca devuelve un deck en reproduccion.
export function enqueue(queue, track) {
  return track ? [...queue, track] : [...queue];
}
export function removeFromQueue(queue, index) {
  return queue.filter((_, i) => i !== index);
}
export function takeNext(queue) {
  if (!queue.length) return { track: null, queue: [] };
  return { track: queue[0], queue: queue.slice(1) };
}
// Indice del deck libre: el que no suena. Si suenan los dos: -1.
export function freeDeckIndex(playing) {
  if (!playing[0]) return 0;
  if (!playing[1]) return 1;
  return -1;
}
// Selector PISTAS (P3.5): ventana visible y reordenamiento, logica pura.
export function pickerWindow(total, start, pageSize = 7) {
  const s = Math.max(0, Math.min(Math.trunc(start) || 0, Math.max(0, total - pageSize)));
  return { start: s, end: Math.min(total, s + pageSize) };
}
export function moveItem(list, index, dir) {
  const j = index + dir;
  if (index < 0 || j < 0 || j >= list.length) return [...list];
  const out = [...list]; [out[index], out[j]] = [out[j], out[index]];
  return out;
}
// Carga segura: libre = inmediata; sonando = exige confirmacion mantenida.
export function loadSafety({ hasTrack, playing }) {
  if (playing) return 'confirm-hold';
  return 'immediate';
}
// Cierre automatico del selector sin manos (solo con gestos activos):
// con manos o con actividad reciente de raton/teclado no se cierra nunca.
export function pickerIdleState({ open, gesturesOn, handsPresent, lastActivityAt, now, timeoutMs = 7000 }) {
  if (!open || !gesturesOn || handsPresent) return { state: 'open', remainingMs: null };
  const elapsed = Math.max(0, (now || 0) - (lastActivityAt || 0));
  const remainingMs = timeoutMs - elapsed;
  return remainingMs <= 0 ? { state: 'close', remainingMs: 0 } : { state: 'countdown', remainingMs };
}
export function pickerPointingText(name) {
  return name ? `Apuntando: ${name}` : 'Sin mano sobre la lista: mueve la mano para apuntar a una pista';
}
export function pickerCountdownText(remainingMs) {
  return `Se cerrará en ${Math.ceil(Math.max(0, remainingMs) / 1000)} s sin manos`;
}
// Deck destino para "siguiente": prefiere un deck sin pista y parado;
// si no, el que no suena; si suenan los dos, -1 (nunca reemplazar sin mas).
export function chooseTargetDeck(states) {
  const empty = states.findIndex(s => !s.playing && !s.hasTrack);
  if (empty >= 0) return empty;
  return freeDeckIndex(states.map(s => s.playing));
}
