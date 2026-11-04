// Colas por deck (lineup): logica pura, sin DOM ni audio.
// Cada deck tiene su propia cola en el orden en que se eligieron los temas.
// Un tema esta como mucho en una cola: agregarlo al otro lado lo mueve.
// Los profesionales usan una sola lista (Serato Prepare, Traktor
// Preparation List); aqui el lado se elige al preparar, para no buscar
// temas con las manos en medio de la mezcla.
export function emptyQueues() { return [[], []]; }
export function addToDeck(queues, deck, track) {
  if (!track || (deck !== 0 && deck !== 1)) return queues.map(q => [...q]);
  const out = queues.map(q => q.filter(t => t !== track));
  out[deck].push(track);
  return out;
}
export function removeAt(queues, deck, index) {
  return queues.map((q, d) => d === deck ? q.filter((_, i) => i !== index) : [...q]);
}
export function moveAt(queues, deck, index, dir) {
  return queues.map((q, d) => {
    const out = [...q];
    if (d !== deck) return out;
    const j = index + dir;
    if (index < 0 || j < 0 || j >= out.length) return out;
    [out[index], out[j]] = [out[j], out[index]];
    return out;
  });
}
export function takeFromDeck(queues, deck) {
  const q = queues[deck] || [];
  if (!q.length) return { track: null, queues: queues.map(x => [...x]) };
  return { track: q[0], queues: queues.map((x, d) => d === deck ? x.slice(1) : [...x]) };
}
export function dropTrack(queues, track) { return queues.map(q => q.filter(t => t !== track)); }
// Etiqueta «A·1» / «B·2» para la tabla, o null si no esta en cola.
export function queueTag(queues, track) {
  for (let d = 0; d < 2; d++) { const i = (queues[d] || []).indexOf(track); if (i >= 0) return `${'AB'[d]}·${i + 1}`; }
  return null;
}
// Deck libre para cargar el siguiente de su cola: no suena y, o no tiene
// pista, o su pista ya sono y ademas termino o el crossfader esta del otro
// lado (se mezclo hacia el otro deck). Nunca pisa una pista preparada que
// aun no sono, ni un deck pausado un momento con el crossfader en su lado.
export function deckFree({ hasTrack = false, playing = false, played = false, ended = false, crossAway = false } = {}) {
  if (playing) return false;
  if (!hasTrack) return true;
  return played && (ended || crossAway);
}
// Orden de la tabla por columna; los valores vacios van al final.
export function sortTracks(list, key = null, dir = 1) {
  if (!key) return [...list];
  const val = t => key === 'name' ? (t.name || '').toLowerCase() : key === 'bpm' ? (t.metaBpm ?? null) : key === 'dur' ? (t.duration ?? null) : null;
  return [...list].sort((a, b) => {
    const va = val(a), vb = val(b);
    if (va === null && vb === null) return 0; if (va === null) return 1; if (vb === null) return -1;
    return (va < vb ? -1 : va > vb ? 1 : 0) * (dir < 0 ? -1 : 1);
  });
}
