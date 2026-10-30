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
export async function startCamera(video) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: false
  });
  video.srcObject = stream;
  await video.play();
  return stream;
}
