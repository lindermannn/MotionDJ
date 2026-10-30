import { crossfaderGains } from '../gestures/logic.js';
// Motor Web Audio: 2 canales -> trim -> EQ3 -> filtro -> fader -> crossfader
// -> master -> analyser -> destino. Efectos: delay y reverb (convolver generado).
export class Channel {
  constructor(ctx, masterIn) {
    this.ctx = ctx;
    this.source = null; this.buffer = null; this.playing = false;
    this.startedAt = 0; this.offset = 0; this.cue = 0; this.rate = 1;
    // Rampa de playbackRate (setTargetAtTime, tau=0,03): position() integra
    // la rampa en vez de suponer el rate nuevo instantaneo.
    this.RATE_TAU = 0.03;
    this._rFrom = 1; this._rTo = 1;
    this.trim = ctx.createGain(); this.low = ctx.createBiquadFilter();
    this.mid = ctx.createBiquadFilter(); this.high = ctx.createBiquadFilter();
    this.filter = ctx.createBiquadFilter(); this.fader = ctx.createGain();
    this.xGain = ctx.createGain(); this.analyser = ctx.createAnalyser();
    this.delaySend = ctx.createGain(); this.verbSend = ctx.createGain();
    this.low.type = 'lowshelf'; this.low.frequency.value = 200;
    this.mid.type = 'peaking'; this.mid.frequency.value = 1000; this.mid.Q.value = 0.8;
    this.high.type = 'highshelf'; this.high.frequency.value = 4000;
    this.filter.type = 'lowpass'; this.filter.frequency.value = 18000;
    this.analyser.fftSize = 256;
    // cadena
    this.trim.connect(this.low); this.low.connect(this.mid); this.mid.connect(this.high);
    this.high.connect(this.filter); this.filter.connect(this.fader);
    this.fader.connect(this.xGain); this.xGain.connect(this.analyser); this.analyser.connect(masterIn);
    this.fader.connect(this.delaySend); this.fader.connect(this.verbSend);
    this.delaySend.gain.value = 0; this.verbSend.gain.value = 0;
  }
  load(buffer) { this.stop(); this.buffer = buffer; this.offset = 0; this.cue = 0; this.loopRange = null; }
  setLoop(start, end) {
    if (!(end > start)) return;
    this.loopRange = { start, end };
    if (this.source) { this.source.loop = true; this.source.loopStart = start; this.source.loopEnd = end; }
  }
  clearLoop() { this.loopRange = null; if (this.source) this.source.loop = false; }
  _makeSource() {
    const s = this.ctx.createBufferSource(); s.buffer = this.buffer;
    s.playbackRate.value = this.rate; s.connect(this.trim);
    if (this.loopRange) { s.loop = true; s.loopStart = this.loopRange.start; s.loopEnd = this.loopRange.end; }
    return s;
  }
  play() {
    if (!this.buffer || this.playing) return;
    this.source = this._makeSource();
    this.source.onended = () => { if (this.source && !this._looping) { this.playing = false; this.offset = 0; this.onEnded?.(); } };
    this.source.start(0, this.offset % this.buffer.duration);
    this.startedAt = this.ctx.currentTime; this.playing = true;
    this._rFrom = this._rTo = this.rate; // la fuente nueva nace al rate destino, sin rampa
  }
  // Valor real de playbackRate en el instante t, siguiendo la rampa exponencial.
  rateAt(t) {
    const e = t - this.startedAt;
    if (!(e > 0)) return this._rFrom;
    return this._rTo + (this._rFrom - this._rTo) * Math.exp(-e / this.RATE_TAU);
  }
  pause() {
    if (!this.playing) return;
    this.offset = this.position(); this._stopSource(); this.playing = false;
  }
  stop() { this._stopSource(); this.playing = false; this.offset = 0; }
  _stopSource() { if (this.source) { try { this.source.onended = null; this.source.stop(); } catch {} this.source = null; } }
  seek(t) { const was = this.playing; this._stopSource(); this.playing = false; this.offset = Math.max(0, Math.min(t, this.buffer ? this.buffer.duration : 0)); if (was) this.play(); }
  position() {
    if (!this.buffer) return 0;
    if (!this.playing) return this.offset;
    // Integral analitica de la rampa: rTo*e + (rFrom-rTo)*tau*(1-exp(-e/tau))
    const e = this.ctx.currentTime - this.startedAt;
    const raw = this.offset + this._rTo * e + (this._rFrom - this._rTo) * this.RATE_TAU * (1 - Math.exp(-e / this.RATE_TAU));
    if (this.loopRange && raw >= this.loopRange.start) {
      const len = this.loopRange.end - this.loopRange.start;
      if (len > 0) return this.loopRange.start + ((raw - this.loopRange.start) % len);
    }
    return raw % this.buffer.duration;
  }
  setRate(r) {
    // Rebasar posicion y rate real (a mitad de rampa si la hubiera) y
    // arrancar la rampa nueva desde ahi: position() no salta ni deriva.
    const now = this.ctx.currentTime;
    if (this.playing) {
      this.offset = this.position();
      this._rFrom = this.rateAt(now);
      this.startedAt = now;
    } else this._rFrom = r;
    this._rTo = r;
    this.rate = r;
    if (this.source) this.source.playbackRate.setTargetAtTime(r, now, this.RATE_TAU);
  }
  level() { const d = new Uint8Array(this.analyser.frequencyBinCount); this.analyser.getByteTimeDomainData(d); let p = 0; for (const v of d) p = Math.max(p, Math.abs(v - 128) / 128); return p; }
}
// Ajustes del limitador de salida (techo ~-3 dB, ratio alto, ataque rapido).
export const LIMITER_SETTINGS = { threshold: -3, knee: 0, ratio: 20, attack: 0.001, release: 0.25 };
// Curva de techo suave: lineal hasta 0,6 y asintota en 0,708 (-3 dB).
// El limitador hace el trabajo grueso; esta curva garantiza el techo
// tambien en los transitorios que el ataque del compresor deja pasar.
export function makeCeilingCurve(n = 1024) {
  const curve = new Float32Array(n), a = 0.6, c = 0.708;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1, ax = Math.abs(x);
    const y = ax <= a ? x : Math.sign(x) * (a + (c - a) * (1 - Math.exp(-(ax - a) / (c - a))));
    curve[i] = y;
  }
  return curve;
}
// Indicador de saturacion con memoria: encendido mientras haya picos o
// hasta que pase el tiempo de hold desde el ultimo. Logica pura, testeable.
export function clipState(prevUntil, level, now, { threshold = 0.9, holdMs = 500 } = {}) {
  const until = level >= threshold ? now + holdMs : prevUntil;
  return { on: now < until, until };
}
export class AudioEngine {
  constructor() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain(); this.master.gain.value = 0.85;
    this.comp = this.ctx.createDynamicsCompressor();
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = LIMITER_SETTINGS.threshold;
    this.limiter.knee.value = LIMITER_SETTINGS.knee;
    this.limiter.ratio.value = LIMITER_SETTINGS.ratio;
    this.limiter.attack.value = LIMITER_SETTINGS.attack;
    this.limiter.release.value = LIMITER_SETTINGS.release;
    this.ceiling = this.ctx.createWaveShaper(); this.ceiling.curve = makeCeilingCurve(); this.ceiling.oversample = '2x';
    this.masterAnalyser = this.ctx.createAnalyser(); this.masterAnalyser.fftSize = 2048; // ventana larga para picos
    this.master.connect(this.comp); this.comp.connect(this.limiter); this.limiter.connect(this.ceiling); this.ceiling.connect(this.masterAnalyser); this.masterAnalyser.connect(this.ctx.destination);
    this.recordDest = this.ctx.createMediaStreamDestination(); this.masterAnalyser.connect(this.recordDest);
    this.decks = [new Channel(this.ctx, this.master), new Channel(this.ctx, this.master)];
    // FX compartidos
    this.delay = this.ctx.createDelay(1); this.delay.delayTime.value = 0.28;
    this.delayFb = this.ctx.createGain(); this.delayFb.gain.value = 0.32;
    this.delayHp = this.ctx.createBiquadFilter(); this.delayHp.type = 'highpass'; this.delayHp.frequency.value = 180; // graves fuera del retorno
    this.delayOut = this.ctx.createGain();
    this.delay.connect(this.delayHp); this.delayHp.connect(this.delayFb); this.delayFb.connect(this.delay);
    this.delayHp.connect(this.delayOut); this.delayOut.connect(this.master);
    this.verb = this.ctx.createConvolver(); this.verb.buffer = this._impulse(1.6, 2.2);
    this.verbOut = this.ctx.createGain(); this.verb.connect(this.verbOut); this.verbOut.connect(this.master);
    for (const d of this.decks) { d.delaySend.connect(this.delay); d.verbSend.connect(this.verb); }
    this.cross = 0; this.applyCrossfader();
  }
  _impulse(dur, decay) {
    const rate = this.ctx.sampleRate, len = rate * dur, buf = this.ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay); }
    return buf;
  }
  async decode(file) { const ab = await file.arrayBuffer(); return this.ctx.decodeAudioData(ab); }
  applyCrossfader() { const { a, b } = crossfaderGains(this.cross); const t = this.ctx.currentTime; this.decks[0].xGain.gain.setTargetAtTime(a, t, 0.02); this.decks[1].xGain.gain.setTargetAtTime(b, t, 0.02); }
  setCross(v) { this.cross = v; this.applyCrossfader(); }
  // Tiempo de eco en segundos; la realimentacion nunca pasa de 0,5.
  setDelayTime(sec) {
    if (!(sec > 0)) return;
    const t = this.ctx.currentTime;
    this.delay.delayTime.setTargetAtTime(Math.min(1, sec), t, 0.03);
    if (this.delayFb.gain.value > 0.5) this.delayFb.gain.setTargetAtTime(0.5, t, 0.03);
  }
  masterLevel() { const d = new Uint8Array(this.masterAnalyser.frequencyBinCount); this.masterAnalyser.getByteTimeDomainData(d); let p = 0; for (const v of d) p = Math.max(p, Math.abs(v - 128) / 128); return p; }
  // Sampler sintetizado: sonidos cortos reales sin archivos externos
  playSample(i) {
    const t = this.ctx.currentTime, o = this.ctx.createOscillator(), g = this.ctx.createGain();
    const freqs = [180, 120, 800, 1200, 300, 500, 90, 2000], types = ['sine', 'sine', 'square', 'sawtooth', 'triangle', 'square', 'sine', 'sawtooth'];
    o.type = types[i % 8]; o.frequency.setValueAtTime(freqs[i % 8], t);
    if (i % 2) o.frequency.exponentialRampToValueAtTime(40, t + 0.18);
    g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + 0.26);
  }
}
