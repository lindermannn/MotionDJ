import { crossfaderGains } from '../gestures/logic.js';
import { scrubPosition } from './scrub.js';
// Orden de los stems de Meta Demucs en el buffer de 8 canales (pares L/R).
export const STEM_NAMES = ['vocals', 'drums', 'bass', 'other'];
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
    this.scrubNode = null; this.scrubbing = false; this.scrubPos = 0; this.scrubSpeed = 0; this._scrubAt = 0; this._scrubWasPlaying = false;
    this.cueSend = ctx.createGain(); this.cueSend.gain.value = 0; // preescucha (P3.c)
    this.trim = ctx.createGain();
    this.srcGain = ctx.createGain(); this.srcGain.connect(this.trim); // mudo del slip (ROLL)
    this.rollGain = ctx.createGain(); this.rollGain.connect(this.trim); this.roll = null; this._rollTimer = null;
    this.low = ctx.createBiquadFilter();
    this.mid = ctx.createBiquadFilter(); this.high = ctx.createBiquadFilter();
    this.filter = ctx.createBiquadFilter(); this.fader = ctx.createGain();
    this.xGain = ctx.createGain(); this.analyser = ctx.createAnalyser();
    this.delaySend = ctx.createGain(); this.verbSend = ctx.createGain();
    this.low.type = 'lowshelf'; this.low.frequency.value = 200;
    this.mid.type = 'peaking'; this.mid.frequency.value = 1000; this.mid.Q.value = 0.8;
    this.high.type = 'highshelf'; this.high.frequency.value = 4000;
    this.filter.type = 'lowpass'; this.filter.frequency.value = 18000;
    this.filterHp = ctx.createBiquadFilter(); this.filterHp.type = 'highpass'; this.filterHp.frequency.value = 10;
    this.analyser.fftSize = 256;
    // cadena
    this.trim.connect(this.low); this.low.connect(this.mid); this.mid.connect(this.high);
    this.high.connect(this.filter); this.filter.connect(this.filterHp); this.filterHp.connect(this.fader);
    this.fader.connect(this.xGain); this.xGain.connect(this.analyser); this.analyser.connect(masterIn);
    // Envios post-crossfader: un deck cerrado en el crossfader no se cuela por el eco.
    this.xGain.connect(this.delaySend); this.xGain.connect(this.verbSend);
    this.filter.connect(this.cueSend); // pre-fader: se oye aunque el canal este cerrado
    this.delaySend.gain.value = 0; this.verbSend.gain.value = 0;
    // --- STEMS (Meta Demucs): un buffer de 8 canales = VOZ, BATERIA, BAJO y
    // RESTO en estereo. Sigue habiendo UNA fuente (rate, seek, LOOP, FRENO y
    // ROLL no cambian); los stems se separan a la salida. Sin stems, srcGain
    // y rollGain van directos a trim como siempre.
    this.stemBuffer = null; this.stemsOn = false; this.rollTargets = null;
    this.stemLevel = STEM_NAMES.map(() => { const g = ctx.createGain(); g.connect(this.trim); return g; });
    this.stemAnalyser = this.stemLevel.map(lv => { const a = ctx.createAnalyser(); a.fftSize = 256; lv.connect(a); return a; }); // energia por stem (visual)
    // Envio de eco por stem (lo conecta el motor al delay). Sale antes del
    // fader, asi que lleva su propio fader y crossfader espejo (ecoFader, ecoX).
    this.stemEcoMix = ctx.createGain(); this.ecoFader = ctx.createGain(); this.stemEcoOut = ctx.createGain();
    this.stemEcoMix.connect(this.ecoFader); this.ecoFader.connect(this.stemEcoOut);
    this.stemEco = this.stemLevel.map(lv => { const g = ctx.createGain(); g.gain.value = 0; lv.connect(g); g.connect(this.stemEcoMix); return g; });
    const bus = () => {
      const sp = ctx.createChannelSplitter(8);
      return { sp, gates: STEM_NAMES.map((_, k) => { const m = ctx.createChannelMerger(2); sp.connect(m, 2 * k, 0); sp.connect(m, 2 * k + 1, 1); const g = ctx.createGain(); m.connect(g); g.connect(this.stemLevel[k]); return g; }) };
    };
    this.stemMain = bus(); this.stemRoll = bus(); // puertas por stem de la fuente principal y del ROLL
  }
  load(buffer) { this.stop(); this.clearStems(); this.buffer = buffer; this.offset = 0; this.cue = 0; this.loopRange = null; if (this.scrubNode && buffer) this._sendBuffer(); }
  // Buffer que suenan las fuentes: el de stems si estan activos.
  _buf() { return this.stemsOn && this.stemBuffer ? this.stemBuffer : this.buffer; }
  _route(on) {
    for (const [src, b] of [[this.srcGain, this.stemMain], [this.rollGain, this.stemRoll]]) { try { src.disconnect(); } catch {} src.connect(on ? b.sp : this.trim); }
  }
  // Activa los stems (buffer de 8 canales con la misma duracion). Si el deck
  // suena, cambia de fuente en el mismo punto con un ataque corto.
  setStems(buf8) {
    if (!this.buffer || !buf8 || buf8.numberOfChannels !== 8 || Math.abs(buf8.duration - this.buffer.duration) > 0.25) return false;
    const was = this.playing, pos = this.position();
    if (was) { this.cancelRoll(); this._stopSource(); this.playing = false; }
    this.stemBuffer = buf8; this.stemsOn = true; this._route(true);
    if (was) this.playAt(pos, this.ctx.currentTime + 0.02); else this.offset = pos;
    return true;
  }
  clearStems() {
    if (!this.stemsOn && !this.stemBuffer) return;
    const was = this.playing, pos = this.position();
    if (was) { this.cancelRoll(); this._stopSource(); this.playing = false; }
    this.stemBuffer = null; this.stemsOn = false; this.rollTargets = null; this._route(false);
    const t = this.ctx.currentTime;
    this.stemLevel.forEach(g => g.gain.setTargetAtTime(1, t, 0.01)); this.stemEco.forEach(g => g.gain.setTargetAtTime(0, t, 0.01));
    if (was && this.buffer) this.playAt(pos, t + 0.02);
  }
  // Volumen de un stem (0..1) desde un instante (cambios en el golpe), con
  // fundido corto para que no haga clic.
  setStemLevel(k, v, atCtx = null) {
    const g = this.stemLevel[k]; if (!g) return;
    const t = Math.max(this.ctx.currentTime, atCtx ?? this.ctx.currentTime);
    g.gain.cancelScheduledValues(t); g.gain.setTargetAtTime(Math.max(0, Math.min(1.5, v)), t, 0.008);
  }
  stemLevelNow(k) { return this.stemLevel[k]?.gain.value ?? 1; }
  // Pico 0..1 de un stem tras su volumen (para luces y pulso del bombo).
  stemEnergy(k) {
    const a = this.stemAnalyser[k]; if (!a?.getByteTimeDomainData || !this.stemsOn) return 0;
    const d = this._stemBuf || (this._stemBuf = new Uint8Array(a.frequencyBinCount)); a.getByteTimeDomainData(d);
    let p = 0; for (const v of d) p = Math.max(p, Math.abs(v - 128) / 128); return p;
  }
  setStemEco(k, v) { const g = this.stemEco[k]; if (g) g.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), this.ctx.currentTime, 0.05); }
  // Puerta de la fuente principal durante el ROLL: entera (srcGain) o solo
  // los stems elegidos (el resto sigue sonando normal).
  _mainGate(value, atCtx, rampTo = null, rampEnd = null) {
    const targeted = this.stemsOn && this.rollTargets?.length;
    const params = targeted ? this.rollTargets.map(k => this.stemMain.gates[k].gain) : [this.srcGain.gain];
    for (const p of params) {
      p.cancelScheduledValues(this.ctx.currentTime);
      p.setValueAtTime(value, atCtx);
      if (rampTo !== null) p.linearRampToValueAtTime(rampTo, rampEnd);
    }
  }
  // --- LOOP ROLL slip (4C): la fuente principal sigue sonando en silencio
  // (esa es la posicion slip); unas voces repiten el trozo con fundidos de
  // 4 ms en cada junta. Al salir se desmudece la principal en el golpe.
  cancelRoll() {
    if (this.stemBrake) this.endStemBrake();
    if (this._rollTimer) { clearInterval(this._rollTimer); this._rollTimer = null; }
    if (this.roll) for (const v of this.roll.voices) { try { v.src.stop(); } catch {} try { v.gain.disconnect(); } catch {} }
    this.roll = null;
    const t = this.ctx.currentTime;
    for (const p of [this.srcGain.gain, ...this.stemMain.gates.map(g => g.gain)]) { p.cancelScheduledValues(t); p.setTargetAtTime(1, t, 0.005); }
  }
  _rollSchedule() {
    const R = this.roll; if (!R) return;
    const horizon = this.ctx.currentTime + 0.14, fade = 0.004;
    while (R.nextTime < horizon && (!R.exitAt || R.nextTime < R.exitAt - 0.001)) {
      const start = R.nextTime, durPos = R.sizeSec, durReal = durPos / Math.max(0.05, this.rate);
      const src = this.ctx.createBufferSource(); src.buffer = this._buf(); src.playbackRate.value = this.rate;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, start); g.gain.linearRampToValueAtTime(1, start + fade);
      g.gain.setValueAtTime(1, start + Math.max(fade, durReal)); g.gain.linearRampToValueAtTime(0, start + durReal + fade);
      src.connect(g); g.connect(this.rollGain);
      const v = { src, gain: g, start, end: start + durReal };
      R.voices.add(v);
      src.onended = () => { R.voices.delete(v); try { g.disconnect(); } catch {} };
      try { src.start(start, R.segmentStart % this.buffer.duration, durPos + fade * this.rate + 0.03); } catch { R.voices.delete(v); break; }
      R.nextTime = start + durReal; R.repetitions++;
    }
  }
  _rollTruncate(atCtx) {
    const R = this.roll; if (!R) return;
    const fade = 0.004;
    for (const v of [...R.voices]) {
      if (v.start >= atCtx - 0.001) { try { v.src.stop(); } catch {} R.voices.delete(v); }
      else if (v.end > atCtx) {
        v.gain.gain.cancelScheduledValues(atCtx); v.gain.gain.setValueAtTime(1, atCtx); v.gain.gain.linearRampToValueAtTime(0, atCtx + fade);
        try { v.src.stop(atCtx + fade + 0.03); } catch {}
        v.end = atCtx;
      }
    }
    R.nextTime = atCtx;
  }
  startSlipRoll({ segmentStart = 0, sizeSec = 0.375, whenCtx = null } = {}) {
    if (!this.buffer || !this.playing || this.scrubbing || !(sizeSec > 0.02)) return false;
    this.cancelRoll();
    const when = Math.max(this.ctx.currentTime + 0.005, whenCtx ?? this.ctx.currentTime + 0.01);
    const fade = 0.004, t = this.ctx.currentTime;
    // Con stems y objetivo (p. ej. solo BATERIA), el roll solo suena en esos
    // stems y los demas siguen con la pista normal.
    const targets = this.stemsOn && this.rollTargets?.length ? this.rollTargets : null;
    this.stemRoll.gates.forEach((g, k) => g.gain.setValueAtTime(!targets || targets.includes(k) ? 1 : 0, t));
    this._mainGate(1, Math.max(t, when - fade), 0, when);
    this.roll = { segmentStart: Math.max(0, segmentStart), sizeSec, nextTime: when, voices: new Set(), exitAt: null, repetitions: 0, startedCtx: when };
    this._rollSchedule();
    this._rollTimer = setInterval(() => this._rollSchedule(), 25);
    return true;
  }
  changeRollSize(sizeSec, atCtx) {
    if (!this.roll || !(sizeSec > 0.02)) return false;
    const at = Math.max(this.ctx.currentTime + 0.005, atCtx);
    this._rollTruncate(at); this.roll.sizeSec = sizeSec; this.roll.exitAt = null; this._rollSchedule();
    return true;
  }
  exitSlipRollAt(atCtx) {
    if (!this.roll) return false;
    const at = Math.max(this.ctx.currentTime + 0.005, atCtx), fade = 0.004;
    this.roll.exitAt = at; this._rollTruncate(at);
    this._mainGate(0, Math.max(this.ctx.currentTime, at - fade), 1, at + fade);
    const ms = Math.max(30, (at - this.ctx.currentTime) * 1000 + 80);
    setTimeout(() => { if (this.roll && this.roll.exitAt === at) this.cancelRoll(); }, ms);
    return true;
  }
  // --- FRENO por stems: una voz aparte frena solo esos stems (p. ej. la
  // MUSICA mientras la VOZ sigue). La fuente principal no cambia de
  // velocidad y sigue sonando en silencio en esos stems: es la posicion slip.
  startStemBrake({ targets = [], durationSec = 1, curve = null } = {}) {
    if (!this.buffer || !this.playing || !this.stemsOn || !targets.length) return false;
    this.cancelRoll(); this.endStemBrake();
    const t = this.ctx.currentTime + 0.01, fade = 0.004, pos = this.position();
    const src = this.ctx.createBufferSource(); src.buffer = this._buf(); src.playbackRate.value = this.rate;
    const g = this.ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + fade);
    src.connect(g); g.connect(this.rollGain);
    this.stemRoll.gates.forEach((sg, k) => sg.gain.setValueAtTime(targets.includes(k) ? 1 : 0, t));
    for (const k of targets) { const p = this.stemMain.gates[k].gain; p.cancelScheduledValues(t); p.setValueAtTime(1, t - fade); p.linearRampToValueAtTime(0, t); }
    if (curve?.length > 1) src.playbackRate.setValueCurveAtTime(Float32Array.from(curve, v => Math.max(0.001, v * this.rate)), t, Math.max(0.05, durationSec));
    src.start(t, pos % this.buffer.duration);
    this.stemBrake = { src, gain: g, targets, endsAt: t + durationSec };
    return true;
  }
  // Vuelta en un instante del reloj (el golpe): fuera la voz frenada y los
  // stems vuelven desde la fuente principal, que nunca se paro.
  endStemBrake(atCtx = null) {
    const B = this.stemBrake; if (!B) return false;
    const at = Math.max(this.ctx.currentTime + 0.005, atCtx ?? this.ctx.currentTime), fade = 0.006;
    B.gain.gain.cancelScheduledValues(at); B.gain.gain.setValueAtTime(B.gain.gain.value, at); B.gain.gain.linearRampToValueAtTime(0, at + fade);
    try { B.src.stop(at + fade + 0.02); } catch {}
    for (const k of B.targets) { const p = this.stemMain.gates[k].gain; p.cancelScheduledValues(at); p.setValueAtTime(0, at); p.linearRampToValueAtTime(1, at + fade); }
    B.src.onended = () => { try { B.gain.disconnect(); } catch {} };
    this.stemBrake = null;
    return true;
  }
  // Arranque en un instante del reloj de audio (vuelta del FRENO en el golpe).
  playAt(pos, whenCtx) {
    if (!this.buffer) return false;
    this._stopSource();
    const when = Math.max(this.ctx.currentTime + 0.005, whenCtx);
    this.offset = Math.max(0, Math.min(pos, this.buffer.duration));
    this.source = this._makeSource();
    this.source.onended = () => { if (this.source && !this._looping) { this.playing = false; this.offset = 0; this.onEnded?.(); } };
    this.srcGain.gain.cancelScheduledValues(this.ctx.currentTime);
    this.srcGain.gain.setValueAtTime(0, when); this.srcGain.gain.linearRampToValueAtTime(1, when + 0.006); // ataque corto sin clic
    this.source.start(when, this.offset % this.buffer.duration);
    this.startedAt = when; this.playing = true; this._rFrom = this._rTo = this.rate;
    return true;
  }
  // --- Scrub con worklet (P3.a): posicion/velocidad con signo ---
  attachScrub(node) {
    this.scrubNode = node;
    node.connect(this.trim);
    node.port.onmessage = e => { if (e.data?.type === 'pos') { this.scrubPos = e.data.pos; this._scrubAt = this.ctx.currentTime; } };
    if (this.buffer) this._sendBuffer();
  }
  _sendBuffer() {
    const l = this.buffer.getChannelData(0), r = this.buffer.numberOfChannels > 1 ? this.buffer.getChannelData(1) : l;
    this.scrubNode.port.postMessage({ type: 'load', left: l.slice(0), right: r.slice(0) });
  }
  startScrub() {
    if (!this.scrubNode || !this.buffer || this.scrubbing) return false;
    this._scrubWasPlaying = this.playing;
    this.scrubPos = this.position();
    this._scrubAt = this.ctx.currentTime;
    if (this.playing) this.pause();
    this.scrubbing = true; this.scrubSpeed = 0;
    this.scrubNode.port.postMessage({ type: 'set', pos: this.scrubPos * this.ctx.sampleRate, speed: 0, playing: true });
    return true;
  }
  setScrubSpeed(ratio) {
    if (!this.scrubbing) return;
    this.scrubSpeed = Math.max(-3, Math.min(3, ratio || 0));
    this.scrubNode.port.postMessage({ type: 'set', speed: this.scrubSpeed, playing: true });
  }
  scrubNow() {
    if (!this.scrubbing || !this.buffer) return this.scrubPos;
    const dt = Math.max(0, this.ctx.currentTime - this._scrubAt);
    return scrubPosition(this.scrubPos, this.scrubSpeed, dt, this.buffer.duration);
  }
  endScrub() {
    if (!this.scrubbing) return;
    const pos = this.scrubNow();
    this.scrubbing = false; this.scrubSpeed = 0;
    this.scrubNode.port.postMessage({ type: 'set', speed: 0, playing: false });
    this.offset = pos;
    if (this._scrubWasPlaying) this.play(); // reanuda en el punto, rate normal con su rampa
  }
  setLoop(start, end) {
    if (!(end > start)) return;
    this.loopRange = { start, end };
    if (this.source) { this.source.loop = true; this.source.loopStart = start; this.source.loopEnd = end; }
  }
  clearLoop() { this.loopRange = null; if (this.source) this.source.loop = false; }
  _makeSource() {
    const s = this.ctx.createBufferSource(); s.buffer = this._buf();
    s.playbackRate.value = this.rate; s.connect(this.srcGain);
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
    this.offset = this.position(); this.cancelRoll(); this._stopSource(); this.playing = false;
  }
  stop() { this.cancelRoll(); this._stopSource(); this.playing = false; this.offset = 0; }
  _stopSource() { if (this.source) { try { this.source.onended = null; this.source.stop(); } catch {} this.source = null; } }
  seek(t) { const was = this.playing; this.cancelRoll(); this._stopSource(); this.playing = false; this.offset = Math.max(0, Math.min(t, this.buffer ? this.buffer.duration : 0)); if (was) this.play(); }
  position() {
    if (!this.buffer) return 0;
    if (this.scrubbing) return this.scrubNow();
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
// Filtro bipolar de un mando (Etapa 15): -50..+50, centro = reposo.
// Negativo: pasa-bajos 18 kHz -> 400 Hz. Positivo: pasa-altos 10 Hz -> 4 kHz.
export function filterFreqs(v) {
  const x = Math.max(-50, Math.min(50, Number(v) || 0));
  return {
    lp: x < 0 ? 18000 * Math.pow(400 / 18000, -x / 50) : 18000,
    hp: x > 0 ? 10 * Math.pow(4000 / 10, x / 50) : 10
  };
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
    this.masterAnalyser.minDecibels = -85; this.masterAnalyser.maxDecibels = -25; this.masterAnalyser.smoothingTimeConstant = 0.82; // rango dinamico legible (Etapa 9)
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
    for (const d of this.decks) { d.delaySend.connect(this.delay); d.verbSend.connect(this.verb); d.stemEcoOut.connect(this.delay); }
    this.cross = 0; this.applyCrossfader();
    // Bus de preescucha (P3.c): destino de stream independiente del master.
    // Un <audio> con setSinkId lo manda a los auriculares; la grabacion
    // (recordDest) cuelga del master y nunca incluye la preescucha.
    this.cueDest = this.ctx.createMediaStreamDestination();
    for (const d of this.decks) d.cueSend.connect(this.cueDest);
    this._scrubReady = null;
  }
  // Carga el worklet de scrub una vez y lo adjunta a ambos canales.
  ensureScrub(workletUrl) {
    if (!this._scrubReady) {
      this._scrubReady = (async () => {
        await this.ctx.audioWorklet.addModule(workletUrl);
        for (const d of this.decks) d.attachScrub(new AudioWorkletNode(this.ctx, 'motiondj-scrub', { numberOfOutputs: 1, outputChannelCount: [2] }));
        return true;
      })().catch(() => false);
    }
    return this._scrubReady;
  }
  _impulse(dur, decay) {
    const rate = this.ctx.sampleRate, len = rate * dur, buf = this.ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay); }
    return buf;
  }
  async decode(file) { const ab = await file.arrayBuffer(); return this.ctx.decodeAudioData(ab); }
  applyCrossfader() { const { a, b } = crossfaderGains(this.cross); const t = this.ctx.currentTime; [a, b].forEach((g, i) => { this.decks[i].xGain.gain.setTargetAtTime(g, t, 0.02); this.decks[i].stemEcoOut.gain.setTargetAtTime(g, t, 0.02); }); }
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
