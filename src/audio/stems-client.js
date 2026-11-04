// Cliente del servidor local de stems (Meta Demucs, stems-server/server.py).
// La app sigue funcionando igual si el servidor no esta: los stems son un extra.
export const STEMS_URL = 'http://127.0.0.1:8765';
export const STEM_KEYS = ['vocals', 'drums', 'bass', 'other'];
export const STEM_LABELS = { vocals: 'VOZ', drums: 'BATERÍA', bass: 'BAJO', other: 'RESTO' };
export const STEM_COLORS = { vocals: '#FACC15', drums: '#FB923C', bass: '#60A5FA', other: '#2DD4BF' };

export async function stemsServerUp(base = STEMS_URL, timeoutMs = 1200) {
  try {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await fetch(`${base}/health`, { signal: ctl.signal }); clearTimeout(t);
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// Sube la cancion, espera a que Demucs termine y devuelve su id (sha-256).
// onProgress(0..1); isCancelled() corta la espera si cambio la pista del deck.
export async function separateStems(bytes, name, { base = STEMS_URL, onProgress = () => {}, isCancelled = () => false, pollMs = 600 } = {}) {
  const r = await fetch(`${base}/separate`, { method: 'POST', body: bytes, headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(name || 'pista') } });
  if (!r.ok) throw new Error(`separate ${r.status}`);
  let { id, state } = await r.json();
  while (state === 'queued' || state === 'running') {
    if (isCancelled()) return null;
    await new Promise(res => setTimeout(res, pollMs));
    const s = await (await fetch(`${base}/status/${id}`)).json();
    state = s.state; onProgress(s.progress || 0);
    if (state === 'error') throw new Error(s.error || 'error de Demucs');
  }
  return state === 'done' ? id : null;
}

// Une 4 stems estereo en un buffer de 8 canales con la longitud exacta de la
// pista original (recorta o rellena con silencio), para que suenen alineados.
export function buildStemBuffer(ctx, stemBuffers, length, sampleRate = ctx.sampleRate) {
  const out = ctx.createBuffer(8, length, sampleRate);
  stemBuffers.forEach((b, k) => {
    for (let c = 0; c < 2; c++) {
      const src = b.getChannelData(Math.min(c, b.numberOfChannels - 1));
      out.getChannelData(2 * k + c).set(src.length > length ? src.subarray(0, length) : src);
    }
  });
  return out;
}

export async function loadStemBuffers(ctx, id, { base = STEMS_URL } = {}) {
  return Promise.all(STEM_KEYS.map(async k => {
    const r = await fetch(`${base}/stems/${id}/${k}.wav`);
    if (!r.ok) throw new Error(`stem ${k} ${r.status}`);
    return ctx.decodeAudioData(await r.arrayBuffer());
  }));
}
