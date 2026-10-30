// AudioWorklet de scrub (P3): lee el buffer del deck con posicion y
// velocidad variables en ambos sentidos, con interpolacion lineal y
// fundidos cortos al entrar/salir para que no haya clic.
// Mensajes: {type:'load', left, right} · {type:'set', pos, speed, playing}
// Publica {type:'pos', pos} cada ~2048 muestras procesadas.
class ScrubProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.left = null; this.right = null; this.pos = 0; this.speed = 0;
    this.playing = false; this.gain = 0; this.count = 0;
    this.port.onmessage = e => {
      const m = e.data;
      if (m.type === 'load') { this.left = m.left; this.right = m.right || m.left; }
      if (m.type === 'set') {
        if (Number.isFinite(m.pos)) this.pos = m.pos;
        if (Number.isFinite(m.speed)) this.speed = Math.max(-3, Math.min(3, m.speed));
        if (typeof m.playing === 'boolean') this.playing = m.playing;
      }
    };
  }
  sample(ch, p) {
    if (!ch || ch.length === 0) return 0;
    const i = Math.floor(p), f = p - i;
    const a = ch[Math.max(0, Math.min(ch.length - 1, i))];
    const b = ch[Math.max(0, Math.min(ch.length - 1, i + 1))];
    return a + (b - a) * f;
  }
  process(inputs, outputs) {
    const out = outputs[0], l = out[0], r = out[1] || out[0];
    const target = this.playing && this.left ? 1 : 0;
    for (let i = 0; i < l.length; i++) {
      this.gain += (target - this.gain) * 0.02; // fundido ~ sin clic
      if (this.left && this.gain > 0.001) {
        l[i] = this.sample(this.left, this.pos) * this.gain;
        r[i] = this.sample(this.right, this.pos) * this.gain;
      } else { l[i] = 0; r[i] = 0; }
      if (this.playing && this.left) {
        this.pos += this.speed; // speed en muestras por muestra (1 = normal)
        const len = this.left.length;
        if (this.pos >= len) this.pos -= len;
        if (this.pos < 0) this.pos += len;
      }
      if (++this.count >= 2048) { this.count = 0; this.port.postMessage({ type: 'pos', pos: this.pos / (sampleRate || 44100) }); }
    }
    return true;
  }
}
registerProcessor('motiondj-scrub', ScrubProcessor);
