import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OneEuroFilter, magnetPoint, StickyFocus, ValueHistory } from '../src/gestures/precision.js';

const variance = values => {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
};

test('One Euro reduce ruido y responde rapidamente a un salto', () => {
  const filter = new OneEuroFilter();
  const raw = Array.from({ length: 120 }, (_, i) => 100 + (i % 2 ? 2 : -2));
  const filtered = raw.map((value, i) => filter.filter(value, i * 16));
  assert.ok(variance(filtered.slice(20)) < variance(raw.slice(20)));
  assert.ok(filter.filter(300, 120 * 16) > 150);
  const last = filter.filter(300, 121 * 16);
  assert.equal(filter.filter(0, 121 * 16), last);
  assert.equal(filter.filter(0, 120 * 16), last);
  filter.reset();
  assert.equal(filter.filter(42, 0), 42);
});

test('magnetismo respeta radio, interior, borde y desempate', () => {
  const target = { id: 'a', x: 10, y: 10, w: 20, h: 20 };
  assert.deepEqual(magnetPoint({ x: -21, y: 20 }, [target]), { x: -21, y: 20, id: null });
  assert.deepEqual(magnetPoint({ x: 10, y: 20 }, [target], { strength: 0.5 }), { x: 15, y: 20, id: 'a' });
  assert.deepEqual(magnetPoint({ x: 12, y: 20 }, [target], { strength: 0.5 }), { x: 16, y: 20, id: 'a' });
  assert.deepEqual(magnetPoint({ x: -20, y: 20 }, [target]), { x: -20, y: 20, id: 'a' });
  const overlapping = [{ id: 'far', x: 0, y: 0, w: 100, h: 100 }, { id: 'near', x: 0, y: 0, w: 20, h: 20 }];
  assert.equal(magnetPoint({ x: 10, y: 10 }, overlapping).id, 'near');
  assert.equal(magnetPoint({ x: 0, y: 0 }, []).id, null);
});

test('foco mantiene, espera y reinicia el intervalo ante cambios', () => {
  const focus = new StickyFocus({ switchMs: 120 });
  assert.equal(focus.update({ hitId: 'a', insideCurrent: false, now: 0 }), 'a');
  assert.equal(focus.update({ hitId: 'b', insideCurrent: true, now: 100 }), 'a');
  assert.equal(focus.update({ hitId: 'b', insideCurrent: false, now: 200 }), 'a');
  assert.equal(focus.update({ hitId: 'b', insideCurrent: false, now: 319 }), 'a');
  assert.equal(focus.update({ hitId: 'b', insideCurrent: false, now: 320 }), 'b');
  assert.equal(focus.update({ hitId: null, insideCurrent: false, now: 400 }), 'b');
  assert.equal(focus.update({ hitId: 'a', insideCurrent: false, now: 500 }), 'b');
  assert.equal(focus.update({ hitId: null, insideCurrent: false, now: 550 }), 'b');
  assert.equal(focus.update({ hitId: null, insideCurrent: false, now: 670 }), null);
  focus.reset(); assert.equal(focus.current, null);
});

test('historial busca valores anteriores y descarta muestras antiguas', () => {
  const history = new ValueHistory({ keepMs: 400 });
  assert.equal(history.valueAgo(10, 0), undefined);
  history.push('a', 0); history.push('b', 100); history.push('c', 300);
  assert.equal(history.valueAgo(150, 300), 'b');
  assert.equal(history.valueAgo(500, 300), 'a');
  history.push('d', 500);
  assert.equal(history.valueAgo(500, 500), 'b');
  assert.equal(history.valueAgo(0, 901), undefined);
  history.reset(); assert.equal(history.valueAgo(0, 500), undefined);
});
