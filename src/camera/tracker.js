// MediaPipe Hand Landmarker (local en navegador, modelo descargado de CDN una vez).
// MediaPipe empaquetado en el proyecto (public/mediapipe): la demo funciona
// sin internet. El CDN solo queda como respaldo si falta el archivo local.
const LOCAL_WASM = '/mediapipe/wasm';
const LOCAL_MODEL = '/mediapipe/model/hand_landmarker.task';
const CDN_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const CDN_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
export async function createHandTracker(video, onError) {
  try {
    const vision = await import('@mediapipe/tasks-vision');
    let fileset, model = LOCAL_MODEL;
    try {
      fileset = await vision.FilesetResolver.forVisionTasks(LOCAL_WASM);
      const head = await fetch(LOCAL_MODEL, { method: 'HEAD' });
      if (!head.ok) model = CDN_MODEL;
    } catch { fileset = await vision.FilesetResolver.forVisionTasks(CDN_WASM); model = CDN_MODEL; }
    const landmarker = await vision.HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: model, delegate: 'GPU' },
      runningMode: 'VIDEO', numHands: 2,
      minHandDetectionConfidence: 0.5, minTrackingConfidence: 0.5
    });
    let lastTs = -1;
    return {
      detect() {
        if (video.currentTime === lastTs || video.readyState < 2) return null;
        lastTs = video.currentTime;
        try { return landmarker.detectForVideo(video, performance.now()); }
        catch { return null; }
      },
      close() { try { landmarker.close(); } catch {} }
    };
  } catch (e) { onError?.(e); return null; }
}
// deviceId opcional: sin él, la cámara predeterminada del navegador.
// Se pide 1920×1080 como ideal; MediaPipe reduce la imagen por dentro.
export async function startCamera(video, deviceId) {
  const size = { width: { ideal: 1920 }, height: { ideal: 1080 } };
  const stream = await navigator.mediaDevices.getUserMedia({
    video: deviceId ? { deviceId: { exact: deviceId }, ...size } : { ...size, facingMode: 'user' }, audio: false
  });
  video.srcObject?.getTracks?.().forEach(t => t.stop());
  video.srcObject = stream;
  await video.play();
  return stream;
}
