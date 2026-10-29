import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinchRatio, PinchDetector, Smoother, crossfaderGains, ControlRegistry, faderValue, expandRect, mapCoverPoint, handsDistance, TwoHandSession } from '../src/gestures/logic.js';
import { transitionValues, expressiveValues, smooth } from '../src/audio/transition.js';

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
test('zonas ampliadas garantizan minimo y mapeo espejo/normal sigue al dedo', () => {
  const r = expandRect({ x: 100, y: 100, w: 20, h: 10 }, 16);
  assert.ok(r.w >= 44 && r.h >= 40 && r.x < 100 && r.y < 100);
  const lm = { x: 0.25, y: 0.5 };
  const espejo = mapCoverPoint(lm, 100, 100, 100, 100, true);
  const normal = mapCoverPoint(lm, 100, 100, 100, 100, false);
  assert.equal(espejo.x, 75); assert.equal(normal.x, 25); assert.equal(espejo.y, 50);
});
test('dos manos: bailar o una pinza breve no prepara; hace falta mantener, soltar y confirmar', () => {
  const s = new TwoHandSession({ holdMs: 700, lossMs: 300 });
  assert.equal(s.update({ bothPinched: true, bothPresent: true }, 0).event, null);
  assert.equal(s.update({ bothPinched: true, bothPresent: true }, 300).event, null); // breve
  s.update({ bothPinched: false, bothPresent: true }, 400);
  s.update({ bothPinched: true, bothPresent: true }, 500);
  assert.equal(s.update({ bothPinched: true, bothPresent: true }, 1300).event, 'prepared');
  assert.equal(s.update({ bothPinched: false, bothPresent: true }, 1400).event, 'armed');
  assert.equal(s.update({ bothPinched: true, bothPresent: true }, 1500).event, 'confirmed');
  assert.equal(s.update({ bothPinched: false, bothPresent: false }, 1600).event, null);
  assert.equal(s.update({ bothPinched: false, bothPresent: false }, 2000).event, 'freeze'); // pierde mano en activo
});
test('transicion suave y expresiva son continuas en los extremos', () => {
  assert.equal(transitionValues(0, -1, 1).cross, -1);
  assert.equal(transitionValues(1, -1, 1).cross, 1);
  assert.equal(transitionValues(1, -1, 1).delay, Math.sin(Math.PI) * 0.3);
  assert.ok(Math.abs(smooth(0.5) - 0.5) < 1e-9);
  const ex = expressiveValues(1, 1, 1);
  assert.equal(ex.cross, 1); assert.equal(ex.filter, 50);
  assert.equal(handsDistance({ x: 0, y: 0 }, { x: 60, y: 0 }, 100), 1);
});
test('suavizado reduce saltos y fader mapea bordes', () => {
  const s = new Smoother(0.5); s.update(0);
  assert.equal(s.update(100), 50);
  assert.equal(faderValue({ rect: { x: 0, y: 0, w: 100, h: 10 }, orientation: 'h' }, 0, 0), 0);
  assert.equal(faderValue({ rect: { x: 0, y: 0, w: 100, h: 10 }, orientation: 'h' }, 100, 0), 1);
});
