import type { FaceLandmarker } from '@mediapipe/tasks-vision';
import type { LandmarkFrame } from './types.js';

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
}

export const DEFAULT_CAMERA: CameraOptions = {
  facingMode: 'user',
  width: 1280,
  height: 720,
  frameRate: 30,
  wasmBaseUrl: DEFAULT_WASM_URL,
  modelUrl: DEFAULT_MODEL_URL,
  delegate: 'GPU',
};

type FrameHandler = (frame: LandmarkFrame | null, t: number) => void;

/** Opens the camera and runs MediaPipe Face Landmarker on every new video frame. Browser only. */
export class CameraLandmarkSource {
  readonly options: CameraOptions;
  video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  private landmarker: FaceLandmarker | null = null;
  private ownsVideo = false;
  private running = false;
  private lastVideoTime = -1;
  private ticker: Worker | null = null;

  constructor(options: Partial<CameraOptions> = {}) {
    this.options = { ...DEFAULT_CAMERA, ...options };
  }

  async start(onFrame: FrameHandler): Promise<void> {
    if (this.running) return;
    const o = this.options;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This page cannot use the camera. Open it over https:// or on localhost.');
    }
    // Ask for the camera first: if the user refuses there is no point downloading the model.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        ...(o.deviceId ? { deviceId: { exact: o.deviceId } } : { facingMode: o.facingMode }),
        width: { ideal: o.width },
        height: { ideal: o.height },
        frameRate: { ideal: o.frameRate },
      },
    });

    let video = o.video ?? null;
    if (!video) {
      video = document.createElement('video');
      // Kept in the page (some mobile browsers pause a detached video) but out of sight.
      video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:0;top:0';
      document.body.appendChild(video);
      this.ownsVideo = true;
    }
    video.playsInline = true;
    video.muted = true;
    video.srcObject = this.stream;
    this.video = video;
    await video.play();

    const vision = await import('@mediapipe/tasks-vision');
    const fileset = await vision.FilesetResolver.forVisionTasks(o.wasmBaseUrl);
    const create = (delegate: 'GPU' | 'CPU') =>
      vision.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: o.modelUrl, delegate },
        runningMode: 'VIDEO',
        numFaces: 1,
        // The position and direction of the head in camera space: what lets the gaze model allow
        // for where the camera is and for head movement.
        outputFacialTransformationMatrixes: true,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    try {
      this.landmarker = await create(o.delegate);
    } catch (err) {
      if (o.delegate !== 'GPU') throw err;
      this.landmarker = await create('CPU');
    }

    this.running = true;
    const process = () => {
      if (!this.running || !this.video || !this.landmarker) return;
      const v = this.video;
      if (v.readyState < 2 || v.videoWidth === 0 || v.currentTime === this.lastVideoTime) return;
      this.lastVideoTime = v.currentTime;
      const t = performance.now();
      let frame: LandmarkFrame | null = null;
      try {
        const result = this.landmarker.detectForVideo(v, t);
        const face = result.faceLandmarks?.[0];
        if (face) {
          frame = {
            landmarks: face,
            aspect: v.videoWidth / v.videoHeight,
            matrix: result.facialTransformationMatrixes?.[0]?.data ?? null,
            t,
          };
        }
      } catch {
        // A dropped frame is not worth stopping for; the next one will be tried.
      }
      onFrame(frame, t);
    };
    const loop = () => {
      if (!this.running) return;
      process();
      const v = this.video as (HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }) | null;
      if (v?.requestVideoFrameCallback) v.requestVideoFrameCallback(loop);
      else requestAnimationFrame(loop);
    };
    loop();

    // A page that is hidden (the game is in front of the tracker window) gets no animation or
    // video frame callbacks, and its own timers are slowed to one a second. A worker's timer is
    // not, so while hidden the worker keeps the frames coming.
    try {
      const code = 'setInterval(() => postMessage(0), 33);';
      this.ticker = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
      this.ticker.onmessage = () => {
        if (document.hidden) process();
      };
    } catch {
      // No worker: tracking simply pauses while the page is hidden.
    }
  }

  stop(): void {
    this.running = false;
    this.ticker?.terminate();
    this.ticker = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.landmarker?.close();
    this.landmarker = null;
    if (this.video) {
      this.video.srcObject = null;
      if (this.ownsVideo) this.video.remove();
    }
    this.video = null;
    this.ownsVideo = false;
  }

  /** The cameras the browser knows about. Labels are empty until camera permission is granted. */
  static async listCameras(): Promise<MediaDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput');
  }
}
