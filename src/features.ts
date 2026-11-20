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

/** Typical adult distance between the pupils, in centimetres. Used to judge distance when there is no head-pose matrix. */
export const IOD_CM = 6.3;
/** A typical webcam's vertical field of view, in radians. Used only when there is no head-pose matrix. */
export const CAMERA_FOV_V = (40 * Math.PI) / 180;

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
  /**
   * Where the head is pointing: the spot, in centimetres on the camera's own plane, that a line
   * straight out of the face would hit. It moves when the head turns and when the head moves.
   * With the eyes still in the head, the gaze point moves with it.
   */
  hx: number;
  hy: number;
  /** Distance from the camera to the face, in centimetres. */
  dist: number;
  /**
   * The angle between the plane of the face and the plane of the lens, in radians, split into its
   * left/right and up/down parts. Zero means the face is square to the camera. These are for
   * display and diagnosis; the model uses the head point, which carries the same information.
   */
  planeYaw: number;
  planePitch: number;
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

/**
 * The head's position and direction as "where it points on the camera's plane".
 *
 * With MediaPipe's head-pose matrix this is exact geometry: the face's position t and its outward
 * direction f in camera space, followed to the plane the camera sits in. Without the matrix (a
 * synthetic face, an older model) the same quantities are estimated from the landmarks: distance
 * from how far apart the eyes appear, direction from where the nose tip sits between them.
 */
function headPoint(
  frame: LandmarkFrame,
  centre: V2,
  iod: number,
  yaw: number,
  pitch: number,
  aspect: number,
): { hx: number; hy: number; dist: number; planeYaw: number; planePitch: number } {
  const m = frame.matrix;
  if (m && m.length >= 16) {
    // The matrix may arrive column-major or row-major; the translation is the part with the big
    // numbers (tens of centimetres), which tells them apart.
    const columnMajor = Math.abs(m[14]) >= Math.abs(m[11]);
    const tx = columnMajor ? m[12] : m[3];
    const ty = columnMajor ? m[13] : m[7];
    const tz = columnMajor ? m[14] : m[11];
    const fx = columnMajor ? m[8] : m[2];
    const fy = columnMajor ? m[9] : m[6];
    let fz = columnMajor ? m[10] : m[10];
    if (Number.isFinite(tx + ty + tz + fx + fy + fz) && Math.abs(tz) > 1) {
      // A face turned nearly side-on would send the point to infinity; hold the slope finite.
      if (Math.abs(fz) < 0.25) fz = fz < 0 ? -0.25 : 0.25;
      return {
        hx: tx - (tz * fx) / fz,
        hy: ty - (tz * fy) / fz,
        dist: Math.abs(tz),
        planeYaw: Math.atan2(fx, Math.abs(fz)),
        planePitch: Math.atan2(fy, Math.abs(fz)),
      };
    }
  }
  const span = 2 * Math.tan(CAMERA_FOV_V / 2);
  const dist = IOD_CM / (iod * span);
  const tx = (centre.x - aspect / 2) * span * dist;
  const ty = (centre.y - 0.5) * span * dist;
  // The nose tip stands about 3 cm proud of the eye line and 3.5 cm below it, so its offset
  // between the eyes gives the tangent of the head's turn and tilt.
  const tanYaw = yaw * 2.1;
  const tanPitch = (pitch - 0.556) * 2.1;
  return {
    hx: tx + dist * tanYaw,
    hy: ty + dist * tanPitch,
    dist,
    planeYaw: Math.atan(tanYaw),
    planePitch: Math.atan(tanPitch),
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
  const yaw = ((nose.x - c.x) * ax.x + (nose.y - c.y) * ax.y) / iod;
  const pitch = ((nose.x - c.x) * ay.x + (nose.y - c.y) * ay.y) / iod;
  const head = headPoint(frame, c, iod, yaw, pitch, aspect);
  return {
    right: r.features,
    left: l.features,
    hx: head.hx,
    hy: head.hy,
    dist: head.dist,
    planeYaw: head.planeYaw,
    planePitch: head.planePitch,
    yaw,
    pitch,
    roll: Math.atan2(dy, dx),
    px: c.x / aspect - 0.5,
    py: c.y - 0.5,
    scale: iod,
  };
}

/** Length of the vector `featureVector` returns. */
export const FEATURE_COUNT = 21;
/** Bumped whenever `featureVector` changes meaning, so stored models from an older layout are refused. */
export const FEATURE_VERSION = 2;

/**
 * Per-feature ridge penalty, matching `featureVector`. The bias and the eye terms are nearly free.
 * The head terms are held back a little, so they earn their weight from the head-movement part of
 * the calibration and stay small if that part was skipped.
 */
export const FEATURE_PENALTY: readonly number[] = [
  0, // bias: this is where a camera that is off to one side is absorbed
  3e-4, 3e-4, // where the head points
  1e-4, 1e-4, 1e-4, 1e-4, // eye rotation, both eyes
  1e-3, 1e-3, // eyelids
  3e-3, // distance
  1e-3, 1e-3, 1e-3, // eye rotation, second order
  3e-3, 3e-3, // head and eye together
  3e-3, 3e-3, // head, second order
  3e-3, // roll
  1e-3, 1e-3, 1e-3, // eye rotation, third order: wide screens, where the eyes turn a long way
];

/**
 * The regression input, laid out after the geometry of looking at a screen.
 *
 * The gaze point is roughly: where the head points, plus how far the eyes are turned in the head
 * times the distance to the screen. So the head point enters directly, and every eye term is
 * multiplied by the distance. Eye offsets are measured along the eye line, which rolls with the
 * head, so they are turned back to the camera's own axes first. A camera that is not at the
 * centre of the screen, or is tilted, changes only the constants the fit finds: the bias and the
 * weights. Nothing here assumes where the camera is.
 *
 * Every term is scaled by a fixed constant so its usual range is about -1..1.
 */
export function featureVector(f: FaceFeatures): number[] {
  const z = f.dist / 50;
  const cos = Math.cos(f.roll);
  const sin = Math.sin(f.roll);
  const turn = (e: EyeFeatures): [number, number] => [
    (e.x * cos - e.y * sin) * 8 * z,
    (e.x * sin + e.y * cos) * 8 * z,
  ];
  const [rx, ry] = turn(f.right);
  const [lx, ly] = turn(f.left);
  const h1 = f.hx / 20;
  const h2 = f.hy / 20;
  const mx = (rx + lx) / 2;
  const my = (ry + ly) / 2;
  return [
    1,
    h1,
    h2,
    rx,
    ry,
    lx,
    ly,
    f.right.lid * 8 * z,
    f.left.lid * 8 * z,
    z - 1,
    mx * mx,
    my * my,
    mx * my,
    h1 * mx,
    h2 * my,
    h1 * h1,
    h2 * h2,
    f.roll * 4,
    mx * mx * mx,
    my * my * my,
    mx * my * my,
  ];
}

/** Mean eyelid opening of both eyes, used for blink detection. */
export function eyeOpenness(f: FaceFeatures): number {
  return (f.right.open + f.left.open) / 2;
}
