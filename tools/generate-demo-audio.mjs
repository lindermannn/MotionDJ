// Genera 2 pistas demo WAV originales (sintetizadas, CC0 del proyecto).
import { writeFileSync } from 'node:fs';
function wav(bpm, base, file) {
  const sr = 44100, dur = 16, n = sr * dur, data = new Float32Array(n);
  const beat = 60 / bpm;
  for (let i = 0; i < n; i++) {
    const t = i / sr, bt = t % beat, bar = Math.floor(t / (beat * 4)) % 4;
    let s = 0;
    if (bt < 0.12) s += Math.sin(2 * Math.PI * (60 - bt * 200) * bt) * Math.exp(-bt * 30) * 0.9; // kick
    if ((t + beat / 2) % beat < 0.05) s += (Math.random() * 2 - 1) * 0.12; // hat
    const notes = [1, 1, 1.5, 2], f = base * notes[bar];
    s += Math.sin(2 * Math.PI * f * t) * 0.16 + Math.sin(2 * Math.PI * f * 2 * t) * 0.06; // bajo/melodia
    if (bt > beat * 0.75) s += Math.sin(2 * Math.PI * f * 3 * t) * 0.08;
    data[i] = Math.max(-0.95, Math.min(0.95, s));
  }
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) { const v = Math.round(data[i] * 32767); buf.writeInt16LE(v, 44 + i * 4); buf.writeInt16LE(v, 46 + i * 4); }
  writeFileSync(file, buf); console.log(file, bpm, 'BPM', buf.length, 'bytes');
}
import { fileURLToPath } from 'node:url';
wav(122, 110, fileURLToPath(new URL('../public/audio/demo-a.wav', import.meta.url)));
wav(124, 130.81, fileURLToPath(new URL('../public/audio/demo-b.wav', import.meta.url)));
