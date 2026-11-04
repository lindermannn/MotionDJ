export class OneEuroFilter {
  constructor({ minCutoff = 1.0, beta = 0.01, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
    this.reset();
  }
  reset() { this.lastTime = undefined; this.lastValue = undefined; this.lastRaw = undefined; this.derivative = 0; }
  filter(value, tMs) {
    if (this.lastTime === undefined) {
      this.lastTime = tMs; this.lastRaw = value; this.lastValue = value;
      return value;
    }
    const dt = (tMs - this.lastTime) / 1000;
    if (dt <= 0) return this.lastValue;
    const alpha = cutoff => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
    const rawDerivative = (value - this.lastRaw) / dt;
    this.derivative += alpha(this.dCutoff) * (rawDerivative - this.derivative);
    this.lastValue += alpha(this.minCutoff + this.beta * Math.abs(this.derivative)) * (value - this.lastValue);
    this.lastRaw = value; this.lastTime = tMs;
    return this.lastValue;
  }
}

export function magnetPoint(point, targets, { radius = 30, strength = 0.65 } = {}) {
  let best = null;
  for (const target of targets) {
    const dx = Math.max(target.x - point.x, 0, point.x - (target.x + target.w));
    const dy = Math.max(target.y - point.y, 0, point.y - (target.y + target.h));
    const distance = Math.hypot(dx, dy);
    const cx = target.x + target.w / 2, cy = target.y + target.h / 2;
    const centerDistance = Math.hypot(cx - point.x, cy - point.y);
    if (!best || distance < best.distance || (distance === best.distance && centerDistance < best.centerDistance)) {
      best = { target, distance, centerDistance, cx, cy };
    }
  }
  if (!best || best.distance > radius) return { x: point.x, y: point.y, id: null };
  const f = strength * (radius === 0 ? 1 : 1 - best.distance / radius);
  return { x: point.x + (best.cx - point.x) * f, y: point.y + (best.cy - point.y) * f, id: best.target.id };
}

export class StickyFocus {
  constructor({ switchMs = 120 } = {}) { this.switchMs = switchMs; this.reset(); }
  reset() { this._current = null; this.pending = undefined; this.pendingSince = undefined; }
  get current() { return this._current; }
  update({ hitId, insideCurrent, now }) {
    if (this._current === null) {
      this._current = hitId; this.pending = undefined;
    } else if (insideCurrent || hitId === this._current) {
      this.pending = undefined;
    } else {
      if (this.pending === undefined || this.pending !== hitId) {
        this.pending = hitId; this.pendingSince = now;
      }
      if (now - this.pendingSince >= this.switchMs) {
        this._current = hitId; this.pending = undefined;
      }
    }
    return this._current;
  }
}

export class ValueHistory {
  constructor({ keepMs = 400 } = {}) { this.keepMs = keepMs; this.reset(); }
  reset() { this.samples = []; }
  push(value, tMs) {
    this.samples.push({ value, tMs });
    this.samples = this.samples.filter(sample => sample.tMs >= tMs - this.keepMs);
  }
  valueAgo(ms, tMs) {
    const samples = this.samples.filter(sample => sample.tMs >= tMs - this.keepMs);
    if (!samples.length) return undefined;
    let oldest = samples[0], match;
    for (const sample of samples) {
      if (sample.tMs < oldest.tMs) oldest = sample;
      if (sample.tMs <= tMs - ms && (!match || sample.tMs >= match.tMs)) match = sample;
    }
    return (match || oldest).value;
  }
}
