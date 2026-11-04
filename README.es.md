# MotionDJ

[English](README.md) · **Español**

Controladora DJ web de 2 decks que se maneja con las manos frente a la webcam (o con mouse, teclado y táctil). Pensada para que alguien sin experiencia mezcle dos canciones en minutos, y con profundidad para quien ya pincha: rejilla de golpes estimada, SYNC con alineación de fase, búsqueda con el jog oyendo la pista en ambos sentidos y efectos a dos pinzas.

Identidad visual propia (cian A / magenta B sobre cabina oscura). Sin marcas ni diseños de terceros.

## Ejecutarlo en 3 pasos

Requisitos: Node.js 20+ y Chrome o Edge (Web Audio + `getUserMedia`). **No necesita internet**: el modelo de manos y su WASM van dentro del proyecto.

```powershell
npm install
npm run dev
```

Abre http://127.0.0.1:5173, pulsa **Activar audio**, **Cargar demos** (dos pistas generadas por la propia app, sin música con derechos) e **importa tu música** o elige tu carpeta: tus archivos se procesan en tu navegador y no se suben a ningún servidor.

Para producción estática: `npm run build` genera `dist/` (sirve igual en Vercel/Netlify o cualquier hosting de archivos; la cámara exige HTTPS o localhost).

## Qué hace (solo lo real)

- **Dos decks** con PLAY/CUE/SYNC, tempo ±8 % con retén en 0, loop de 4 tiempos, onda completa y onda ampliada (4/8/16 s) para ver la rejilla sobre los bombos.
- **Mezclador**: EQ −26…+6 dB, TRIM, FILTRO de un mando (quita agudos a un lado, graves al otro), ECO por canal que sigue solo al BPM, volúmenes, crossfader, MASTER, limitador con techo medido y aviso de saturación y de «dos graves».
- **Jog útil de verdad**: el centro busca el punto de entrada **con audio hacia delante y hacia atrás** (AudioWorklet propio); el borde empuja el tempo unos % y vuelve solo a su sitio.
- **Pads fijos**: 2 hot cues, 2 saltos de 4 tiempos, 2 efectos y 2 sonidos. Sin cambiar de modo.
- **Selector PISTAS** a pantalla completa: elige la siguiente pista con los dedos mientras la otra suena, con tu orden guardado y confirmación mantenida si el deck está sonando.
- **Gestos**: pinza para tomar cualquier control (sin saltos), dos pinzas para transición suave o expresiva y para ajustar Filtro/Eco, identidad de manos estable al cruzarse, encuadre RECORTE/COMPLETO con el puntero siguiendo a tu dedo.
- **Auto DJ** básico A↔B, transición suave, grabación de la mezcla a `.webm`, Vista fácil sin jerga y «Igualar y mezclar» en un botón.
- **Preescucha en auriculares (experimental)**: bus separado con elección de salida (`setSinkId`) para oír el deck que no suena; no entra en la grabación.

## Mapa de gestos

| Gesto | Qué hace |
|---|---|
| Pinza sobre un control | Lo toma: faders y perillas con arrastre relativo, sin saltos |
| Pinza sobre el jog (centro/borde) | Buscar con audio / empujar el tempo |
| Pinza en cada mano, mantener y soltar | Prepara la transición a dos manos |
| Pinza en cada mano en el aire (FX preparado) | Ajusta Filtro o Eco; soltar congela |
| Pinza corta sobre PISTAS o un recuadro | Abre el selector / carga la pista |
| Tecla `G` | Pausa los gestos sin parar la música |

## Qué es estimado o limitado (honestidad)

- El **BPM es estimado** por análisis propio (medido: demos 122/124 exactos; en las pistas del autor, 154,1 / 152,0 / ~132). SYNC iguala el BPM efectivo y alinea la fase con esa rejilla; no es un beatmatching infalible.
- El tempo cambia también el tono (no hay time-stretch).
- La webcam estima manos en 2D: sin profundidad ni contacto real. La garra de cinco dedos sigue experimental y apagada por defecto.
- Los stems (VOZ, BATERÍA, BAJO, RESTO) necesitan el servidor local de Meta Demucs (`stems-server/`); sin él, la app funciona igual con la pista entera. Sin detección de tonalidad ni micrófono. La preescucha es experimental hasta validarla con dos salidas reales.

## Pruebas

```powershell
npm test
npm run build
```

37 pruebas de lógica pura (rejilla, SYNC, eco, scrub, selector, máquina FX…) y verificación en navegador sin cámara. Lo que solo se valida con webcam y oídos está listado en `docs/pruebas.md`.

## Créditos y licencias

MediaPipe Hand Landmarker y su WASM (Apache-2.0, Google) van empaquetados en `public/mediapipe/`. Vite (MIT) solo compila. El resto es código y síntesis propios; detalle en `docs/licencias.md`. Historia y estado: `docs/estado.md`. Texto de entrega y guion de demo: `docs/entrega.md`.
