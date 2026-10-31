// Formato de lecturas de la consola (es): coma decimal, menos tipografico
// (U+2212) y espacio antes de la unidad. Logica pura, sin DOM.
// Ejemplos: -15.5 -> "−15,5" · TRIM (ganancia) 1.37 -> "+2,7 dB" ·
// FILTRO -25 -> "LP 50 %" · 0 -> "Neutro".
export function fmtEs(v, dec = 1) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const s = Math.abs(n).toFixed(dec).replace('.', ',');
  return (n < 0 ? '−' : '') + s;
}
export function fmtDb(v, dec = 1) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `${n > 0 ? '+' : ''}${fmtEs(n, dec)} dB`;
}
export function fmtTrimDb(g) {
  const n = Number(g);
  if (!Number.isFinite(n) || n <= 0) return '−∞ dB';
  return fmtDb(20 * Math.log10(n), 1);
}
export function fmtPct(v, dec = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `${n > 0 && dec > 0 ? '+' : ''}${fmtEs(n, dec)} %`;
}
export function fmtTempo(v) {
  const n = Number(v) || 0;
  return `${n >= 0 ? '+' : ''}${fmtEs(n, 1)} %`;
}
// Nombre legible de pista: sin extension ni guiones bajos, sin tocar
// el archivo. "Boiling_Energy_-_You_Are_Sick_Free_Download.mp3" ->
// "Boiling Energy – You Are Sick".
export function displayTrackName(name) {
  let s = String(name || '');
  s = s.replace(/\.(mp3|wav|ogg|m4a|flac|webm)$/i, '');
  s = s.replace(/_/g, ' ');
  s = s.replace(/\s+-\s+/g, ' – ');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/\s*[-–]?\s*Free Download.*$/i, '').trim();
  return s || String(name || '');
}
// Filtro bipolar: 0 (y la zona muerta del centro) = Neutro; negativo =
// pasa-bajos (LP), positivo = pasa-altos (HP), porcentaje de su recorrido.
export function fmtFilter(v, dead = 2) {
  const n = Number(v) || 0;
  if (Math.abs(n) <= dead) return 'Neutro';
  return n < 0 ? `LP ${Math.round(Math.abs(n) / 50 * 100)} %` : `HP ${Math.round(n / 50 * 100)} %`;
}
