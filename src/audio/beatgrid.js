// Beatgrid estimada: logica pura, sin DOM ni Web Audio.
// analyzeBeatgrid(channelData, sampleRate) -> { bpm, firstBeat, confidence, ambiguous }
// - Flujo espectral sobre la senal filtrada en graves (bombo).
// - Autocorrelacion normalizada con interpolacion parabolica del pico.
// - firstBeat: fase del primer golpe en segundos, en [0, periodo).
// - ambiguous: hay un pico fuerte a doble velocidad (subdivision marcada).
// No pliega a 90-180: el rango buscado es 50-220 y el DJ puede corregir.
export function analyzeBeatgrid(channelData, sampleRate) {
  const fail = { bpm: null, firstBeat: null, confidence: 0, ambiguous: false };
  if (!channelData || !sampleRate || channelData.length < sampleRate) return fail;
  const sr = sampleRate;
  // 1) Paso-bajo de un polo (~160 Hz) para centrar el analisis en el bombo.
  const alpha = 1 - Math.exp(-2 * Math.PI * 160 / sr);
  const hop = 128, frame = 512;
  const n = Math.floor((channelData.length - frame) / hop);
  if (n < 100) return fail;
  const env = new Float32Array(n);
  let lp = 0, prevRms = 0;
  const lpBuf = new Float32Array(frame);
  for (let i = 0; i < n; i++) {
    const off = i * hop;
    let s = 0;
    for (let j = 0; j < frame; j++) {
      lp += alpha * (channelData[off + j] - lp);
      lpBuf[j] = lp;
      s += lp * lp;
    }
    const rms = Math.sqrt(s / frame);
    env[i] = Math.max(0, rms - prevRms); // flujo (onsets)
    prevRms = rms;
  }
  // Quitar la media para que la autocorrelacion mida ritmo, no nivel.
  let mean = 0; for (const v of env) mean += v;
  mean /= n;
  for (let i = 0; i < n; i++) env[i] -= mean;
  const fps = sr / hop;
  const minLag = Math.max(2, Math.floor(fps * 60 / 220));
  const maxLag = Math.min(n - 2, Math.ceil(fps * 60 / 50));
  if (maxLag <= minLag) return fail;
  // 2) Autocorrelacion normalizada (insesgada) en el rango de lags.
  const corr = new Float32Array(maxLag + 2);
  let e0 = 0; for (const v of env) e0 += v * v;
  if (e0 <= 0) return fail;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let c = 0;
    for (let i = lag; i < n; i++) c += env[i] * env[i - lag];
    corr[lag] = c / (n - lag) / (e0 / n);
  }
  const corrAt = (lagF) => {
    const lo = Math.floor(lagF), hi = Math.min(corr.length - 1, lo + 1), f = lagF - lo;
    return corr[lo] * (1 - f) + corr[hi] * f;
  };
  let bestLag = minLag, best = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) if (corr[lag] > best) { best = corr[lag]; bestLag = lag; }
  // Correccion de octava (medida en demos y sinteticos): si el candidato a
  // doble velocidad puntua >= 0,85 del mejor, el periodo real es el corto.
  // El pico puede ser estrecho: se evaluan los lags vecinos al lag mitad.
  const globalLag = bestLag;
  let demotedSlowPeak = false;
  while (bestLag / 2 >= minLag) {
    const half = bestLag / 2;
    const cand = [Math.floor(half), Math.ceil(half)].filter(l => l >= minLag && l <= maxLag);
    if (!cand.length) break;
    const halfBest = cand.reduce((a, l) => (corr[l] > corr[a] ? l : a), cand[0]);
    if (corr[halfBest] < 0.85 * corr[bestLag]) break;
    if (corr[globalLag] > corr[halfBest]) demotedSlowPeak = true;
    bestLag = halfBest;
  }
  best = corr[bestLag];
  // 3) Interpolacion parabolica del pico (precision sub-frame).
  let shift = 0;
  const y0 = corr[bestLag - 1] ?? best, y1 = best, y2 = corr[bestLag + 1] ?? best;
  const den = y0 - 2 * y1 + y2;
  if (den !== 0) shift = Math.max(-1, Math.min(1, 0.5 * (y0 - y2) / den));
  let lagF = bestLag + shift;
  let bpm = 60 * fps / lagF;
  let confidence = Math.max(0, Math.min(1, y1));
  // 3b) Criterio musical de octava (Etapa 13): en musica de baile un
  // candidato <90 BPM cuyo doble cae en 90-180 y tiene soporte en la senal
  // (autocorrelacion a mitad de periodo >= 50% de la elegida) es casi
  // siempre el doble real con acento cada 2 golpes (medido: un sintetico a
  // 132 con acento alterno se leia 66,0). Un 66 uniforme no tiene ese
  // soporte a mitad de periodo y se queda en 66.
  let octaveSupport = null;
  const doubled = musicalOctave(bpm, lagF / 2 >= 1 ? corrAt(lagF / 2) / (y1 || 1) : 0);
  if (doubled !== bpm) {
    octaveSupport = corrAt(lagF / 2) / (y1 || 1);
    lagF /= 2; bpm = doubled;
    confidence = Math.max(0, Math.min(1, corrAt(lagF)));
  }
  // 4) Ambiguedad de octava: subdivision fuerte a doble velocidad.
  const halfScore = lagF / 2 >= 1 ? corrAt(lagF / 2) : 0;
  // Ambigua si hay subdivision fuerte a doble velocidad o si el pico a
  // mitad de velocidad era en realidad mas fuerte que el elegido.
  const ambiguous = octaveSupport !== null ? octaveSupport < 0.75 : (y1 > 0 && (halfScore >= 0.72 * y1 || demotedSlowPeak));
  // 5) Fase: plegar la envolvente sobre el periodo y buscar el maximo.
  let bestPhase = 0, bestScore = -Infinity;
  const phaseScores = new Float32Array(Math.ceil(lagF) + 1);
  for (let p = 0; p < phaseScores.length; p++) {
    let s = 0, count = 0;
    for (let t = p; t < n; t += lagF) {
      const i0 = Math.floor(t), f = t - i0;
      s += (env[i0] || 0) * (1 - f) + (env[i0 + 1] || 0) * f;
      count++;
    }
    phaseScores[p] = count ? s / count : 0;
    if (phaseScores[p] > bestScore) { bestScore = phaseScores[p]; bestPhase = p; }
  }
  let pShift = 0;
  const py0 = phaseScores[bestPhase - 1] ?? bestScore, py1 = bestScore, py2 = phaseScores[bestPhase + 1] ?? bestScore;
  const pDen = py0 - 2 * py1 + py2;
  if (pDen !== 0) pShift = Math.max(-1, Math.min(1, 0.5 * (py0 - py2) / pDen));
  let firstBeat = ((bestPhase + pShift) * hop) / sr;
  const period = 60 / bpm;
  firstBeat = ((firstBeat % period) + period) % period; // fase en [0, periodo)
  return { bpm, firstBeat, confidence, ambiguous };
}
// Criterio musical de octava: support = autocorrelacion a mitad de periodo
// dividida por la del periodo elegido. Solo dobla candidatos de baile.
export function musicalOctave(bpm, support) {
  // Umbral medido: 66 uniforme da support ~-0,01; 132 con acento alterno
  // fuerte da ~0,54; con acento medio ~0,78.
  if (!bpm || bpm >= 90) return bpm;
  const d = bpm * 2;
  return d >= 90 && d <= 180 && support >= 0.5 ? d : bpm;
}
export function beatPeriod(grid) { return grid?.bpm ? 60 / grid.bpm : null; }
export function quantizeToBeat(time, grid) {
  if (!grid?.bpm || grid.firstBeat == null) return time;
  const beat = 60 / grid.bpm;
  const k = Math.round((time - grid.firstBeat) / beat);
  return Math.max(0, grid.firstBeat + k * beat);
}
export function beatPhase01(time, grid) {
  if (!grid?.bpm || grid.firstBeat == null) return null;
  const beat = 60 / grid.bpm;
  const p = ((time - grid.firstBeat) / beat) % 1;
  return p < 0 ? p + 1 : p;
}
// Posicion cercana a `time` cuya fase sea phase01 (para SYNC de golpes).
export function alignToPhase(time, grid, phase01) {
  if (!grid?.bpm || grid.firstBeat == null || phase01 == null) return time;
  const beat = 60 / grid.bpm;
  const k = Math.round((time - grid.firstBeat) / beat - phase01);
  return Math.max(0, grid.firstBeat + (k + phase01) * beat);
}
// TAP tempo: BPM desde marcas en ms (mediana de intervalos).
export function tapTempo(tapsMs) {
  if (!Array.isArray(tapsMs) || tapsMs.length < 3) return null;
  const iv = [];
  for (let i = 1; i < tapsMs.length; i++) { const d = tapsMs[i] - tapsMs[i - 1]; if (d >= 200 && d <= 2000) iv.push(d); }
  if (iv.length < 2) return null;
  iv.sort((a, b) => a - b);
  const med = iv[Math.floor(iv.length / 2)];
  const bpm = 60000 / med;
  return bpm >= 40 && bpm <= 240 ? bpm : null;
}
// BPM efectivo: el nominal corregido por el tempo ya aplicado al deck.
export function effectiveBpm(nominal, tempoPct) {
  return nominal ? nominal * (1 + (tempoPct || 0) / 100) : null;
}
// Tempo (%) que necesita un deck para igualar el BPM EFECTIVO del otro.
// Idempotente: si ya coinciden, devuelve 0. La fase se alinea aparte con
// beatPhase01/alignToPhase, que trabajan en segundos de pista (no de reloj).
export function syncTempoPct(selfNominal, otherNominal, otherTempoPct, limit = 8) {
  if (!selfNominal || !otherNominal) return { ok: false, reason: 'sin-bpm', pct: null, effectiveOther: null };
  const eff = effectiveBpm(otherNominal, otherTempoPct);
  const pct = (eff / selfNominal - 1) * 100;
  if (Math.abs(pct) > limit) return { ok: false, reason: 'fuera-rango', pct, effectiveOther: eff };
  return { ok: true, reason: 'ok', pct, effectiveOther: eff };
}
// Tiempo de eco: sigue al BPM EFECTIVO del deck elegido (el que se oye),
// coherente con el SYNC. Sin BPM: null (eco sin sincronizar, no tocar nada).
export function ecoDelayFor(nominal, tempoPct, fraction) {
  const eff = effectiveBpm(nominal, tempoPct);
  const sec = beatDelayTime(eff, fraction);
  return sec === null ? null : { sec, effectiveBpm: eff };
}
// Tiempo de eco por fraccion de tiempo musical. Sin BPM: null (sin sincronizar).
export function beatDelayTime(bpm, fraction) {
  if (!bpm || !(fraction > 0)) return null;
  return (60 / bpm) * fraction;
}
