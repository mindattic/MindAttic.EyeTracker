import type { FaceLandmarker } from '@mediapipe/tasks-vision';
import { DEFAULT_CAMERA, type CameraOptions } from './cameraOptions.js';
import type { LandmarkFrame, WebcamFrame } from './types.js';

export type { WebcamFrame } from './types.js';

export type WebcamFrameHandler = (frame: WebcamFrame) => void;
export type CameraPermission = 'granted' | 'denied' | 'prompt' | 'unknown';

/**
 * The webcam core: device selection, permission, the frame loop and ONE shared MediaPipe
 * FaceLandmarker. Modules (eye tracking, presence, head pose, integrity) subscribe to it and get
 * landmarks; none of them opens a camera or loads a model of its own, and none ever sees pixels.
 *
 *   const core = new WebcamCore({ numFaces: 2 });
 *   const stop = core.subscribe((f) => console.log(f.faces.length));
 *   await core.retain();      // starts the camera on the first retain
 *   ...
 *   core.release();           // stops it when the last holder lets go
 *
 * Browser only.
 */
export class WebcamCore {
  readonly options: CameraOptions;
  video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  private landmarker: FaceLandmarker | null = null;
  private ownsVideo = false;
  private running = false;
  private starting: Promise<void> | null = null;
  private holders = 0;
  private lastVideoTime = -1;
  private ticker: Worker | null = null;
  private readonly handlers = new Set<WebcamFrameHandler>();
  private lumaCanvas: HTMLCanvasElement | null = null;
  private lumaAt = 0;
  private luma: number | undefined;

  constructor(options: Partial<CameraOptions> = {}) {
    this.options = { ...DEFAULT_CAMERA, ...options };
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Receive every frame. Returns the function that unsubscribes. Does not start the camera. */
  subscribe(handler: WebcamFrameHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Start the camera if it is not running and count one more user of it. */
  async retain(): Promise<void> {
    this.holders++;
    try {
      await this.start();
    } catch (err) {
      this.holders = Math.max(0, this.holders - 1);
      throw err;
    }
  }

  /** Let go; the camera stops when the last holder does. */
  release(): void {
    this.holders = Math.max(0, this.holders - 1);
    if (this.holders === 0) this.stop();
  }

  /** The cameras the browser knows about. Labels are empty until camera permission is granted. */
  static async listCameras(): Promise<MediaDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput');
  }

  /** Whether the page may use the camera, without prompting. "unknown" where the browser cannot say. */
  static async permission(): Promise<CameraPermission> {
    try {
      const status = await navigator.permissions.query({ name: 'camera' as PermissionName });
      return status.state as CameraPermission;
    } catch {
      return 'unknown';
    }
  }

  /** Switch to another camera; restarts the stream if the core is running. */
  async selectDevice(deviceId: string | undefined): Promise<void> {
    this.options.deviceId = deviceId;
    if (!this.running) return;
    const was = this.holders;
    this.stop();
    this.holders = was;
    await this.start();
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (this.starting) return this.starting;
    this.starting = this.open().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async open(): Promise<void> {
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
        numFaces: Math.max(1, o.numFaces),
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
    const loop = () => {
      if (!this.running) return;
      this.process();
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
        if (document.hidden) this.process();
      };
    } catch {
      // No worker: tracking simply pauses while the page is hidden.
    }
  }

  private process(): void {
    if (!this.running || !this.video || !this.landmarker) return;
    const v = this.video;
    if (v.readyState < 2 || v.videoWidth === 0 || v.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = v.currentTime;
    const t = performance.now();
    const faces: LandmarkFrame[] = [];
    try {
      const result = this.landmarker.detectForVideo(v, t);
      const aspect = v.videoWidth / v.videoHeight;
      (result.faceLandmarks ?? []).forEach((landmarks, i) => {
        faces.push({ landmarks, aspect, matrix: result.facialTransformationMatrixes?.[i]?.data ?? null, t });
      });
    } catch {
      // A dropped frame is not worth stopping for; the next one will be tried.
    }
    const frame: WebcamFrame = { t, faces };
    if (this.options.measureLight) {
      if (t - this.lumaAt >= 500) {
        this.lumaAt = t;
        this.luma = this.measureLuma(v);
      }
      if (this.luma !== undefined) frame.luma = this.luma;
    }
    for (const h of [...this.handlers]) h(frame);
  }

  /** Mean brightness of a tiny thumbnail. The thumbnail is read and dropped here; it goes nowhere. */
  private measureLuma(v: HTMLVideoElement): number | undefined {
    try {
      const c = (this.lumaCanvas ??= Object.assign(document.createElement('canvas'), { width: 16, height: 9 }));
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) return undefined;
      ctx.drawImage(v, 0, 0, 16, 9);
      const d = ctx.getImageData(0, 0, 16, 9).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      return sum / (d.length / 4);
    } catch {
      return undefined;
    }
  }

  stop(): void {
    this.running = false;
    this.holders = 0;
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
    this.lastVideoTime = -1;
    this.luma = undefined;
  }
}
