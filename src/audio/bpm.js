// Estimacion de BPM por autocorrelacion de energia (orientativa, no exacta).
export function estimateBPM(audioBuffer) {
  try {
    const ch = audioBuffer.getChannelData(0);
    const sr = audioBuffer.sampleRate;
    const hop = 512, frame = 1024;
    const n = Math.floor((ch.length - frame) / hop);
    if (n < 100) return null;
    const energy = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0; const off = i * hop;
      for (let j = 0; j < frame; j += 4) { const v = ch[off + j]; s += v * v; }
      energy[i] = s;
    }
    const flux = new Float32Array(n);
    for (let i = 1; i < n; i++) flux[i] = Math.max(0, energy[i] - energy[i - 1]);
    const fps = sr / hop;
    const minLag = Math.floor(fps * 60 / 180), maxLag = Math.ceil(fps * 60 / 60);
    let bestLag = 0, best = -1;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let c = 0;
      for (let i = lag; i < n; i++) c += flux[i] * flux[i - lag];
      if (c > best) { best = c; bestLag = lag; }
    }
    if (!bestLag) return null;
    let bpm = 60 * fps / bestLag;
    while (bpm < 90) bpm *= 2;
    while (bpm > 180) bpm /= 2;
    return Math.round(bpm * 10) / 10;
  } catch { return null; }
}
export function computePeaks(audioBuffer, count = 240) {
  const ch = audioBuffer.getChannelData(0);
  const peaks = new Float32Array(count);
  const block = Math.floor(ch.length / count) || 1;
  for (let i = 0; i < count; i++) {
    let m = 0; const off = i * block;
    for (let j = 0; j < block; j += 16) { const v = Math.abs(ch[off + j] || 0); if (v > m) m = v; }
    peaks[i] = m;
  }
  return peaks;
}
