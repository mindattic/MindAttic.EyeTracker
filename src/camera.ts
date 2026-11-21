import { WebcamCore } from './webcam.js';
import { DEFAULT_CAMERA, type CameraOptions } from './cameraOptions.js';
import type { LandmarkFrame } from './types.js';

export * from './cameraOptions.js';

type FrameHandler = (frame: LandmarkFrame | null, t: number) => void;

/**
 * Landmarks for one face, from a WebcamCore: the single-face view the eye tracker uses. Give it a
 * `core` to share the camera and the face model with other modules; without one it makes its own.
 */
export class CameraLandmarkSource {
  readonly options: CameraOptions;
  readonly core: WebcamCore;
  private readonly ownsCore: boolean;
  private unsubscribe: (() => void) | null = null;
  private held = false;

  constructor(options: Partial<CameraOptions> = {}, core?: WebcamCore) {
    this.options = { ...DEFAULT_CAMERA, ...options };
    this.ownsCore = !core;
    this.core = core ?? new WebcamCore(this.options);
  }

  get video(): HTMLVideoElement | null {
    return this.core.video;
  }

  async start(onFrame: FrameHandler): Promise<void> {
    if (this.held) return;
    this.unsubscribe = this.core.subscribe((f) => onFrame(f.faces[0] ?? null, f.t));
    try {
      await this.core.retain();
      this.held = true;
    } catch (err) {
      this.unsubscribe();
      this.unsubscribe = null;
      throw err;
    }
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.held) {
      this.held = false;
      if (this.ownsCore) this.core.stop();
      else this.core.release();
    }
  }

  /** The cameras the browser knows about. Labels are empty until camera permission is granted. */
  static listCameras(): Promise<MediaDeviceInfo[]> {
    return WebcamCore.listCameras();
  }
}
