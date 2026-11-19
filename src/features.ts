import type { Landmark, LandmarkFrame } from './types.js';

/**
 * MediaPipe Face Landmarker indices used here. "Right" and "left" are the subject's own right and
 * left; in an unmirrored camera image the subject's right eye is on the image's left.
 */
export const LM = {
  rightOuter: 33,
  rightInner: 133,
  rightUpper: 159,
  rightLower: 145,
  rightIris: [468, 469, 470, 471, 472],
  leftInner: 362,
  leftOuter: 263,
  leftUpper: 386,
  leftLower: 374,
  leftIris: [473, 474, 475, 476, 477],
  noseTip: 1,
} as const;

/** The mesh must include the iris points (the last ten of 478). */
export const LANDMARK_COUNT = 478;

/** Where the iris sits inside one eye opening, in units of that eye's corner-to-corner width. */
export interface EyeFeatures {
  /**
   * Iris centre along the corner-to-corner line, measured from its midpoint. This is the eye-white
   * balance: negative means more white shows on the image-right side of the iris.
   */
  x: number;
  /** Iris centre above (negative) or below (positive) the corner-to-corner line. */
  y: number;
  /** Upper eyelid height relative to the corner line. It follows vertical gaze closely. */
  lid: number;
  /** Eyelid opening (upper to lower lid). Near zero when the eye is closed. */
  open: number;
}

export interface FaceFeatures {
  right: EyeFeatures;
  left: EyeFeatures;
  /** Head turn left/right: nose offset along the eye line, in eye-distance units. */
  yaw: number;
  /** Head tilt up/down: nose offset below the eye line, in eye-distance units. */
  pitch: number;
  /** Head roll in radians: the slope of the eye line. */
  roll: number;
  /** Face position in the image, centred on zero. */
  px: number;
  py: number;
  /** Distance between the eyes as a fraction of image height: larger means closer to the camera. */
  scale: number;
}

interface V2 {
  x: number;
  y: number;
}

function eye(
  lm: ArrayLike<Landmark>,
  aspect: number,
  cornerA: number,
  cornerB: number,
  upper: number,
  lower: number,
  iris: readonly number[],
): { features: EyeFeatures; mid: V2 } | null {
  const p = (i: number): V2 => ({ x: lm[i].x * aspect, y: lm[i].y });
  const a = p(cornerA);
  const b = p(cornerB);
  const w = Math.hypot(b.x - a.x, b.y - a.y);
  if (!(w > 1e-6)) return null;
  const ax = { x: (b.x - a.x) / w, y: (b.y - a.y) / w };
  const ay = { x: -ax.y, y: ax.x };
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  let ix = 0;
  let iy = 0;
  for (const i of iris) {
    const q = p(i);
    ix += q.x;
    iy += q.y;
  }
  ix /= iris.length;
  iy /= iris.length;
  const u = p(upper);
  const l = p(lower);
  const along = (q: V2, axis: V2) => ((q.x - mid.x) * axis.x + (q.y - mid.y) * axis.y) / w;
  return {
    features: {
      x: along({ x: ix, y: iy }, ax),
      y: along({ x: ix, y: iy }, ay),
      lid: along(u, ay),
      open: Math.hypot(u.x - l.x, u.y - l.y) / w,
    },
    mid,
  };
}

/** Reduce a face mesh to the handful of numbers gaze depends on. Returns null if the mesh has no iris points. */
export function extractFeatures(frame: LandmarkFrame): FaceFeatures | null {
  const lm = frame.landmarks;
  if (!lm || lm.length < LANDMARK_COUNT) return null;
  const aspect = frame.aspect > 0 ? frame.aspect : 1;
  // Corner order is image-left first for both eyes, so x has the same sign for both.
  const r = eye(lm, aspect, LM.rightOuter, LM.rightInner, LM.rightUpper, LM.rightLower, LM.rightIris);
  const l = eye(lm, aspect, LM.leftInner, LM.leftOuter, LM.leftUpper, LM.leftLower, LM.leftIris);
  if (!r || !l) return null;
  const dx = l.mid.x - r.mid.x;
  const dy = l.mid.y - r.mid.y;
  const iod = Math.hypot(dx, dy);
  if (!(iod > 1e-6)) return null;
  const ax = { x: dx / iod, y: dy / iod };
  const ay = { x: -ax.y, y: ax.x };
  const c = { x: (l.mid.x + r.mid.x) / 2, y: (l.mid.y + r.mid.y) / 2 };
  const nose = { x: lm[LM.noseTip].x * aspect, y: lm[LM.noseTip].y };
  return {
    right: r.features,
    left: l.features,
    yaw: ((nose.x - c.x) * ax.x + (nose.y - c.y) * ax.y) / iod,
    pitch: ((nose.x - c.x) * ay.x + (nose.y - c.y) * ay.y) / iod,
    roll: Math.atan2(dy, dx),
    px: c.x / aspect - 0.5,
    py: c.y - 0.5,
    scale: iod,
  };
}

/** Length of the vector `featureVector` returns. */
export const FEATURE_COUNT = 18;

/**
 * Per-feature ridge penalty, matching `featureVector`. The bias is free, the iris terms nearly
 * free, and the head terms are held back so they only earn weight when the calibration data
 * actually shows the head moving.
 */
export const FEATURE_PENALTY: readonly number[] = [
  0, // bias
  1e-4, 1e-4, 1e-4, 1e-4, // iris x/y, both eyes
  1e-3, 1e-3, // eyelids
  3e-3, 3e-3, 3e-3, 3e-3, 3e-3, 3e-3, // head yaw, pitch, roll, position, scale
  1e-3, 1e-3, 1e-3, 1e-3, 1e-3, // second-order terms
];

/**
 * The regression input. Every term is scaled so its usual range is about -1..1; the scales are
 * fixed constants, not statistics of the calibration data, so a feature that happened to stay
 * still during calibration cannot blow up later.
 */
export function featureVector(f: FaceFeatures): number[] {
  const rx = f.right.x * 8;
  const ry = f.right.y * 8;
  const lx = f.left.x * 8;
  const ly = f.left.y * 8;
  const yaw = f.yaw * 4;
  const pitch = (f.pitch - 0.6) * 4;
  const mx = (rx + lx) / 2;
  const my = (ry + ly) / 2;
  return [
    1,
    rx,
    ry,
    lx,
    ly,
    f.right.lid * 8,
    f.left.lid * 8,
    yaw,
    pitch,
    f.roll * 4,
    f.px * 4,
    f.py * 4,
    (f.scale - 0.12) * 8,
    mx * mx,
    my * my,
    mx * my,
    mx * yaw,
    my * pitch,
  ];
}

/** Mean eyelid opening of both eyes, used for blink detection. */
export function eyeOpenness(f: FaceFeatures): number {
  return (f.right.open + f.left.open) / 2;
}
