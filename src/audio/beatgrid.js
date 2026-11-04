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
  // 3b) Criterio musical de octava (ampliado, Bloque 5): en musica de
  // baile un candidato <90 BPM cuyo doble cae en 90-180 y tiene soporte
  // en la senal es casi siempre el doble real con acento cada 2 golpes.
  // Medido: lento uniforme support ~-0,01; doble real con golpe debil
  // intermedio (0,12/0,16/0,20 de amplitud) support 0,23/0,30/0,38.
  // Por eso el umbral baja de 0,50 a 0,22 (ver musicalOctave).
  const s2 = lagF / 2 >= 1 ? corrAt(lagF / 2) / (y1 || 1) : 0;
  const s3 = lagF / 3 >= 1 ? corrAt(lagF / 3) / (y1 || 1) : 0;
  const sHalf = corrAt(lagF * 2) / (y1 || 1);
  const choice = musicalOctaveChoice(bpm, { s2, s3, sHalf });
  const octaveSupport = choice.factor !== 1 ? choice.support : (bpm < 90 ? Math.max(s2, s3) : null);
  const wasDoubled = choice.factor !== 1;
  if (wasDoubled) {
    lagF /= choice.factor; bpm = choice.bpm;
    confidence = Math.max(0, Math.min(1, corrAt(lagF)));
  }
  // 4) Ambiguedad de octava: subdivision fuerte a doble velocidad.
  const halfScore = lagF / 2 >= 1 ? corrAt(lagF / 2) : 0;
  // Ambigua si se eligio otra octava con soporte justito (<0,75), si no
  // se eligio pero hay soporte moderado de posible fraccion (>=0,15), si
  // hay subdivision fuerte o si el pico lento era mas fuerte que el elegido.
  const ambiguous = (octaveSupport !== null && (wasDoubled ? octaveSupport < 0.75 : octaveSupport >= 0.15))
    || (y1 > 0 && (halfScore >= 0.72 * y1 || demotedSlowPeak));
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
// Criterio musical de octava/fraccion (ampliado): el candidato puede
// ser 1/2 o 1/3 del real (53,3 = 106,6 o 159,9) o el doble por arriba.
// s2/s3 = autocorrelacion a lag/2 y lag/3 dividida por la del periodo
// elegido; sHalf = la de 2*lag. Se elige el factor con MEJOR evidencia
// (mayor soporte >= 0,22) cuyo resultado cae en el rango musical
// ~70-180 BPM. Medido: lento uniforme ~-0,01 en todo; 160 debil leido
// 53,3 da s3 0,24-0,40 y s2 ~-0,02; 107 debil leido 53,6 da s2 ~0,34.
export function musicalOctaveChoice(bpm, { s2 = 0, s3 = 0, sHalf = 0 } = {}) {
  const b = Number(bpm) || 0;
  if (!b) return { bpm: b, factor: 1, support: 0 };
  const inRange = v => v >= 70 && v <= 180;
  const opts = [];
  if (inRange(b * 2) && s2 >= 0.22) opts.push({ bpm: b * 2, factor: 2, support: s2 });
  if (inRange(b * 3) && s3 >= 0.22) opts.push({ bpm: b * 3, factor: 3, support: s3 });
  if (opts.length) { opts.sort((a, c) => c.support - a.support || a.factor - c.factor); return opts[0]; }
  if (b > 180 && inRange(b / 2) && sHalf >= 0.5) return { bpm: b / 2, factor: 0.5, support: sHalf };
  return { bpm: b, factor: 1, support: 0 };
}
export function musicalOctave(bpm, support) {
  return musicalOctaveChoice(bpm, { s2: support }).bpm;
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
