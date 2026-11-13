// Hand tracking with MediaPipe Tasks (runs fully in the browser).
// The library is loaded from a CDN. The hand model is loaded from
// vendor/hand_landmarker.task if you put it there, otherwise from Google's server.

const VERSION = "0.10.21"; // keep in line with the version tested
const LIB = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11],
  [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

async function modelPath() {
  try {
    const r = await fetch("vendor/hand_landmarker.task", { method: "HEAD" });
    if (r.ok) return "vendor/hand_landmarker.task";
  } catch (_) { /* fall through to the online copy */ }
  return MODEL_URL;
}

export async function createTracker() {
  const { FilesetResolver, HandLandmarker } = await import(`${LIB}/vision_bundle.mjs`);
  const fileset = await FilesetResolver.forVisionTasks(`${LIB}/wasm`);
  const modelAssetPath = await modelPath();

  const options = (delegate) => ({
    baseOptions: { modelAssetPath, delegate },
    runningMode: "VIDEO",
    numHands: 1,
    minHandDetectionConfidence: 0.6,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });

  let landmarker;
  try {
    landmarker = await HandLandmarker.createFromOptions(fileset, options("GPU"));
  } catch (_) {
    landmarker = await HandLandmarker.createFromOptions(fileset, options("CPU")); // phones/laptops without WebGL
  }

  return {
    /** Returns the 21 landmarks of one hand, or null. `source` is a canvas/video element. */
    detect(source, timestampMs) {
      const result = landmarker.detectForVideo(source, timestampMs);
      return result.landmarks && result.landmarks.length ? result.landmarks[0] : null;
    },
  };
}
