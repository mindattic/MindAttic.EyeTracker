import { extractFeatures, eyeOpenness, featureVector, type FaceFeatures } from './features.js';
import { DEFAULT_FIXATION, FixationFilter, type FixationOptions } from './filters/fixation.js';
import { DEFAULT_ONE_EURO, OneEuroFilter, type OneEuroOptions } from './filters/oneEuro.js';
import { builtInModel, predict, type GazeModel } from './model.js';
import type { GazeSample, LandmarkFrame } from './types.js';

export interface PipelineOptions {
  /** Smoothing. See filters/oneEuro.ts. */
  filter: OneEuroOptions;
  /** Averaging of a steady look, which is what removes the jitter. See filters/fixation.ts. Null turns it off. */
  fixation: FixationOptions | null;
  /** The eyes count as closed when their opening falls below this fraction of the recent maximum. */
  blinkRatio: number;
}

export const DEFAULT_PIPELINE: PipelineOptions = { filter: DEFAULT_ONE_EURO, fixation: DEFAULT_FIXATION, blinkRatio: 0.45 };

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Landmarks in, gaze samples out: feature extraction, blink detection, the gaze model and
 * smoothing. No camera and no DOM, so it is the part every platform shares and tests can drive.
 */
export class GazePipeline {
  /** The fitted model, or null to use the built-in mapping. */
  model: GazeModel | null = null;
  /** The last frame's features and regression input, kept for calibration to read. */
  lastFeatures: FaceFeatures | null = null;
  lastVector: number[] | null = null;
  lastBlink = false;

  private readonly fallback = builtInModel();
  private readonly fx: OneEuroFilter;
  private readonly fy: OneEuroFilter;
  private readonly fixation: FixationFilter | null;
  /** True while the eyes are resting on one spot. */
  fixating = false;
  private openBaseline = 0;
  private last: GazeSample | null = null;

  constructor(public readonly options: PipelineOptions = DEFAULT_PIPELINE) {
    this.fx = new OneEuroFilter(options.filter);
    this.fy = new OneEuroFilter(options.filter);
    this.fixation = options.fixation ? new FixationFilter(options.fixation) : null;
  }

  reset(): void {
    this.fx.reset();
    this.fy.reset();
    this.fixation?.reset();
    this.fixating = false;
    this.openBaseline = 0;
    this.last = null;
  }

  /** Pass null when the camera frame had no face in it. */
  process(frame: LandmarkFrame | null, t: number = frame?.t ?? 0): GazeSample {
    const features = frame ? extractFeatures(frame) : null;
    this.lastFeatures = features;
    this.lastVector = null;
    this.lastBlink = false;
    const calibrated = this.model !== null;
    if (!features) {
      const held = this.last;
      return {
        t,
        x: held?.x ?? 0.5,
        y: held?.y ?? 0.5,
        rawX: held?.rawX ?? 0.5,
        rawY: held?.rawY ?? 0.5,
        confidence: 0,
        face: false,
        blink: false,
        calibrated,
      };
    }

    // The baseline follows the widest recent opening and decays slowly, so it adapts to the
    // person and to squinting without being pulled down by the blinks themselves.
    const open = eyeOpenness(features);
    this.openBaseline = Math.max(open, this.openBaseline * 0.998);
    const blink = open < this.openBaseline * this.options.blinkRatio;
    this.lastBlink = blink;
    if (blink && this.last) {
      return { ...this.last, t, confidence: 0, face: true, blink: true, calibrated };
    }

    const phi = featureVector(features);
    this.lastVector = phi;
    const raw = predict(this.model ?? this.fallback, phi);
    // First centre on the average of a steady look, then smooth what is left.
    const steady = this.fixation ? this.fixation.filter(raw.x, raw.y) : raw;
    this.fixating = this.fixation?.fixating ?? false;
    const sample: GazeSample = {
      t,
      x: clamp01(this.fx.filter(steady.x, t)),
      y: clamp01(this.fy.filter(steady.y, t)),
      rawX: raw.x,
      rawY: raw.y,
      confidence: confidenceOf(features),
      face: true,
      blink,
      calibrated,
    };
    this.last = sample;
    return sample;
  }
}

/** Lower when the face is small in the image or turned far from the camera, where the iris is hard to place. */
function confidenceOf(f: FaceFeatures): number {
  const size = clamp01(f.scale / 0.07);
  const turn = clamp01(1.4 - Math.abs(f.yaw) * 2.5);
  return clamp01(size * turn);
}
