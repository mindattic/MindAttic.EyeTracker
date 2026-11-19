import { CalibrationSession } from './calibration.js';
import { CameraLandmarkSource, type CameraOptions } from './camera.js';
import { Emitter } from './emitter.js';
import type { FaceFeatures } from './features.js';
import { isValidModel, type GazeModel } from './model.js';
import { DEFAULT_PIPELINE, GazePipeline, type PipelineOptions } from './pipeline.js';
import type { CalibrationResult, GazeSample, GazeSource, LandmarkFrame } from './types.js';

export interface TrackerStatus {
  state: 'idle' | 'starting' | 'running' | 'error';
  /** Camera frames processed per second. */
  fps: number;
  /** A face was found in the latest frame. */
  face: boolean;
  calibrated: boolean;
  error?: string;
}

export interface EyeTrackerOptions {
  camera?: Partial<CameraOptions>;
  pipeline?: Partial<PipelineOptions>;
  /**
   * Where the calibration is kept in localStorage, so a returning user is not asked to calibrate
   * again. Use one key per screen-and-camera arrangement. Null turns storage off.
   */
  storageKey?: string | null;
}

export interface TrackerEvents extends Record<string, unknown> {
  gaze: GazeSample;
  /** Every processed frame, with the landmarks and features behind it (for previews and debugging). */
  frame: { frame: LandmarkFrame | null; features: FaceFeatures | null };
  status: TrackerStatus;
}

const STORAGE_PREFIX = 'mindattic.eyetracker.model.';

/**
 * Webcam gaze tracking in the browser: camera, MediaPipe face mesh, the gaze pipeline and
 * calibration behind one object.
 *
 *   const tracker = new EyeTracker();
 *   await tracker.start();
 *   await runCalibration(tracker);
 *   tracker.on('gaze', (g) => console.log(g.x, g.y));
 */
export class EyeTracker extends Emitter<TrackerEvents> implements GazeSource {
  readonly camera: CameraLandmarkSource;
  readonly pipeline: GazePipeline;
  latest: GazeSample | null = null;
  status: TrackerStatus = { state: 'idle', fps: 0, face: false, calibrated: false };

  private session: CalibrationSession | null = null;
  private readonly storageKey: string | null;
  private frames = 0;
  private fpsSince = 0;

  constructor(options: EyeTrackerOptions = {}) {
    super();
    this.camera = new CameraLandmarkSource(options.camera);
    this.pipeline = new GazePipeline({ ...DEFAULT_PIPELINE, ...options.pipeline });
    this.storageKey = options.storageKey === undefined ? 'default' : options.storageKey;
    this.loadCalibration();
  }

  get video(): HTMLVideoElement | null {
    return this.camera.video;
  }

  get calibrated(): boolean {
    return this.pipeline.model !== null;
  }

  /** Ask for the camera, load the face model and start emitting gaze. Rejects if either fails. */
  async start(): Promise<void> {
    if (this.status.state === 'running' || this.status.state === 'starting') return;
    this.setStatus({ state: 'starting', error: undefined });
    try {
      this.fpsSince = performance.now();
      this.frames = 0;
      await this.camera.start((frame, t) => this.onFrame(frame, t));
      this.setStatus({ state: 'running' });
    } catch (err) {
      this.camera.stop();
      this.setStatus({ state: 'error', error: describeCameraError(err) });
      throw err;
    }
  }

  stop(): void {
    this.camera.stop();
    this.pipeline.reset();
    this.setStatus({ state: 'idle', fps: 0, face: false });
  }

  private onFrame(frame: LandmarkFrame | null, t: number): void {
    const sample = this.pipeline.process(frame, t);
    if (this.session?.collecting && this.pipeline.lastVector && !this.pipeline.lastBlink) {
      this.session.add(this.pipeline.lastVector);
    }
    this.latest = sample;
    this.frames++;
    if (t - this.fpsSince >= 1000) {
      this.setStatus({ fps: Math.round((this.frames * 1000) / (t - this.fpsSince)), face: sample.face });
      this.frames = 0;
      this.fpsSince = t;
    } else if (sample.face !== this.status.face) {
      this.setStatus({ face: sample.face });
    }
    this.emit('frame', { frame, features: this.pipeline.lastFeatures });
    this.emit('gaze', sample);
  }

  private setStatus(patch: Partial<TrackerStatus>): void {
    this.status = { ...this.status, ...patch, calibrated: this.calibrated };
    this.emit('status', this.status);
  }

  // ---- calibration (GazeSource) ----

  calibBegin(): void {
    this.session = new CalibrationSession();
  }

  calibCollect(x: number, y: number, ms: number): Promise<number> {
    const session = (this.session ??= new CalibrationSession());
    session.beginTarget(x, y);
    return new Promise((resolve) => setTimeout(() => resolve(session.endTarget()), ms));
  }

  async calibFinish(): Promise<CalibrationResult> {
    const session = this.session;
    this.session = null;
    if (!session) return { ok: false, reason: 'no calibration in progress', targets: 0, samples: 0, fitError: 0, crossError: 0 };
    const { model, result } = session.fit();
    if (model) this.setModel(model);
    return result;
  }

  calibClear(): void {
    this.session = null;
    this.setModel(null);
  }

  /** Install a model (for example one restored from your own storage), or null for the built-in mapping. */
  setModel(model: GazeModel | null): void {
    this.pipeline.model = model;
    this.pipeline.reset();
    this.saveCalibration();
    this.setStatus({});
  }

  private saveCalibration(): void {
    if (!this.storageKey) return;
    try {
      const key = STORAGE_PREFIX + this.storageKey;
      if (this.pipeline.model) localStorage.setItem(key, JSON.stringify(this.pipeline.model));
      else localStorage.removeItem(key);
    } catch {
      // Storage can be blocked (private windows); the calibration then lasts for this page only.
    }
  }

  private loadCalibration(): void {
    if (!this.storageKey) return;
    try {
      const text = localStorage.getItem(STORAGE_PREFIX + this.storageKey);
      const model: unknown = text ? JSON.parse(text) : null;
      if (isValidModel(model)) this.pipeline.model = model;
    } catch {
      // A missing or unreadable calibration just means calibrating again.
    }
  }
}

function describeCameraError(err: unknown): string {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'NotAllowedError') return 'Camera permission was refused. Allow the camera for this page and try again.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found.';
  if (name === 'NotReadableError') return 'The camera is in use by another app.';
  return err instanceof Error ? err.message : String(err);
}
