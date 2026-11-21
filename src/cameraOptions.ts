/** The MediaPipe build these URLs must match (package.json pins the same version). */
export const MEDIAPIPE_VERSION = '1.2.3';
export const DEFAULT_WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
export const DEFAULT_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

export interface CameraOptions {
  /** A specific camera. Omit to use `facingMode`. */
  deviceId?: string;
  /** "user" is the front camera, which is what faces the person looking at the screen. */
  facingMode: 'user' | 'environment';
  /** Requested capture size. More pixels on the iris means a steadier estimate. */
  width: number;
  height: number;
  frameRate: number;
  /** Folder holding MediaPipe's wasm files. Point it at your own server to run without the CDN. */
  wasmBaseUrl: string;
  /** The face_landmarker.task model file. */
  modelUrl: string;
  delegate: 'GPU' | 'CPU';
  /** Use this video element instead of creating a hidden one (for a camera preview). */
  video?: HTMLVideoElement;
  /** How many faces the shared landmarker looks for. The presence module needs 2 to see a second person. */
  numFaces: number;
  /**
   * Measure the average brightness of the image (a 16x9 thumbnail, on the device, about twice a
   * second) so the presence module can warn about poor lighting. No pixels leave the device.
   */
  measureLight: boolean;
}

export const DEFAULT_CAMERA: CameraOptions = {
  facingMode: 'user',
  width: 1280,
  height: 720,
  frameRate: 30,
  wasmBaseUrl: DEFAULT_WASM_URL,
  modelUrl: DEFAULT_MODEL_URL,
  delegate: 'GPU',
  numFaces: 1,
  measureLight: false,
};
