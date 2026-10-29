import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinchRatio, PinchDetector, Smoother, crossfaderGains, ControlRegistry, faderValue, expandRect, mapCoverPoint, mapVideoPoint, videoViewport, videoContentRect, mapVideoPointInBox, visibleVideoWindow, parseObjectPosition, fitFromObjectFit, knobDragValue, knobAngle, handsDistance, TwoHandSession } from '../src/gestures/logic.js';
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
test('garra: apertura distingue mano abierta de puno y no salta al enganchar', async () => {
  const { handAperture, aperture01, ClawController } = await import('../src/gestures/claw.js');
  const mk = (spread) => { const lm = Array.from({ length: 21 }, () => ({ x: 0, y: 0 })); lm[9] = { x: 0, y: 1 }; [8, 12, 16, 20].forEach(i => lm[i] = { x: 0, y: spread }); return lm; };
  assert.ok(handAperture(mk(1.8)) > handAperture(mk(1.0)));
  assert.equal(aperture01(mk(1.85)) > 0.9, true);
  const c = new ClawController({ engageMs: 500 }); c.prime(10);
  const opts = { min: -50, max: 50, sensitivity: 1, invert: false, rangeMin01: 0, rangeMax01: 1 };
  assert.equal(c.update({ aperture01: 0.5, pinched: false }, 0, opts).value, 10);
  const eng = c.update({ aperture01: 0.5, pinched: false }, 600, opts);
  assert.equal(eng.event, 'engaged'); assert.equal(eng.value, 10); // captura suave: sin salto
  const moved = c.update({ aperture01: 0.7, pinched: false }, 700, opts);
  assert.ok(moved.value > 10 && moved.value < 30); // delta suavizado, no teletransporte
  const lost = c.update(null, 800, opts);
  assert.equal(lost.engaged, false); assert.equal(lost.value, moved.value); // conserva ultimo valor
  const pinch = c.update({ aperture01: 0.9, pinched: true }, 900, opts);
  assert.equal(pinch.engaged, false); assert.equal(pinch.value, moved.value); // la pinza no es garra
});
test('encuadre completo (contain) no recorta ni deforma y respeta espejo', () => {
  // Video 16:9 en escenario cuadrado 100x100: completo cabe a lo ancho (100x56.25), centrado.
  const vp = videoViewport(1600, 900, 100, 100, 'contain');
  assert.deepEqual(vp, { x: 0, y: 21.875, w: 100, h: 56.25 });
  const c = mapVideoPoint({ x: 0, y: 0 }, 1600, 900, 100, 100, false, 'contain');
  assert.deepEqual(c, { x: 0, y: 21.875 }); // esquina visible: nada queda fuera
  const br = mapVideoPoint({ x: 1, y: 1 }, 1600, 900, 100, 100, false, 'contain');
  assert.deepEqual(br, { x: 100, y: 78.125 });
  const mir = mapVideoPoint({ x: 0, y: 0 }, 1600, 900, 100, 100, true, 'contain');
  assert.equal(mir.x, 100); assert.equal(mir.y, 21.875); // espejo invierte X, no Y
});
test('encuadre recorte (cover) llena recortando, y mapCoverPoint sigue equivalendo', () => {
  const vp = videoViewport(1600, 900, 100, 100, 'cover');
  assert.ok(vp.w > 100 && vp.h === 100 && vp.x < 0 && vp.y === 0);
  const lm = { x: 0.25, y: 0.5 };
  assert.deepEqual(mapVideoPoint(lm, 1600, 900, 100, 100, true, 'cover'), mapCoverPoint(lm, 1600, 900, 100, 100, true));
  // En cover el centro siempre es el centro, en ambos espejos.
  assert.deepEqual(mapVideoPoint({ x: 0.5, y: 0.5 }, 1600, 900, 100, 100, true, 'cover'), { x: 50, y: 50 });
  assert.deepEqual(mapVideoPoint({ x: 0.5, y: 0.5 }, 1600, 900, 300, 200, false, 'contain'), { x: 150, y: 100 });
});
test('mapeo anclado al rectangulo real del video (con desplazamiento) en 4 casos y varios aspectos', () => {
  const box = { x: 10, y: 20, w: 900, h: 500 }; // p. ej. video dentro del escenario, con borde
  const sources = [[1280, 720], [640, 480], [720, 1280], [480, 480], [1920, 1080]];
  for (const [vw, vh] of sources) for (const fit of ['cover', 'contain']) for (const mirrored of [true, false]) {
    // El centro siempre cae en el centro del rectangulo del video.
    const c = mapVideoPointInBox({ x: 0.5, y: 0.5 }, vw, vh, box, mirrored, fit);
    assert.deepEqual(c, { x: box.x + box.w / 2, y: box.y + box.h / 2 }, `${vw}x${vh} ${fit} espejo=${mirrored}`);
    // Espejo y normal son simetricos respecto al eje vertical del contenido.
    const a = mapVideoPointInBox({ x: 0.2, y: 0.3 }, vw, vh, box, false, fit);
    const b = mapVideoPointInBox({ x: 0.2, y: 0.3 }, vw, vh, box, true, fit);
    const content = videoContentRect(vw, vh, box.w, box.h, fit);
    assert.ok(Math.abs((a.x + b.x) - 2 * (box.x + content.x + content.w / 2)) < 1e-9);
    assert.equal(a.y, b.y);
    // La ventana visible (lo que la camara muestra) cae exactamente en los bordes del video.
    const win = visibleVideoWindow(vw, vh, box.w, box.h, fit);
    const tl = mapVideoPointInBox({ x: win.u0, y: win.v0 }, vw, vh, box, false, fit);
    const br = mapVideoPointInBox({ x: win.u1, y: win.v1 }, vw, vh, box, false, fit);
    assert.ok(Math.abs(tl.x - (box.x + content.x + win.u0 * content.w)) < 1e-9 && Math.abs(tl.y - (box.y + content.y + win.v0 * content.h)) < 1e-9, `tl ${vw}x${vh} ${fit}`);
    assert.ok(Math.abs(br.x - (box.x + content.x + win.u1 * content.w)) < 1e-9 && Math.abs(br.y - (box.y + content.y + win.v1 * content.h)) < 1e-9, `br ${vw}x${vh} ${fit}`);
    if (fit === 'cover') { // en recorte, la ventana visible llena exactamente la caja del video
      assert.ok(Math.abs(tl.x - box.x) < 1e-9 && Math.abs(br.x - (box.x + box.w)) < 1e-9, `cover llena ${vw}x${vh}`);
    }
    if (fit === 'contain') assert.ok(Math.abs(win.u0) < 1e-9 && Math.abs(win.v0) < 1e-9 && Math.abs(win.u1 - 1) < 1e-9 && Math.abs(win.v1 - 1) < 1e-9); // completo: se ve todo
  }
});
test('regresion DroidCam real: fuente 4:3, escenario ancho, RECORTE con espejo', () => {
  // Geometria medida de la captura del usuario (fuente 964x720, escenario
  // ~1884x594): su dedo se veia en el punto de escenario (1701, 101) y el
  // cursor caia en ~(1271, 221), que es donde cae el mapeo 'contain'.
  // Con el ajuste que realmente se muestra ('cover'), el cursor debe caer
  // sobre el dedo.
  const box = { x: 0, y: 0, w: 1884, h: 594 };
  const lm = { x: 0.097, y: 0.36 }; // landmark que en cover se ve en (1701, 101)
  const cover = mapVideoPointInBox(lm, 964, 720, box, true, fitFromObjectFit('cover'));
  assert.ok(Math.abs(cover.x - 1701) < 2 && Math.abs(cover.y - 101) < 2, `cover=${cover.x},${cover.y}`);
  const contain = mapVideoPointInBox(lm, 964, 720, box, true, fitFromObjectFit('contain'));
  assert.ok(Math.abs(contain.x - 1271) < 15 && Math.abs(contain.y - 221) < 15, `contain=${contain.x},${contain.y}`); // el error observado
  assert.ok(Math.hypot(cover.x - contain.x, cover.y - contain.y) > 300); // no son intercambiables
  assert.equal(fitFromObjectFit('cover'), 'cover');
  assert.equal(fitFromObjectFit('contain'), 'contain');
  assert.equal(fitFromObjectFit('fill'), 'contain'); // desconocido: sin recorte, seguro
  assert.equal(fitFromObjectFit(''), 'contain');
});
test('object-position se interpreta y desplaza el recorte de cover', () => {
  assert.deepEqual(parseObjectPosition('50% 50%'), { x: 0.5, y: 0.5 });
  assert.deepEqual(parseObjectPosition('left top'), { x: 0, y: 0 });
  assert.deepEqual(parseObjectPosition('right bottom'), { x: 1, y: 1 });
  assert.deepEqual(parseObjectPosition('25% 75%'), { x: 0.25, y: 0.75 });
  // Con object-position a la izquierda, en cover se ve el borde izquierdo de la fuente.
  const win = visibleVideoWindow(1280, 720, 500, 500, 'cover', { x: 0, y: 0.5 });
  assert.equal(win.u0, 0); assert.ok(win.u1 < 1);
  const r = videoContentRect(1280, 720, 500, 500, 'cover', { x: 0, y: 0.5 });
  assert.equal(r.x, 0);
});
test('garra: la compuerta la bloquea con pinza, dos manos, agarre o transicion', async () => {
  const { clawGate, ClawController } = await import('../src/gestures/claw.js');
  const base = { enabled: true, handCount: 1, anyPinched: false, anyGrabbed: false, twoHandBusy: false, expressiveActive: false, autoTransition: false };
  assert.equal(clawGate(base).run, true);
  assert.equal(clawGate({ ...base, enabled: false }).run, false);
  assert.equal(clawGate({ ...base, anyPinched: true }).run, false);
  assert.equal(clawGate({ ...base, handCount: 2 }).run, false);
  assert.equal(clawGate({ ...base, handCount: 0 }).run, false);
  assert.equal(clawGate({ ...base, anyGrabbed: true }).run, false);
  assert.equal(clawGate({ ...base, twoHandBusy: true }).run, false);
  assert.equal(clawGate({ ...base, expressiveActive: true }).run, false);
  assert.equal(clawGate({ ...base, autoTransition: true }).run, false);
  // prime sigue el valor manual mientras no engancha: sin salto al re-enganchar
  const c = new ClawController({ engageMs: 500 }); c.prime(10);
  const opts = { min: -50, max: 50, sensitivity: 1, invert: false, rangeMin01: 0, rangeMax01: 1 };
  c.update({ aperture01: 0.5, pinched: false }, 0, opts); c.update({ aperture01: 0.5, pinched: false }, 600, opts);
  c.update(null, 700, opts); c.prime(-20); // el usuario movio el parametro a mano
  c.update({ aperture01: 0.5, pinched: false }, 1300, opts);
  const re = c.update({ aperture01: 0.5, pinched: false }, 1900, opts);
  assert.equal(re.event, 'engaged'); assert.equal(re.value, -20);
});
test('Auto DJ: espera sin destino, dispara cerca del final y alterna', async () => {
  const { evaluateAutoDj, autoDjTriggerKey } = await import('../src/audio/autodj.js');
  const mk = (a, b) => ({ enabled: true, cross: 0, anticipationSec: 15, decks: [a, b] });
  const playingA = { hasTrack: true, playing: true, position: 100, duration: 200 };
  assert.equal(evaluateAutoDj({ enabled: false, decks: [playingA, playingA] }).state, 'off');
  assert.equal(evaluateAutoDj(mk(playingA, { hasTrack: false, playing: false, position: 0, duration: 0 })).ready, false); // no deja la sesion sin musica
  assert.equal(evaluateAutoDj(mk(playingA, { hasTrack: false, playing: false, position: 0, duration: 0 })).shouldTransition, false);
  const armed = evaluateAutoDj(mk(playingA, { hasTrack: true, playing: false, position: 0, duration: 180 }));
  assert.deepEqual([armed.active, armed.next, armed.ready, armed.shouldTransition], [0, 1, true, false]);
  const due = evaluateAutoDj(mk({ ...playingA, position: 190 }, { hasTrack: true, playing: false, position: 0, duration: 180 }));
  assert.equal(due.shouldTransition, true); assert.equal(due.remainingSec, 10);
  // Tras la mezcla suena B (cross a la derecha): el activo pasa a ser B y el destino A.
  const after = evaluateAutoDj({ enabled: true, cross: 1, anticipationSec: 15, decks: [{ ...playingA, position: 200 }, { hasTrack: true, playing: true, position: 5, duration: 180 }] });
  assert.deepEqual([after.active, after.next], [1, 0]);
  assert.equal(autoDjTriggerKey(due, ['a1', 'b1']), '0:a1');
  assert.equal(autoDjTriggerKey(after, ['a1', 'b1']), '1:b1'); // clave distinta: una sola vez por pista
});
test('selector de efectos: recorrer no toca parametros y conserva el deck', async () => {
  const { EFFECT_CATALOG, createEffectSelection, cycleEffect, effectById } = await import('../src/audio/effects.js');
  let s = createEffectSelection();
  assert.equal(s.effectId, EFFECT_CATALOG[0].id);
  s = cycleEffect(s, 1); assert.equal(s.effectId, EFFECT_CATALOG[1].id); assert.equal(s.deck, 0);
  s = cycleEffect({ effectId: s.effectId, deck: 1 }, 1); assert.equal(s.deck, 1);
  s = cycleEffect(s, -1); s = cycleEffect(s, -1);
  assert.equal(s.effectId, EFFECT_CATALOG[0].id); // dos atras desde el tercero vuelve al primero
  assert.equal(cycleEffect(s, -1).effectId, EFFECT_CATALOG.at(-1).id); // y envuelve al ultimo
  assert.equal(effectById('no-existe').id, EFFECT_CATALOG[0].id);
});
test('perilla: arrastre relativo sin salto, recorrido ajustable y topes', () => {
  // LOW de -24 a +24, parte de -6 (valor actual: al pinzar no hay salto)
  assert.equal(knobDragValue(-6, 0, -24, 24, 220), -6);
  assert.equal(knobDragValue(-6, 110, -24, 24, 220), 18); // media recorrido = medio rango
  assert.equal(knobDragValue(-6, 220, -24, 24, 220), 24); // tope superior
  assert.equal(knobDragValue(-6, -500, -24, 24, 220), -24); // tope inferior
  assert.equal(knobDragValue(-6, 110, -24, 24, 440), 6); // doble recorrido = mitad de efecto
  assert.equal(knobDragValue(0, 110, -24, 24, 0), 24); // px invalido usa 220 por defecto
  assert.equal(knobAngle(-24, -24, 24), -135);
  assert.equal(knobAngle(0, -24, 24), 0);
  assert.equal(knobAngle(24, -24, 24), 135);
});
test('suavizado reduce saltos y fader mapea bordes', () => {
  const s = new Smoother(0.5); s.update(0);
  assert.equal(s.update(100), 50);
  assert.equal(faderValue({ rect: { x: 0, y: 0, w: 100, h: 10 }, orientation: 'h' }, 0, 0), 0);
  assert.equal(faderValue({ rect: { x: 0, y: 0, w: 100, h: 10 }, orientation: 'h' }, 100, 0), 1);
});
