import { crossfaderGains } from '../gestures/logic.js';
// Motor Web Audio: 2 canales -> trim -> EQ3 -> filtro -> fader -> crossfader
// -> master -> analyser -> destino. Efectos: delay y reverb (convolver generado).
class Channel {
  constructor(ctx, masterIn) {
    this.ctx = ctx;
    this.source = null; this.buffer = null; this.playing = false;
    this.startedAt = 0; this.offset = 0; this.cue = 0; this.rate = 1;
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
  load(buffer) { this.stop(); this.buffer = buffer; this.offset = 0; this.cue = 0; }
  _makeSource() {
    const s = this.ctx.createBufferSource(); s.buffer = this.buffer;
    s.playbackRate.value = this.rate; s.connect(this.trim); return s;
  }
  play() {
    if (!this.buffer || this.playing) return;
    this.source = this._makeSource();
    this.source.onended = () => { if (this.source && !this._looping) { this.playing = false; this.offset = 0; this.onEnded?.(); } };
    this.source.start(0, this.offset % this.buffer.duration);
    this.startedAt = this.ctx.currentTime; this.playing = true;
  }
  pause() {
    if (!this.playing) return;
    this.offset = this.position(); this._stopSource(); this.playing = false;
  }
  stop() { this._stopSource(); this.playing = false; this.offset = 0; }
  _stopSource() { if (this.source) { try { this.source.onended = null; this.source.stop(); } catch {} this.source = null; } }
  seek(t) { const was = this.playing; this._stopSource(); this.playing = false; this.offset = Math.max(0, Math.min(t, this.buffer ? this.buffer.duration : 0)); if (was) this.play(); }
  position() { if (!this.buffer) return 0; if (!this.playing) return this.offset; return (this.offset + (this.ctx.currentTime - this.startedAt) * this.rate) % this.buffer.duration; }
  setRate(r) { this.rate = r; if (this.source) this.source.playbackRate.setTargetAtTime(r, this.ctx.currentTime, 0.03); }
  level() { const d = new Uint8Array(this.analyser.frequencyBinCount); this.analyser.getByteTimeDomainData(d); let p = 0; for (const v of d) p = Math.max(p, Math.abs(v - 128) / 128); return p; }
}
export class AudioEngine {
  constructor() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain(); this.master.gain.value = 0.85;
    this.comp = this.ctx.createDynamicsCompressor();
    this.masterAnalyser = this.ctx.createAnalyser(); this.masterAnalyser.fftSize = 256;
    this.master.connect(this.comp); this.comp.connect(this.masterAnalyser); this.masterAnalyser.connect(this.ctx.destination);
    this.recordDest = this.ctx.createMediaStreamDestination(); this.masterAnalyser.connect(this.recordDest);
    this.decks = [new Channel(this.ctx, this.master), new Channel(this.ctx, this.master)];
    // FX compartidos
    this.delay = this.ctx.createDelay(1); this.delay.delayTime.value = 0.28;
    this.delayFb = this.ctx.createGain(); this.delayFb.gain.value = 0.32;
    this.delayOut = this.ctx.createGain(); this.delay.connect(this.delayFb); this.delayFb.connect(this.delay);
    this.delay.connect(this.delayOut); this.delayOut.connect(this.master);
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
