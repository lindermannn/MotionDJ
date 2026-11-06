# MotionDJ

[English](README.md) · **Español**

> **Tus manos son la controladora.** Consola DJ web de 2 decks que se toca con gestos frente a la webcam, con stems gracias a **Meta Demucs v4**.

Hecha durante el **Meta Global AI Developer Hackathon**.

▶️ **[Ver el video demo (3 min)](https://www.youtube.com/watch?v=BUWUfgjU3jU)**

[![Video demo de MotionDJ](https://img.youtube.com/vi/BUWUfgjU3jU/maxresdefault.jpg)](https://www.youtube.com/watch?v=BUWUfgjU3jU)

📖 **[Guía de uso completa](docs/GUIA.md)**, para principiantes y para DJs con experiencia. También está dentro de la app, en **? Ayuda → Guía de uso**.

## El problema

Ser DJ tiene una barrera de entrada alta:

- **Equipo caro.** Una controladora básica usada cuesta desde 170 mil pesos y una profesional supera el millón.
- **Programas complejos y en jerga.** Cue, sync, EQ, cuantizar… asusta a quien empieza.
- **Lo más llamativo es de pago.** Los stems y los efectos sobre una sola parte vienen en licencias o suscripciones.

Por eso la mayoría nunca prueba mezclar. En una fiesta, la música se queda en una lista que suena sola.

## Visión

**Cualquier persona puede ser DJ.** Sin comprar equipo, sin instalar nada y sin saber de música: abres la app, levantas las manos y mezclas. Entre una persona y su primera mezcla solo debería estar la música que le gusta.

## La solución

MotionDJ convierte un computador con webcam en una cabina de DJ. Las manos reemplazan la consola, y cada gesto es una metáfora física que se entiende sin explicación:

| Gesto | Qué pasa |
|---|---|
| ✋ Palma de «alto» | La canción **frena** como un vinilo |
| ☝️✌️🤟 Contar dedos | **Repite** el golpe: más dedos, más rápido |
| ✊ Puño y 👍 pulgar arriba | **Agarras** la canción y la **lanzas** al otro deck con eco |
| 🙌 Subir las dos manos y 🙏 juntarlas | **Sube la tensión** y suelta el **drop** |
| 🤏 Estirar con las dos manos | Abre y cierra el **filtro** como una cuerda |
| 🤏 Pellizcar una parte | Apaga o enciende la **voz, la batería o el bajo** |

## Por qué es entretenida

- **Se aprende en segundos.** Los gestos se parecen a lo que hacen: frenar es decir «alto», lanzar es lanzar.
- **Suena bien aunque no sepas.** Todo cae en el golpe o en el compás, así que un gesto tarde no rompe la mezcla.
- **Es un espectáculo.** Mezclar con las manos en el aire se ve increíble en una fiesta o en un video.
- **Ayudas para empezar:** Vista fácil, Auto DJ, «Igualar y mezclar» en un botón y pistas demo para probar sin música propia.

## Por qué es profesional a la vez

- **Stems con IA de Meta.** Meta Demucs v4 separa cada canción en voz, batería, bajo y resto. Cada efecto puede ir sobre una sola parte: repetir solo la batería o lanzar solo la voz.
- **Rejilla de golpes y SYNC con fase.** Los efectos se cuantizan al golpe y al compás.
- **Consola completa:** jog que busca con audio hacia adelante y hacia atrás, EQ, filtro, limitador, avisos de saturación y de «dos graves», hot cues y loops.
- **Preescucha en audífonos** con salida separada, como en una cabina real.
- **Grabación de la mezcla** para compartirla.

## Detalles pensados para DJs

**En el Modo manos**

- **El filtro de cuerda mueve la perilla que elijas.** Puedes pasar de FILTRO a **HIGH, MID, LOW, TRIM o ECO**: separas las pinzas y sube esa perilla, las juntas y baja. Quitas graves o agudos con las manos, como en una mezcla real.
- **Cada efecto apunta a una parte de la canción** (con stems): **ROLL** solo en la batería mientras la voz sigue limpia; **ECO** sobre la voz por defecto, para lanzar el «acapella» con eco; **FRENO** sobre toda la música menos la voz (**MÚSICA**) o sobre una sola parte.
- **El ECO lanzado hace la transición completa.** Al levantar el pulgar, el deck actual se corta en el golpe y el otro entra **en ese mismo golpe, con el tempo igualado**. Un segundo puño controla cuánto dura la cola de eco. Puedes lanzar de A a B y de vuelta a A sin sacar las manos.
- **La pista sigue avanzando por debajo de los efectos.** Al soltar el ROLL o el FRENO, la canción vuelve **en el golpe y en el punto donde estaría**, sin perder la frase (*slip*).
- **El DROP espera el siguiente compás.** Aunque juntes las manos tarde, entra en el compás.

**En la consola**

- **La pinza toma los controles sin saltos.** El fader o la perilla se mueve desde donde está, no salta a tu mano.
- **Lineup por deck.** Preparas las colas de A y de B con **+A / +B**. Cuando un deck queda libre se carga solo su siguiente tema, sin pisar uno preparado.
- **Aviso de «dos graves»** si los dos decks suenan con el bajo arriba, el error típico de quien empieza.
- **Limitador con techo medido y aviso de saturación**, para que la mezcla no se distorsione.
- **SYNC con fase** sobre la rejilla de golpes, y jog que busca **con audio hacia adelante y hacia atrás** para encontrar la entrada de oído.
- **Las manos no se confunden al cruzarse.** Cada mano conserva su identidad, así que los gestos a dos manos no se invierten.

## Ventajas

- **Gratis y de código abierto.**
- **Sin hardware:** solo un navegador y una webcam. También funciona con mouse, teclado y pantalla táctil.
- **Privada:** tu música nunca sale de tu computador. La IA (Meta Demucs, pesos abiertos) corre en tu propia GPU.
- **Funciona sin internet.**

## Para quién

- **Principiantes:** su primera mezcla en minutos.
- **Anfitriones de fiestas:** la música deja de ser una lista que suena sola.
- **Creadores de contenido:** un show visual para grabar.
- **DJs:** una forma nueva de actuar, con efectos que ninguna consola hace con gestos.

## Inicio rápido

1. Abre la app y pulsa **? Ayuda → Inicio guiado**: activa el audio, carga las demos o tu música y activa la cámara.
2. **Principiantes:** pulsa **FÁCIL**, carga una canción en A y dale PLAY, carga otra en B y pulsa **Igualar y mezclar**.
3. **Manos:** pulsa **MANOS · FX** en el deck que suena, elige un efecto con una pinza y juega. Saca las dos manos para salir.
4. **DJs:** pulsa **DJ** para la consola completa: SYNC, EQ, jog, pads, lineup y preescucha.

Todo lo demás está en la **[guía completa](docs/GUIA.md)**.

## Cómo se usa Meta Demucs

1. Al cargar una pista, la app la envía a un pequeño servidor local (`stems-server/`, `127.0.0.1:8765`).
2. El servidor ejecuta **Meta Demucs v4 (`htdemucs`)** y la separa en 4 stems (unos 13 s por canción en una RTX 3060 Ti).
3. El navegador reproduce los 4 stems sincronizados con Web Audio. Cada efecto con las manos puede ir sobre un stem.

Todo queda en tu computador: tus canciones y la caché de stems nunca se suben. Sin el servidor, MotionDJ funciona igual con la pista entera.

## Ejecutarlo

Requisitos: Node.js 20+ y Chrome o Edge (Web Audio + `getUserMedia`). **No necesita internet**: el modelo de manos y su WASM van dentro del proyecto.

```powershell
npm install
npm run dev
```

Abre http://127.0.0.1:5173, pulsa **Activar audio**, **Cargar demos** (dos pistas generadas por la propia app, sin música con derechos) o importa tu música: tus archivos se procesan en tu navegador y no se suben a ningún servidor.

### Opcional: servidor de stems (Meta Demucs)

Requiere Python 3.10+, [Demucs](https://github.com/facebookresearch/demucs) 4.x y PyTorch (se recomienda GPU con CUDA; en CPU funciona, pero lento).

```powershell
python -m venv venv
.\venv\Scripts\pip install demucs torch torchaudio
.\venv\Scripts\python stems-server\server.py --cache .\stems-cache
```

Opciones: `--host`, `--port`, `--cache`, `--device` (`cuda` o `cpu`). `stems-server/start.ps1` es el lanzador del autor con sus rutas locales. Detalle de la API en [stems-server/README.md](stems-server/README.md).

Para producción estática: `npm run build` genera `dist/` (sirve en Vercel, Netlify o cualquier hosting de archivos; la cámara exige HTTPS o localhost).

## Qué es estimado o limitado

- El **BPM es estimado** por análisis propio. SYNC iguala el BPM efectivo y alinea la fase con esa rejilla; no es un beatmatching infalible.
- El tempo cambia también el tono (no hay time-stretch).
- La webcam estima las manos en 2D: sin profundidad ni contacto real.
- Sin detección de tonalidad ni micrófono.

## Pruebas

```powershell
npm test
npm run build
```

Pruebas de lógica pura (rejilla, SYNC, eco, scrub, gestos, roll, freno, subida, colas…) y verificación en navegador sin cámara. Los gestos y el sonido se validaron a mano con webcam y música reales.

## Tecnologías

- **Meta Demucs v4** (`htdemucs`, MIT): separación de stems local en GPU
- **MediaPipe Hand Landmarker** (Apache-2.0, Google): 21 puntos por mano, empaquetado en `public/mediapipe/`
- **Web Audio API** + AudioWorklet: toda la mezcla, los efectos y el scrub en el navegador
- **Vite** (MIT): solo compila; la app es JavaScript sin framework

El resto es código y síntesis propios; detalle en `docs/licencias.md`. Guía de uso: `docs/GUIA.md`.
