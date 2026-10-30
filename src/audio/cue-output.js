// Seleccion de salida de preescucha: logica pura, testeable sin DOM.
// Chrome solo da nombres (label) e ids estables de las salidas tras un
// permiso (getUserMedia o selectAudioOutput); sin el, la lista sale vacia
// o con un unico dispositivo sin nombre. Por eso la app primero pide la
// eleccion/permiso y luego enumera.
export function normalizeOutputs(devices) {
  const seen = new Set(), out = [];
  for (const d of devices || []) {
    if (d.kind !== 'audiooutput') continue;
    const deviceId = d.deviceId || '';
    const label = (d.label || '').trim();
    const key = deviceId + '|' + label;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      deviceId, label,
      isAlias: deviceId === 'default' || deviceId === 'communications',
      displayName: label || 'Dispositivo sin nombre (Chrome no lo revela sin permiso)'
    });
  }
  return out;
}
// Estado del dispositivo guardado frente a la lista actual.
export function resolveSavedCue(devices, saved) {
  if (!saved?.deviceId) return { status: 'none', device: null };
  const found = (devices || []).find(d => d.deviceId === saved.deviceId);
  if (found) return { status: 'found', device: found };
  // Sin lista todavia (falta permiso): no se puede verificar, se conserva.
  if (!devices || devices.length === 0) return { status: 'unverified', device: { deviceId: saved.deviceId, label: saved.label || '' } };
  return { status: 'missing', device: null };
}
// Bloqueo: la preescucha no puede ir a la misma salida que la mezcla.
// La mezcla sale por el dispositivo predeterminado del sistema: sus alias
// son 'default'/'communications' o el mismo nombre que el alias.
export function cueBlockReason(cue, devices) {
  if (!cue?.deviceId) return 'sin-elegir';
  if (cue.deviceId === 'default' || cue.deviceId === 'communications') return 'coincide-mezcla';
  const alias = (devices || []).find(d => d.deviceId === 'default' || d.deviceId === 'communications');
  if (alias?.label && cue.label && alias.label === cue.label) return 'coincide-mezcla';
  return null;
}
export function cueStateText({ activeDeck = null, deviceName = '' } = {}) {
  if (activeDeck === null || activeDeck === undefined) return 'Preescucha: apagada';
  return `Preescucha: activa en ${deviceName || 'salida elegida'} · Deck ${'AB'[activeDeck]}`;
}
