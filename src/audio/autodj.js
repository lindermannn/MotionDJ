// Auto DJ basico: logica pura, sin DOM ni Web Audio.
// Alterna A -> B -> A solo si el deck de destino tiene una pista preparada.
// No hace beatmatching: el BPM es estimado y SYNC solo iguala tempo.
// decks: [{ hasTrack, playing, position, duration }] ; cross en [-1,1]
export function evaluateAutoDj({ enabled, decks, cross = 0, anticipationSec = 15 } = {}) {
  const list = Array.isArray(decks) ? decks : [];
  const playing = list.map((d, i) => (d && d.playing ? i : -1)).filter(i => i >= 0);
  if (!enabled) return { state: 'off', active: null, next: null, ready: false, shouldTransition: false, remainingSec: null, reason: 'Auto DJ desactivado.' };
  if (!playing.length) return { state: 'waiting', active: null, next: null, ready: false, shouldTransition: false, remainingSec: null, reason: 'Ningun deck esta sonando. Pulsa PLAY en un deck para empezar.' };
  // Si suenan los dos, manda el lado favorecido por el crossfader.
  const active = playing.length === 1 ? playing[0] : (cross > 0 ? 1 : 0);
  const next = 1 - active;
  const dest = list[next] || {};
  const cur = list[active] || {};
  const remainingSec = (Number.isFinite(cur.duration) && Number.isFinite(cur.position)) ? Math.max(0, cur.duration - cur.position) : null;
  if (!dest.hasTrack) {
    return { state: 'waiting', active, next, ready: false, shouldTransition: false, remainingSec, reason: `Falta pista en el deck ${'AB'[next]}. Cargala con LOAD ${'AB'[next]} mientras suena ${'AB'[active]}; no se reemplazara la que suena.` };
  }
  const anticipation = Math.max(0, Number(anticipationSec) || 0);
  const due = remainingSec !== null && remainingSec <= anticipation;
  return {
    state: due ? 'due' : 'armed',
    active, next, ready: true,
    shouldTransition: due,
    remainingSec,
    reason: due
      ? `Quedan ${Math.ceil(remainingSec)} s en ${'AB'[active]}: momento de pasar a ${'AB'[next]}.`
      : `Sonando ${'AB'[active]}; destino ${'AB'[next]} listo. Transicion al quedar ${anticipation} s.`
  };
}
// Clave del disparo: una sola transicion automatica por pista activa.
export function autoDjTriggerKey(plan, trackIds) {
  if (!plan || plan.active === null || plan.active === undefined) return null;
  return `${plan.active}:${trackIds?.[plan.active] ?? '?'}`;
}
