import { CalibrationSession } from './calibration.js';
import { CameraLandmarkSource, type CameraOptions } from './camera.js';
import { Emitter } from './emitter.js';
import type { FaceFeatures } from './features.js';
import { addSample, isValidStats, solveStats } from './learning.js';
import { isValidModel, predict, type GazeModel } from './model.js';
import { DEFAULT_PIPELINE, GazePipeline, type PipelineOptions } from './pipeline.js';
import { screenToViewport, viewportOnScreen, viewportToScreen } from './screenSpace.js';
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
  /**
   * What the gaze point is relative to.
   * "viewport" (the default): this page's viewport, wherever the window is and whatever its size.
   * The model is fitted in screen space and converted, so a calibration made fullscreen still holds
   * in a window, and the other way round.
   * "display": no conversion; the point is relative to whatever area the calibration targets
   * covered. Use it when this page is only the camera and a display elsewhere draws the targets.
   */
  space?: 'viewport' | 'display';
  /**
   * Keep learning after calibration from mouse clicks and taps: people look at what they click, so
   * each click is a free calibration point. On by default in "viewport" space.
   */
  learnFromClicks?: boolean;
}

export interface TrackerEvents extends Record<string, unknown> {
  gaze: GazeSample;
  /** Every processed frame, with the landmarks and features behind it (for previews and debugging). */
  frame: { frame: LandmarkFrame | null; features: FaceFeatures | null };
  status: TrackerStatus;
}

// v2: models are fitted in screen space. Older, viewport-space models are left behind.
const STORAGE_PREFIX = 'mindattic.eyetracker.model.v3.';

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
  private readonly space: 'viewport' | 'display';
  private pendingHint: { x: number; y: number; weight: number; frames: number } | null = null;
  private unsolved = 0;
  private readonly onClick = (ev: PointerEvent) => {
    if (this.session || this.status.state !== 'running') return;
    this.hint(ev.clientX / Math.max(1, window.innerWidth), ev.clientY / Math.max(1, window.innerHeight));
  };
  private frames = 0;
  private fpsSince = 0;

  constructor(options: EyeTrackerOptions = {}) {
    super();
    this.camera = new CameraLandmarkSource(options.camera);
    this.pipeline = new GazePipeline({ ...DEFAULT_PIPELINE, ...options.pipeline });
    this.storageKey = options.storageKey === undefined ? 'default' : options.storageKey;
    this.space = options.space ?? 'viewport';
    this.loadCalibration();
    if ((options.learnFromClicks ?? this.space === 'viewport') && typeof window !== 'undefined') {
      window.addEventListener('pointerdown', this.onClick, true);
    }
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
    const sample = this.toOutputSpace(this.pipeline.process(frame, t));
    if (this.session?.collecting && this.pipeline.lastVector && !this.pipeline.lastBlink) {
      this.session.add(this.pipeline.lastVector);
    }
    this.learn();
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

  /** The pipeline works in screen space; hand out the point relative to the page as it is right now. */
  private toOutputSpace(sample: GazeSample): GazeSample {
    if (this.space !== 'viewport') return sample;
    const v = viewportOnScreen();
    const clamp = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
    const smooth = screenToViewport(sample.x, sample.y, v);
    const raw = screenToViewport(sample.rawX, sample.rawY, v);
    return { ...sample, x: clamp(smooth.x), y: clamp(smooth.y), rawX: raw.x, rawY: raw.y };
  }

  private setStatus(patch: Partial<TrackerStatus>): void {
    this.status = { ...this.status, ...patch, calibrated: this.calibrated };
    this.emit('status', this.status);
  }

  // ---- learning in use ----

  /**
   * The user is looking at (x, y) now. The next few frames are added to the fit as extra
   * calibration samples, at a fraction of the weight of a real calibration sample.
   */
  hint(x: number, y: number, weight = 0.5): void {
    if (!this.pipeline.model?.stats || this.session) return;
    const target = this.space === 'viewport' ? viewportToScreen(x, y) : { x, y };
    this.pendingHint = { x: target.x, y: target.y, weight, frames: 4 };
  }

  /** How many samples have been learned since the calibration. */
  get learned(): number {
    return this.pipeline.model?.learned ?? 0;
  }

  private learn(): void {
    const hint = this.pendingHint;
    const model = this.pipeline.model;
    const phi = this.pipeline.lastVector;
    if (!hint || !model?.stats) return;
    if (!phi || this.pipeline.lastBlink) return;
    hint.frames--;
    if (hint.frames <= 0) this.pendingHint = null;
    // A hint is a guess about where the user is looking. If the current estimate is nowhere near
    // it, the guess is probably wrong (they clicked without looking), so it is not learned.
    const now = predict(model, phi);
    if (Math.hypot(now.x - hint.x, now.y - hint.y) > 0.3) return;
    addSample(model.stats, phi, hint.x, hint.y, hint.weight);
    model.learned = (model.learned ?? 0) + 1;
    this.unsolved++;
    if (this.unsolved >= 4) {
      this.unsolved = 0;
      const solved = solveStats(model.stats);
      if (solved.wx.every(Number.isFinite) && solved.wy.every(Number.isFinite)) {
        model.wx = solved.wx;
        model.wy = solved.wy;
        this.saveCalibration();
      }
    }
  }

  // ---- calibration (GazeSource) ----

  calibBegin(): void {
    this.session = new CalibrationSession();
  }

  calibCollect(x: number, y: number, ms: number, headMoving = false): Promise<number> {
    const session = (this.session ??= new CalibrationSession());
    const target = this.space === 'viewport' ? viewportToScreen(x, y) : { x, y };
    session.beginTarget(target.x, target.y, headMoving);
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
      if (isValidModel(model)) {
        if (model.stats && !isValidStats(model.stats)) delete model.stats;
        this.pipeline.model = model;
      }
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
