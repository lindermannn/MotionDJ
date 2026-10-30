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
test('Channel: position() continua tras cambio de rate, siguiendo la rampa real', async () => {
  const { Channel } = await import('../src/audio/engine.js');
  const node = () => ({ connect() {}, gain: { value: 0, setTargetAtTime() {} }, frequency: { value: 0, setTargetAtTime() {} }, Q: { value: 0 } });
  const ctx = { currentTime: 0, createGain: node, createBiquadFilter: node, createAnalyser: node,
    createBufferSource: () => ({ buffer: null, playbackRate: { value: 1, setTargetAtTime() {} }, connect() {}, start() {}, stop() {}, onended: null, loop: false }) };
  const ch = new Channel(ctx, node());
  ch.load({ duration: 100 });
  ch.play(); // t=0, posicion 0, rate 1
  ctx.currentTime = 2;
  assert.ok(Math.abs(ch.position() - 2) < 1e-9);
  ch.setRate(1.4);
  assert.ok(Math.abs(ch.position() - 2) < 1e-9, 'sin salto al cambiar el rate');
  // Posicion "real" del audio: integracion numerica de la rampa setTargetAtTime
  // (v = destino + (inicio-destino)*exp(-t/tau)), en pasos de 0,25 ms.
  let real = 2, t = 2, from = 1, to = 1.4, t0 = 2;
  const stepTo = (end) => { const dt = 0.00025; while (t < end) { real += (to + (from - to) * Math.exp(-(t - t0) / 0.03)) * dt; t += dt; ctx.currentTime = t; } };
  stepTo(2.03); assert.ok(Math.abs(ch.position() - real) < 0.002, `durante la rampa: ${ch.position()} vs ${real}`);
  stepTo(2.15); assert.ok(Math.abs(ch.position() - real) < 0.002, 'tras la rampa');
  // Segundo cambio a mitad de rampa: tambien continuo y fiel a la integral.
  from = to + (from - to) * Math.exp(-(t - t0) / 0.03); to = 0.8; t0 = t;
  const before2 = ch.position();
  ch.setRate(0.8);
  assert.ok(Math.abs(ch.position() - before2) < 1e-9, 'sin salto en el segundo cambio');
  stepTo(2.8); assert.ok(Math.abs(ch.position() - real) < 0.002, `tras el segundo cambio: ${ch.position()} vs ${real}`);
  ch.pause(); const paused = ch.position();
  ctx.currentTime = 5; assert.equal(ch.position(), paused); // en pausa no avanza
});
test('beatgrid: demos a 122/124 con error <= 0,3 BPM y sinteticos con fase +-20 ms', async () => {
  const { analyzeBeatgrid } = await import('../src/audio/beatgrid.js');
  const { readFileSync } = await import('node:fs');
  const readWav = (url) => {
    const b = readFileSync(url);
    const sr = b.readUInt32LE(24), n = (b.length - 44) / 4, d = new Float32Array(n);
    for (let i = 0; i < n; i++) d[i] = (b.readInt16LE(44 + i * 4) + b.readInt16LE(46 + i * 4)) / 65536;
    return { d, sr };
  };
  for (const [f, real] of [['../public/audio/demo-a.wav', 122], ['../public/audio/demo-b.wav', 124]]) {
    const { d, sr } = readWav(new URL(f, import.meta.url));
    const r = analyzeBeatgrid(d, sr);
    assert.ok(Math.abs(r.bpm - real) <= 0.3, `${f}: ${r.bpm} vs ${real}`);
    assert.ok(r.confidence > 0.3, `${f} confianza ${r.confidence}`);
    assert.ok(r.firstBeat >= 0 && r.firstBeat < 60 / r.bpm, 'fase dentro del periodo');
  }
  const synth = (bpm, offset, sub = 0) => {
    const sr = 44100, dur = 12, data = new Float32Array(sr * dur), beat = 60 / bpm;
    const kick = (t0, amp) => { const n0 = Math.floor(t0 * sr); for (let i = 0; i < sr * 0.12 && n0 + i < data.length; i++) { const tt = i / sr; data[n0 + i] += Math.sin(2 * Math.PI * (58 - tt * 160) * tt) * Math.exp(-tt * 28) * amp; } };
    for (let tt = offset; tt < dur; tt += beat) { kick(tt, 0.95); if (sub) kick(tt + beat / 2, sub); }
    return data;
  };
  for (const [bpm, off] of [[90, 0.31], [128, 0.47], [174, 0.12]]) {
    const r = analyzeBeatgrid(synth(bpm, off), 44100);
    assert.ok(Math.abs(r.bpm - bpm) <= 0.3, `synth ${bpm}: ${r.bpm}`);
    assert.ok(Math.abs(r.firstBeat - off) <= 0.02, `synth ${bpm} fase: ${r.firstBeat} vs ${off}`);
  }
  // Sin ambiguedad en los casos limpios medidos (90 y 174).
  assert.equal(analyzeBeatgrid(synth(90, 0.31), 44100).ambiguous, false);
  assert.equal(analyzeBeatgrid(synth(174, 0.12), 44100).ambiguous, false);
  const amb = analyzeBeatgrid(synth(100, 0.2, 0.6), 44100);
  assert.equal(amb.ambiguous, true, 'subdivision fuerte marca ambiguedad');
  assert.ok(Math.abs(amb.bpm - 100) <= 0.3 || Math.abs(amb.bpm - 200) <= 0.6, `octava avisada: ${amb.bpm}`);
});
test('beatgrid: criterio musical de octava para musica de baile (132 leido a 66)', async () => {
  const { analyzeBeatgrid, musicalOctave } = await import('../src/audio/beatgrid.js');
  assert.equal(musicalOctave(66, -0.01), 66); // sin soporte: se queda
  assert.equal(musicalOctave(66, 0.54), 132);
  assert.equal(musicalOctave(66, 0.78), 132);
  assert.equal(musicalOctave(100, 0.9), 100); // >=90 no se toca
  assert.equal(musicalOctave(44, 0.9), 44); // el doble (88) queda fuera de 90-180
  const sr = 44100, synth = (bpm, accent) => {
    const data = new Float32Array(sr * 12), beat = 60 / bpm;
    const kick = (t0, amp) => { const n0 = Math.floor(t0 * sr); for (let i = 0; i < sr * 0.12 && n0 + i < data.length; i++) { const tt = i / sr; data[n0 + i] += Math.sin(2 * Math.PI * (58 - tt * 160) * tt) * Math.exp(-tt * 28) * amp; } };
    let k = 0; for (let tt = 0.21; tt < 12; tt += beat, k++) kick(tt, accent && k % 2 ? 0.3 : 0.95);
    return data;
  };
  const acc = analyzeBeatgrid(synth(132, true), sr); // acento cada 2 golpes: antes salia 66
  assert.ok(Math.abs(acc.bpm - 132) <= 0.6, `132 con acento: ${acc.bpm}`);
  const slow = analyzeBeatgrid(synth(66, false), sr); // 66 uniforme: no se dobla
  assert.ok(Math.abs(slow.bpm - 66) <= 0.3, `66 uniforme: ${slow.bpm}`);
});
test('beatgrid: cuantizacion, alineacion de fase, TAP y tiempo de eco', async () => {
  const { quantizeToBeat, beatPhase01, alignToPhase, tapTempo, beatDelayTime } = await import('../src/audio/beatgrid.js');
  const grid = { bpm: 120, firstBeat: 0.25 }; // tiempo = 0,5 s
  assert.equal(quantizeToBeat(1.3, grid), 1.25);
  assert.equal(quantizeToBeat(1.41, grid), 1.25);
  assert.equal(quantizeToBeat(1.45, grid), 1.25);
  assert.equal(quantizeToBeat(1.6, grid), 1.75);
  assert.equal(beatPhase01(1.25, grid), 0);
  assert.ok(Math.abs(beatPhase01(1.5, grid) - 0.5) < 1e-9);
  const aligned = alignToPhase(3.1, grid, 0.5);
  assert.ok(Math.abs(beatPhase01(aligned, grid) - 0.5) < 1e-9 && Math.abs(aligned - 3.1) <= 0.25);
  assert.equal(quantizeToBeat(1.3, null), 1.3); // sin rejilla no toca nada
  assert.equal(tapTempo([0, 500, 1000, 1500]), 120);
  assert.equal(tapTempo([0, 500]), null);
  assert.ok(Math.abs(beatDelayTime(120, 0.5) - 0.25) < 1e-9);
  assert.ok(Math.abs(beatDelayTime(128, 0.25) - 60 / 128 * 0.25) < 1e-9);
  assert.equal(beatDelayTime(null, 0.5), null); // sin BPM: eco sin sincronizar
});
test('SYNC con BPM efectivo: converge al pulsar en ambos decks y es idempotente', async () => {
  const { syncTempoPct, effectiveBpm } = await import('../src/audio/beatgrid.js');
  // Caso observado: A 154,1 y B 152,0, sin tempo aplicado.
  let a = { bpm: 154.1, tempo: 0 }, b = { bpm: 152.0, tempo: 0 };
  let s = syncTempoPct(a.bpm, b.bpm, b.tempo);
  assert.ok(s.ok); a.tempo = s.pct;
  assert.ok(Math.abs(effectiveBpm(a.bpm, a.tempo) - 152.0) < 1e-9);
  // Ahora SYNC en B: el objetivo es el efectivo de A (152), no su nominal.
  s = syncTempoPct(b.bpm, a.bpm, a.tempo);
  assert.ok(s.ok); b.tempo = s.pct;
  assert.ok(Math.abs(effectiveBpm(b.bpm, b.tempo) - effectiveBpm(a.bpm, a.tempo)) < 1e-9, 'mismo BPM efectivo');
  // Segunda vez en cada deck: no cambia nada.
  assert.ok(Math.abs(syncTempoPct(a.bpm, b.bpm, b.tempo).pct - a.tempo) < 0.051);
  assert.ok(Math.abs(syncTempoPct(b.bpm, a.bpm, a.tempo).pct - b.tempo) < 0.051);
  // Con tempo previo en el otro: A a 124 con +4% debe mandar sobre B a 120.
  s = syncTempoPct(120, 124, 4);
  assert.ok(Math.abs(s.effectiveOther - 128.96) < 1e-9 && Math.abs(s.pct - 7.4667) < 0.01);
  assert.equal(syncTempoPct(null, 124, 0).ok, false); // sin BPM no actua
  assert.equal(syncTempoPct(120, null, 0).ok, false);
  assert.equal(syncTempoPct(100, 130, 0).reason, 'fuera-rango'); // limite +-8 %
});
test('eco sigue al BPM efectivo: al corregir BPM, deck o fraccion se recalcula', async () => {
  const { ecoDelayFor } = await import('../src/audio/beatgrid.js');
  assert.ok(Math.abs(ecoDelayFor(120, 0, 0.5).sec - 0.25) < 1e-9);
  assert.ok(Math.abs(ecoDelayFor(120, 0, 0.25).sec - 0.125) < 1e-9);
  // Corregir el BPM a la mitad duplica el tiempo del eco.
  assert.ok(Math.abs(ecoDelayFor(60, 0, 0.5).sec - 0.5) < 1e-9);
  // Con tempo aplicado +25 %, el eco usa el efectivo (150), no el nominal.
  const e = ecoDelayFor(120, 25, 1);
  assert.ok(Math.abs(e.effectiveBpm - 150) < 1e-9 && Math.abs(e.sec - 0.4) < 1e-9);
  assert.equal(ecoDelayFor(null, 0, 0.5), null); // sin BPM: no tocar el tiempo
});
test('perillas: dos manos en dos perillas, rangos EQ/Trim y filtro bipolar', () => {
  const r = new ControlRegistry();
  r.register('lowA', { x: 0, y: 0, w: 84, h: 84 }, { z: 1 });
  r.register('highB', { x: 60, y: 0, w: 84, h: 84 }, { z: 1 }); // zonas solapadas a proposito
  assert.equal(r.hit(70, 42).id, 'lowA'); // a igual z gana la primera zona que contiene... ver hit: la especifica
  assert.equal(r.grab(0, 'lowA'), true);
  assert.equal(r.grab(1, 'lowA'), false); // no roba
  assert.equal(r.grab(1, 'highB'), true);
  assert.equal(r.grabbedBy(0), 'lowA'); assert.equal(r.grabbedBy(1), 'highB');
  r.release(0); assert.equal(r.grabbedBy(1), 'highB'); // liberar una no libera la otra
  // Rangos: TRIM 0..2 desde 1; FILTRO bipolar -50..50 desde el centro 0.
  assert.equal(knobDragValue(1, 220, 0, 2, 220), 2);
  assert.equal(knobDragValue(1, -110, 0, 2, 220), 0);
  assert.equal(knobDragValue(1, -55, 0, 2, 220), 0.5);
  assert.equal(knobDragValue(0, 0, -50, 50, 220), 0); // filtro al pinzar en el centro: sin salto
  assert.equal(knobAngle(0, -50, 50), 0); // centro = aguja arriba (marca)
  assert.equal(knobDragValue(0, 220, -50, 50, 220), 50);
  assert.equal(knobDragValue(0, -220, -50, 50, 220), -50);
});
test('cola: orden, siguiente al deck libre y nunca sobre un deck que suena', async () => {
  const { enqueue, removeFromQueue, takeNext, chooseTargetDeck, freeDeckIndex } = await import('../src/audio/queue.js');
  let q = enqueue(enqueue([], 'a'), 'b');
  assert.deepEqual(q, ['a', 'b']);
  const t1 = takeNext(q); assert.equal(t1.track, 'a'); assert.deepEqual(t1.queue, ['b']);
  assert.deepEqual(removeFromQueue(['a', 'b', 'c'], 1), ['a', 'c']);
  assert.equal(takeNext([]).track, null);
  assert.equal(freeDeckIndex([true, false]), 1);
  assert.equal(freeDeckIndex([true, true]), -1);
  // Prefiere el deck vacio y parado; si los dos tienen pista, el parado.
  assert.equal(chooseTargetDeck([{ hasTrack: true, playing: true }, { hasTrack: false, playing: false }]), 1);
  assert.equal(chooseTargetDeck([{ hasTrack: true, playing: true }, { hasTrack: true, playing: false }]), 1);
  assert.equal(chooseTargetDeck([{ hasTrack: false, playing: false }, { hasTrack: true, playing: true }]), 0);
  assert.equal(chooseTargetDeck([{ hasTrack: true, playing: true }, { hasTrack: true, playing: true }]), -1);
});
test('scratch: velocidad del jog a rate, limites y angulo desenvuelto', async () => {
  const { scratchRate, jogAngleDelta } = await import('../src/gestures/logic.js');
  assert.equal(scratchRate(0, 1), 0); // jog quieto: la pista casi se detiene
  assert.ok(Math.abs(scratchRate(0.5, 1) - 0.9) < 1e-9); // 0,5 vueltas/s x 1,8 s/vuelta
  assert.equal(scratchRate(-2, 1), scratchRate(2, 1)); // atras = frenar (sin reverse)
  assert.equal(scratchRate(10, 1), 3); // limite de velocidad
  assert.ok(Math.abs(scratchRate(0.5, 1.2) - 1.08) < 1e-9); // respeta el rate del deck
  assert.ok(Math.abs(jogAngleDelta(3.1, -3.1) - (2 * Math.PI - 6.2)) < 1e-9); // cruza el corte
  assert.ok(Math.abs(jogAngleDelta(0, 0.5) - 0.5) < 1e-9);
});
test('onda: arrastre fino anclado sin salto, con topes y sensibilidad', async () => {
  const { waveDragPosition } = await import('../src/gestures/logic.js');
  assert.equal(waveDragPosition(30, 0, 240), 30); // al pinzar no hay salto
  assert.equal(waveDragPosition(30, 22, 240), 31); // 22 px = 1 s (220 px/10 s)
  assert.equal(waveDragPosition(30, 220, 240), 40);
  assert.equal(waveDragPosition(30, -220, 240), 20);
  assert.equal(waveDragPosition(30, 220, 240, 440), 35); // doble recorrido = mitad
  assert.equal(waveDragPosition(5, -9999, 240), 0); // topes
  assert.equal(waveDragPosition(235, 9999, 240), 240);
});
test('saturacion: hold de 500 ms y ajustes del limitador con techo -3 dB', async () => {
  const { clipState, LIMITER_SETTINGS } = await import('../src/audio/engine.js');
  assert.equal(clipState(0, 0.5, 1000).on, false); // nivel normal: apagado
  const hit = clipState(0, 0.95, 1000);
  assert.equal(hit.on, true); assert.equal(hit.until, 1500); // pico: hold 500 ms
  assert.equal(clipState(hit.until, 0.1, 1400).on, true); // dentro del hold sigue
  assert.equal(clipState(hit.until, 0.1, 1501).on, false); // despues se apaga
  assert.equal(LIMITER_SETTINGS.threshold, -3);
  assert.ok(LIMITER_SETTINGS.ratio >= 20 && LIMITER_SETTINGS.attack <= 0.001);
  // Curva de techo: lineal en la zona normal y nunca por encima de -3 dB.
  const { makeCeilingCurve } = await import('../src/audio/engine.js');
  const curve = makeCeilingCurve(1025);
  assert.ok(Math.abs(curve[512]) < 1e-9); // centro en 0
  assert.ok(Math.abs(curve[768] - 0.5) < 0.002); // zona lineal (x=0,5)
  assert.ok(Math.max(...curve) <= 0.708 && Math.min(...curve) >= -0.708);
  assert.ok(curve[1024] > 0.7); // cerca del techo en la entrada maxima
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
test('identidad de manos: al cruzarse no se intercambian y al reentrar se recupera el hueco', async () => {
  const { assignHandSlots } = await import('../src/gestures/logic.js');
  const prev = [{ wrist: { x: 0.2, y: 0.5 } }, { wrist: { x: 0.8, y: 0.5 } }];
  // MediaPipe devuelve las manos en orden contrario tras el cruce.
  const crossed = assignHandSlots(prev, [{ wrist: { x: 0.79, y: 0.51 } }, { wrist: { x: 0.21, y: 0.49 } }]);
  assert.deepEqual(crossed, [1, 0]); // hueco 0 sigue a su mano, no al indice del array
  // Reentrada: una sola mano cerca del hueco 1 lo recupera; la otra queda libre.
  const back = assignHandSlots(prev, [{ wrist: { x: 0.82, y: 0.48 } }]);
  assert.deepEqual(back, [-1, 0]);
  // Mano lejana a ambos huecos: se asigna al primer hueco libre, sin robar.
  const far = assignHandSlots([{ wrist: null }, { wrist: { x: 0.8, y: 0.5 } }], [{ wrist: { x: 0.1, y: 0.9 } }]);
  assert.deepEqual(far, [0, -1]);
  // Sin detecciones: ningun hueco recibe mano.
  assert.deepEqual(assignHandSlots(prev, []), [-1, -1]);
});
test('FX a dos pinzas: preparar no toca el valor, ajustar no salta y soltar congela', async () => {
  const { FxSession, fxCanAdjust } = await import('../src/audio/fx-twohand.js');
  const fx = new FxSession();
  assert.equal(fx.state, 'idle');
  fx.openPalette(); assert.equal(fx.state, 'palette');
  fx.select('delay', 1);
  assert.equal(fx.value, 0); // seleccionar todavia no cambia el audio
  fx.prepare(0.2); assert.equal(fx.state, 'prepared'); assert.equal(fx.value, 0.2);
  fx.beginAdjust({ value: 0.2, y: 300, dist01: 0.4, feedback: 0.32 });
  assert.equal(fx.state, 'adjusting');
  assert.equal(fx.adjust({ y: 300, dist01: 0.4 }).value, 0.2); // sin movimiento: sin salto
  const up = fx.adjust({ y: 170, dist01: 0.4 }); // subir la mano izquierda 130 px (medio recorrido)
  assert.ok(Math.abs(up.value - 0.6) < 1e-9, `cantidad a mitad de rango: ${up.value}`);
  const wide = fx.adjust({ y: 170, dist01: 1 }); // separar manos: realimentacion con techo 0,5
  assert.equal(wide.feedback, 0.5);
  assert.equal(fx.notePresence({ bothPresent: true, bothPinched: false }, 1000), 'frozen'); // soltar congela
  assert.equal(fx.state, 'frozen'); assert.equal(fx.value, up.value); // valor conservado
  fx.beginAdjust({ value: fx.value, y: 100, dist01: 0.5, feedback: 0.5 });
  assert.equal(fx.notePresence({ bothPresent: false, bothPinched: false }, 2000), null); // perder mano <300 ms no congela aun
  assert.equal(fx.notePresence({ bothPresent: false, bothPinched: false }, 2400), 'frozen');
  fx.unprepare(); assert.equal(fx.state, 'idle');
  // Arbitro: la mesa, la transicion y Auto DJ mandan sobre el ajuste FX.
  assert.equal(fxCanAdjust({ anyGrabbed: false, twoHandBusy: false, autoTransition: false }), true);
  assert.equal(fxCanAdjust({ anyGrabbed: true, twoHandBusy: false, autoTransition: false }), false);
  assert.equal(fxCanAdjust({ anyGrabbed: false, twoHandBusy: true, autoTransition: false }), false);
  assert.equal(fxCanAdjust({ anyGrabbed: false, twoHandBusy: false, autoTransition: true }), false);
  // Filtro: un solo parametro, rango bipolar acotado.
  const f2 = new FxSession(); f2.openPalette(); f2.select('filter', 0); f2.prepare(0);
  f2.beginAdjust({ value: 0, y: 200, dist01: 0.3, feedback: 0.32 });
  assert.equal(f2.adjust({ y: -999, dist01: 0.9 }).value, 50); // tope, y sin segundo parametro
  assert.equal(f2.adjust({ y: -999, dist01: 0.9 }).feedback, undefined);
});
test('onda ampliada: ventana centrada y pegada a bordes; reten de tempo en 0', async () => {
  const { zoomWindow, tempoDetent } = await import('../src/gestures/logic.js');
  assert.deepEqual(zoomWindow(100, 240, 8), { start: 96, end: 104, frac: 0.5 });
  assert.deepEqual(zoomWindow(1, 240, 8), { start: 0, end: 8, frac: 0.125 });
  assert.deepEqual(zoomWindow(239, 240, 16), { start: 224, end: 240, frac: 0.9375 });
  assert.deepEqual(zoomWindow(3, 5, 8), { start: 0, end: 5, frac: 0.6 }); // pista mas corta que la ventana
  assert.equal(tempoDetent(0.29), 0); assert.equal(tempoDetent(-0.3), 0); assert.equal(tempoDetent(0.31), 0.31);
});
test('filtro bipolar: centro neutro, un lado pasa-bajos y el otro pasa-altos', async () => {
  const { filterFreqs } = await import('../src/audio/engine.js');
  assert.deepEqual(filterFreqs(0), { lp: 18000, hp: 10 });
  const lp = filterFreqs(-50); assert.equal(Math.round(lp.lp), 400); assert.equal(lp.hp, 10);
  const hp = filterFreqs(50); assert.equal(hp.lp, 18000); assert.equal(Math.round(hp.hp), 4000);
  assert.ok(filterFreqs(-25).lp < 18000 && filterFreqs(-25).lp > 400);
  assert.ok(filterFreqs(25).hp > 10 && filterFreqs(25).hp < 4000);
});
test('suavizado reduce saltos y fader mapea bordes', () => {
  const s = new Smoother(0.5); s.update(0);
  assert.equal(s.update(100), 50);
  assert.equal(faderValue({ rect: { x: 0, y: 0, w: 100, h: 10 }, orientation: 'h' }, 0, 0), 0);
  assert.equal(faderValue({ rect: { x: 0, y: 0, w: 100, h: 10 }, orientation: 'h' }, 100, 0), 1);
});
