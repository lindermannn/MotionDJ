import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinchRatio, PinchDetector, Smoother, crossfaderGains, ControlRegistry, faderValue } from '../src/gestures/logic.js';

const hand = (tipDist) => {
  const lm = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  lm[0] = { x: 0, y: 0 }; lm[9] = { x: 0, y: 1 }; // escala = 1
  lm[4] = { x: 0, y: 0.5 }; lm[8] = { x: tipDist, y: 0.5 };
  return lm;
};
test('pinchRatio normaliza por tamano de mano', () => {
  assert.equal(pinchRatio(hand(0.2)), 0.2);
  assert.equal(pinchRatio(hand(0.9)), 0.9);
});
test('pinza con histeresis no oscila', () => {
  const d = new PinchDetector({ on: 0.38, off: 0.52 });
  assert.equal(d.update(0.3).started, true);
  assert.equal(d.update(0.45).pinched, true); // entre umbrales: mantiene
  assert.equal(d.update(0.45).started, false); // sin reactivacion
  assert.equal(d.update(0.6).ended, true);
  assert.equal(d.update(0.45).pinched, false);
});
test('crossfader equal-power extremos y centro', () => {
  assert.ok(Math.abs(crossfaderGains(-1).b) < 1e-9);
  assert.ok(Math.abs(crossfaderGains(1).a) < 1e-9);
  const c = crossfaderGains(0);
  assert.ok(Math.abs(c.a - Math.SQRT1_2) < 1e-9 && Math.abs(c.b - Math.SQRT1_2) < 1e-9);
});
test('una mano no roba el control de la otra y perderla libera solo el suyo', () => {
  const r = new ControlRegistry();
  r.register('x', { x: 0, y: 0, w: 10, h: 10 });
  r.register('y', { x: 20, y: 0, w: 10, h: 10 });
  assert.equal(r.hit(5, 5).id, 'x');
  assert.equal(r.grab(0, 'x'), true);
  assert.equal(r.grab(1, 'x'), false);
  assert.equal(r.grab(1, 'y'), true);
  assert.equal(r.release(0), 'x');
  assert.equal(r.grabbedBy(1), 'y');
});
test('suavizado reduce saltos y fader mapea bordes', () => {
  const s = new Smoother(0.5); s.update(0);
  assert.equal(s.update(100), 50);
  assert.equal(faderValue({ rect: { x: 0, y: 0, w: 100, h: 10 }, orientation: 'h' }, 0, 0), 0);
  assert.equal(faderValue({ rect: { x: 0, y: 0, w: 100, h: 10 }, orientation: 'h' }, 100, 0), 1);
});
