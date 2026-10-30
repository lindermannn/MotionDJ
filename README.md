# MotionDJ

Controladora DJ web de 2 decks controlada por gestos de las manos con la webcam, con alternativa completa de mouse, teclado y táctil. Identidad visual propia (cian/magenta sobre vídeo espejo), inspirada en la distribución general de controladoras de 2 canales. No usa marcas ni diseños de terceros.

## Requisitos e instalación

- Node.js 20+ y un navegador moderno (Chrome/Edge recomendados) con Web Audio y `getUserMedia`.
- Internet solo la primera vez: se descargan el modelo y el WASM de MediaPipe Hand Landmarker desde CDN. Después, la detección es local.

```powershell
cd MotionDJ
npm install --cache .npm-cache
npm run dev
```

Abre http://127.0.0.1:5173 en tu navegador.

## Uso rápido

1. Pulsa **Activar audio** (el navegador exige un gesto del usuario).
2. Pulsa **Cargar demos** (2 pistas sintetizadas de 16 s, 122/124 BPM) o **Importar música** con tus archivos.
3. Selecciona una pista y pulsa **LOAD A** / **LOAD B**. Cargar no reproduce automáticamente y no reemplaza un deck sonando sin confirmación.
4. Pulsa **Activar cámara**, permite el acceso y pulsa **Gestos: ON**.
5. Haz pinza (pulgar+índice) sobre el crossfader, un fader, un knob o un botón y muévete manteniendo la pinza. Suelta para liberar.
6. Calibra escala/posición/tamaño, bloquea la mesa y usa **Diagnóstico** para ver landmarks, ratio de pinza y control enfocado/tomado.

## Qué funciona (real, no solo visual)

- Dos decks independientes: play/pause, CUE principal, clic o arrastre fino (con imán a golpe) en la forma de onda, tempo ±8 % (cambia también el tono), loop de 4 pulsos, medidores y tiempos.
- Biblioteca local con búsqueda, LOAD A/B, indicadores de deck y cola (+ cola / «Siguiente ▶» al deck libre); los archivos se procesan en el navegador y no persisten tras recargar.
- Mixer real (Web Audio): trim, EQ de 3 bandas, filtro, volumen por canal, crossfader equal-power, master con compresor, limitador con aviso SATURACIÓN/LIMITADOR y curva de techo, delay y reverb por envíos. Las 10 perillas (EQ/Trim/Filtro) se arrastran con mouse, táctil o pinza con barra de valor.
- 8 pads por deck con modos HOT CUE (borrables con Mayús+clic, clic derecho o modo borrar), SAMPLER (sonidos sintetizados), PAD FX y BEAT JUMP. Jog wheel con scratch por velocidad (sin reverse real) con ratón, táctil o pinza+mover.
- BPM estimado por autocorrelación de energía (orientativo), SYNC que iguala tempo con el BPM efectivo y alinea la fase con la rejilla estimada, eco del mezclador sincronizable al BPM (¼/½/1) y espectro del master ocultable.
- Transición asistida de 8 s (crossfader + graves), cancelable y con vuelta manual sin saltos.
- Grabación de la mezcla a `.webm` mediante `MediaRecorder`.
- Gestos: 2 manos independientes, pinza normalizada por tamaño de mano con histéresis, suavizado, liberación al perder la mano y bloqueo de gestos. La webcam no detecta contacto físico ni profundidad precisa: es estimación 2D en modo espejo.

## Privacidad y permisos

- Cámara y audio se procesan localmente; ningún fotograma ni movimiento se envía a un servidor.
- Permisos: cámara (solo al activarla) y reproducción de audio tras tu clic.
- Preescucha independiente por auriculares: no disponible (ver `docs/estado.md`).

## Pruebas

```powershell
npm test
npm run build
```

Ver `docs/pruebas.md` para resultados y lo que falta probar con webcam real y altavoces.

## Limitaciones conocidas

- Sin validación física con webcam en esta entrega (pendiente contigo).
- BPM/Sync orientativos; el tempo altera el tono; sin scratch ni preescucha.
- La biblioteca no persiste tras recargar la página.
