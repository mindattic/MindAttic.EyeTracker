import { Emitter } from './emitter.js';
import { epochClock, spoken, type EventCategory, type FrameSource, type WebcamEvent } from './events.js';
import { extractFeatures } from './features.js';
import type { LandmarkFrame, WebcamFrame } from './types.js';

/**
 * Head pose and gaze region (@mindattic/webcam/headpose): a calibration-free answer to "is this
 * person looking at the screen, or toward one side of it, above it or below it, and for how long?"
 *
 * It adds the head's direction (from the face mesh) to how far the eyes are turned in the head
 * (iris position in the eye opening) to get a rough viewing direction in degrees, and compares
 * that with a baseline learned on its own from the first seconds, when a person is looking at
 * the screen. It is a region classifier, not a gaze tracker: left, right, up, down and on-screen,
 * good to a few degrees at best. For a point on the screen use the eyetracking module.
 *
 * What it will NOT do: say why someone looked away. Looking up or aside is a normal part of
 * thinking about a question (the cognitive-load literature; see docs/GAZE-AND-DECEPTION.md), so a
 * brief glance away is annotated as "thinking", never as suspicious. Nothing here infers emotion,
 * stress or deception (EU AI Act Art. 5(1)(f)).
 */

export type GazeRegion = 'on-screen' | 'left' | 'right' | 'up' | 'down';

/** Viewing direction in degrees. Yaw is positive toward the screen's right, pitch positive upward. */
export interface GazeAngles {
  yawDeg: number;
  pitchDeg: number;
  /** The head's own share of each angle, and the eyes' share. They add up to yaw and pitch. */
  headYawDeg: number;
  headPitchDeg: number;
  eyeYawDeg: number;
  eyePitchDeg: number;
  /** 0..1: lower for a small face or a head turned far from the camera. */
  confidence: number;
}

const DEG = 180 / Math.PI;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
/** Iris offset (in eye-widths) produced by turning the eyeball by 90 degrees. Eyeball radius over eye width. */
const EYE_K_X = 0.4;
const EYE_K_Y = 0.32;

/** Absolute viewing direction from one face mesh, with no calibration. Null if the mesh is unusable or the eyes are closed. */
export function estimateGazeAngles(frame: LandmarkFrame): GazeAngles | null {
  const f = extractFeatures(frame);
  if (!f) return null;
  if (f.right.open + f.left.open < 0.14) return null; // eyes closed: the iris is hidden
  // The face plane's angle against the lens, from the head-pose matrix when there is one. Turning
  // the head to the screen's right turns the face toward the image's left, hence the minus signs.
  const headYaw = -f.planeYaw * DEG;
  const headPitch = -f.planePitch * DEG;
  // Iris offset along the eye line is positive toward the image's right (the subject's left).
  const ix = (f.right.x + f.left.x) / 2;
  const iy = (f.right.y + f.left.y) / 2;
  const eyeYaw = -Math.asin(clamp(ix / EYE_K_X, -0.9, 0.9)) * DEG;
  const eyePitch = -Math.asin(clamp(iy / EYE_K_Y, -0.9, 0.9)) * DEG;
  const size = clamp(f.scale / 0.07, 0, 1);
  const turn = clamp(1.4 - Math.abs(f.yaw) * 2.5, 0, 1);
  return {
    yawDeg: headYaw + eyeYaw,
    pitchDeg: headPitch + eyePitch,
    headYawDeg: headYaw,
    headPitchDeg: headPitch,
    eyeYawDeg: eyeYaw,
    eyePitchDeg: eyePitch,
    confidence: size * turn,
  };
}

/**
 * Region limits for a screen of a known size: the angle from the middle of the screen to its edge
 * as seen from `distanceCm`, plus slack for the estimate's own error. Pass the result as options
 * to a HeadPoseMonitor when the screen is bigger or smaller than a laptop's, otherwise a student
 * reading the corner of a large monitor would count as looking away.
 */
export function regionLimitsFor(
  screenWidthCm: number,
  screenHeightCm: number,
  distanceCm: number,
  slackDeg = 4,
): Pick<HeadPoseOptions, 'halfWidthDeg' | 'halfHeightDeg'> {
  const half = (cm: number) => Math.atan(cm / 2 / Math.max(10, distanceCm)) * DEG + slackDeg;
  return { halfWidthDeg: half(screenWidthCm), halfHeightDeg: half(screenHeightCm) };
}

export interface HeadPoseOptions {
  /** How far, in degrees, the viewing direction may stray sideways from the baseline and still count as on-screen. */
  halfWidthDeg: number;
  /** The same, up and down. */
  halfHeightDeg: number;
  /** Frames averaged to find the baseline at the start (about 1.5 s at 30 fps). */
  baselineFrames: number;
  /** A region must hold this long before it replaces the current one, so noise and blinks do not flicker it. */
  switchMs: number;
  /** An off-screen look shorter than this is a glance, annotated as thinking. */
  thinkingMs: number;
  /** An off-screen look at least this long is reported as sustained off-screen gaze. */
  sustainedMs: number;
  /** Frames with confidence below this are ignored. */
  minConfidence: number;
  /** Converts the frame clock to Unix ms. Default: performance.now() based. */
  epoch?: (t: number) => number;
}

export const DEFAULT_HEADPOSE: HeadPoseOptions = {
  halfWidthDeg: 18,
  halfHeightDeg: 11,
  baselineFrames: 45,
  switchMs: 150,
  thinkingMs: 4000,
  sustainedMs: 6000,
  minConfidence: 0.25,
};

/** One frame's answer. Angles are relative to the on-screen baseline. */
export interface GazeRegionSample {
  t: number;
  region: GazeRegion;
  /** Degrees from the baseline: positive yaw is toward the screen's right, positive pitch upward. */
  yawDeg: number;
  pitchDeg: number;
  /** How long the region has held, in ms. */
  dwellMs: number;
  confidence: number;
  /** The baseline has been learned; before that every sample is "on-screen". */
  ready: boolean;
}

/** A finished stay in one region. */
export interface RegionSegment {
  region: GazeRegion;
  start: number;
  end: number;
  dwellMs: number;
  /** Off-screen for less than `thinkingMs`: a glance, annotated as thinking. */
  thinking: boolean;
  /** The farthest the viewing direction got from the baseline, in degrees. */
  peakDeg: number;
}

export interface HeadPoseEvent extends WebcamEvent {
  type: 'thinking-glance' | 'gaze-off-screen';
  category: EventCategory;
  region: Exclude<GazeRegion, 'on-screen'>;
  dwellMs: number;
}

export interface HeadPoseEvents extends Record<string, unknown> {
  sample: GazeRegionSample;
  segment: RegionSegment;
  begin: { type: 'gaze-off-screen'; start: number; category: EventCategory };
  event: HeadPoseEvent;
}

const WORDS: Record<Exclude<GazeRegion, 'on-screen'>, string> = {
  left: 'to the left',
  right: 'to the right',
  up: 'up',
  down: 'down',
};

export class HeadPoseMonitor extends Emitter<HeadPoseEvents> {
  readonly options: HeadPoseOptions;
  latest: GazeRegionSample | null = null;

  private readonly epoch: (t: number) => number;
  private baseYaw = 0;
  private basePitch = 0;
  private baseN = 0;
  private ready = false;
  private smYaw = 0;
  private smPitch = 0;
  private smReady = false;
  private region: GazeRegion = 'on-screen';
  private regionSince = 0;
  private candidate: GazeRegion | null = null;
  private candidateSince = 0;
  private peak = 0;
  private sustainedReported = false;
  private lastSeen = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(options: Partial<HeadPoseOptions> = {}) {
    super();
    this.options = { ...DEFAULT_HEADPOSE, ...options };
    this.epoch = this.options.epoch ?? epochClock();
  }

  connect(source: FrameSource): () => void {
    this.unsubscribe?.();
    this.unsubscribe = source.subscribe((f) => this.process(f));
    return () => {
      this.unsubscribe?.();
      this.unsubscribe = null;
    };
  }

  /** Throw the baseline away and learn it again from the next frames (the person moved their seat or screen). */
  recalibrate(): void {
    this.ready = false;
    this.baseN = 0;
    this.baseYaw = 0;
    this.basePitch = 0;
    this.smReady = false;
  }

  get baselineReady(): boolean {
    return this.ready;
  }

  /** The face has been gone (or the camera stopped): close the current stay without judging it. */
  flush(t: number = this.lastSeen): void {
    this.finishSegment(t);
    this.region = 'on-screen';
    this.regionSince = t;
    this.candidate = null;
    this.sustainedReported = false;
  }

  process(frame: WebcamFrame): void {
    const t = frame.t;
    const face = frame.faces[0];
    const g = face ? estimateGazeAngles(face) : null;
    if (!face) {
      // No face: presence deals with that. Do not let a gap pass for a long look away.
      if (this.latest && t - this.lastSeen > 1000) this.flush(this.lastSeen);
      return;
    }
    if (!g || g.confidence < this.options.minConfidence) return;
    this.lastSeen = t;
    const o = this.options;

    // Light smoothing against landmark jitter.
    if (!this.smReady) {
      this.smYaw = g.yawDeg;
      this.smPitch = g.pitchDeg;
      this.smReady = true;
    } else {
      this.smYaw += (g.yawDeg - this.smYaw) * 0.4;
      this.smPitch += (g.pitchDeg - this.smPitch) * 0.4;
    }

    if (!this.ready) {
      this.baseN++;
      this.baseYaw += (this.smYaw - this.baseYaw) / this.baseN;
      this.basePitch += (this.smPitch - this.basePitch) / this.baseN;
      if (this.baseN >= o.baselineFrames) this.ready = true;
      this.regionSince ||= t;
      this.publish(t, 'on-screen', 0, 0, g.confidence);
      return;
    }

    const dyaw = this.smYaw - this.baseYaw;
    const dpitch = this.smPitch - this.basePitch;
    const nx = dyaw / o.halfWidthDeg;
    const ny = dpitch / o.halfHeightDeg;
    // Hysteresis: leave "on-screen" past the edge, come back only well inside it.
    const edge = this.region === 'on-screen' ? 1 : 0.75;
    let want: GazeRegion;
    if (Math.max(Math.abs(nx), Math.abs(ny)) <= edge) want = 'on-screen';
    else if (Math.abs(nx) >= Math.abs(ny)) want = nx > 0 ? 'right' : 'left';
    else want = ny > 0 ? 'up' : 'down';

    if (want === 'on-screen') {
      // Follow slow drift of where "the screen" is (sitting back, shifting), only while looking at it.
      if (this.region === 'on-screen' && Math.max(Math.abs(nx), Math.abs(ny)) < 0.6) {
        this.baseYaw += dyaw * 0.004;
        this.basePitch += dpitch * 0.004;
      }
    }

    if (want !== this.region) {
      if (this.candidate !== want) {
        this.candidate = want;
        this.candidateSince = t;
      }
      if (t - this.candidateSince >= o.switchMs) {
        this.finishSegment(this.candidateSince);
        this.region = want;
        this.regionSince = this.candidateSince;
        this.candidate = null;
        this.peak = 0;
        this.sustainedReported = false;
      }
    } else {
      this.candidate = null;
    }

    if (this.region !== 'on-screen') this.peak = Math.max(this.peak, Math.hypot(dyaw, dpitch));
    const dwell = t - this.regionSince;
    if (this.region !== 'on-screen' && !this.sustainedReported && dwell >= o.sustainedMs) {
      this.sustainedReported = true;
      this.emit('begin', { type: 'gaze-off-screen', start: this.epoch(this.regionSince), category: 'integrity' });
    }
    this.publish(t, this.region, dyaw, dpitch, g.confidence);
  }

  private publish(t: number, region: GazeRegion, yawDeg: number, pitchDeg: number, confidence: number): void {
    const s: GazeRegionSample = {
      t,
      region,
      yawDeg,
      pitchDeg,
      dwellMs: Math.max(0, t - this.regionSince),
      confidence,
      ready: this.ready,
    };
    this.latest = s;
    this.emit('sample', s);
  }

  private finishSegment(end: number): void {
    if (!this.ready || end <= this.regionSince) return;
    const o = this.options;
    const dwellMs = end - this.regionSince;
    const off = this.region !== 'on-screen';
    const thinking = off && dwellMs < o.thinkingMs;
    const seg: RegionSegment = { region: this.region, start: this.regionSince, end, dwellMs, thinking, peakDeg: this.peak };
    this.emit('segment', seg);
    if (!off) return;
    const region = this.region as Exclude<GazeRegion, 'on-screen'>;
    if (thinking) {
      // Brief looks off-screen are annotated as normal thinking behaviour; they are never flagged.
      this.emit('event', {
        type: 'thinking-glance',
        category: 'annotation',
        region,
        dwellMs,
        start: this.epoch(seg.start),
        end: this.epoch(seg.end),
        confidence: 0.6,
        summary: `Looked ${WORDS[region]} for ${spoken(dwellMs)}, a short glance of the kind people make while thinking. Not a concern on its own.`,
      });
    } else if (dwellMs >= o.sustainedMs) {
      this.emit('event', {
        type: 'gaze-off-screen',
        category: 'integrity',
        region,
        dwellMs,
        start: this.epoch(seg.start),
        end: this.epoch(seg.end),
        confidence: clamp(0.3 + (dwellMs - o.sustainedMs) / 60000, 0.3, 0.55),
        summary: `Looked ${WORDS[region]} for ${spoken(dwellMs)}. Long looks away can be thinking, reading something, or a distraction; read it in context with the answer given.`,
      });
    }
  }
}
