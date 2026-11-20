import { CAMERA_FOV_V, LANDMARK_COUNT, LM } from '../features.js';
import type { Landmark, LandmarkFrame } from '../types.js';

/** A small deterministic generator (mulberry32) so synthetic data is the same on every run. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SyntheticFaceOptions {
  /** Where the synthetic person is looking, in normalized screen space. */
  gazeX: number;
  gazeY: number;
  /** Where the camera sits, in normalized screen space. Default: just above the top edge, centred. */
  cameraX?: number;
  cameraY?: number;
  /** Camera tilt in radians: positive tips it down toward the user's chest. */
  cameraTilt?: number;
  /** Screen size in centimetres. */
  screenWidthCm?: number;
  screenHeightCm?: number;
  /** Head position relative to the camera, in centimetres: x to the right of the image, y down, z away from the camera. */
  headXCm?: number;
  headYCm?: number;
  distanceCm?: number;
  /** Head turn, tilt and roll in radians. */
  yaw?: number;
  pitch?: number;
  roll?: number;
  /** Eyes closed. */
  blink?: boolean;
  /** Landmark jitter, as a fraction of the eye width. A real webcam gives roughly 0.01 to 0.03. */
  noise?: number;
  random?: () => number;
  aspect?: number;
  /** Also supply the head-pose matrix, as MediaPipe would. */
  matrix?: boolean;
  t?: number;
}

type V3 = [number, number, number];

const EYE_HALF_GAP = 3.15; // cm from the bridge of the nose to each eye
const EYE_HALF_WIDTH = 1.4; // cm from an eye's centre to its corner
const EYEBALL_RADIUS = 1.2; // cm from the eye's centre of rotation to the iris

/**
 * A face mesh computed from real geometry: a screen of a given size, a camera somewhere on its
 * edge, a head at a given place and angle, and eyes that turn in the head to look at a point on
 * the screen. The landmarks are that scene projected through a pinhole camera.
 *
 * It lets the whole pipeline be exercised without a camera, and in particular it shows whether a
 * calibration still holds when the camera is off to one side and the head moves afterwards.
 * Only the landmarks the tracker reads are meaningful; the rest sit at the face centre.
 */
export function syntheticFace(o: SyntheticFaceOptions): LandmarkFrame {
  const aspect = o.aspect ?? 16 / 9;
  const random = o.random ?? Math.random;
  const screenW = o.screenWidthCm ?? 60;
  const screenH = o.screenHeightCm ?? 34;
  const cameraX = o.cameraX ?? 0.5;
  const cameraY = o.cameraY ?? -0.03;
  const tilt = o.cameraTilt ?? 0;
  const yaw = o.yaw ?? 0;
  const pitch = o.pitch ?? 0;
  const roll = o.roll ?? 0;
  const head: V3 = [o.headXCm ?? 0, o.headYCm ?? 12, o.distanceCm ?? 55];

  // Camera space: x to the image's right, y down, z out of the lens. The screen lies in the plane
  // the camera sits in, turned about the x axis by the camera's tilt.
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  // The camera looks back at the user, so the screen's right is the image's left.
  const sx = -(o.gazeX - cameraX) * screenW;
  const sy = (o.gazeY - cameraY) * screenH;
  const target: V3 = [sx, sy * ct, -sy * st];

  // Head axes in camera space: right (toward the subject's left eye, image-right), down, and out
  // of the face toward the camera.
  const cy = Math.cos(yaw);
  const syw = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  // R = Ry(yaw) * Rx(pitch) * Rz(roll), applied to the head's own axes (x right, y down, z outward = -camera z).
  const rot = (v: V3): V3 => {
    const x1 = v[0] * cr - v[1] * sr;
    const y1 = v[0] * sr + v[1] * cr;
    const z1 = v[2];
    const y2 = y1 * cp - z1 * sp;
    const z2 = y1 * sp + z1 * cp;
    const x3 = x1 * cy + z2 * syw;
    const z3 = -x1 * syw + z2 * cy;
    return [x3, y2, z3];
  };
  // Head-frame z points out of the face, which in camera space is toward the camera: negative z.
  const toCamera = (v: V3): V3 => {
    const w = rot(v);
    return [head[0] + w[0], head[1] + w[1], head[2] - w[2]];
  };
  const unrot = (d: V3): V3 => {
    // Inverse of `rot`, for a direction given in camera space with its z flipped to head convention.
    const x1 = d[0] * cy - d[2] * syw;
    const z1 = d[0] * syw + d[2] * cy;
    const y2 = d[1] * cp + z1 * sp;
    const z2 = -d[1] * sp + z1 * cp;
    return [x1 * cr + y2 * sr, -x1 * sr + y2 * cr, z2];
  };

  const span = 2 * Math.tan(CAMERA_FOV_V / 2);
  const jitter = () => (o.noise ? (random() - 0.5) * 2 * o.noise * (2 * EYE_HALF_WIDTH) : 0);
  const project = (v: V3): Landmark => {
    const c = toCamera([v[0] + jitter(), v[1] + jitter(), v[2]]);
    return { x: 0.5 + c[0] / c[2] / (span * aspect), y: 0.5 + c[1] / c[2] / span, z: 0 };
  };

  const centre = project([0, 0, 0]);
  const landmarks: Landmark[] = Array.from({ length: LANDMARK_COUNT }, () => ({ ...centre }));

  const placeEye = (
    side: number,
    cornerA: number,
    cornerB: number,
    upper: number,
    lower: number,
    iris: readonly number[],
  ) => {
    const eyeCentre: V3 = [side * EYE_HALF_GAP, 0, 0];
    const world = toCamera(eyeCentre);
    // The direction from this eye to the target, expressed in the head's own axes.
    const d = unrot([target[0] - world[0], target[1] - world[1], -(target[2] - world[2])]);
    const len = Math.hypot(d[0], d[1], d[2]);
    const ix = (d[0] / len) * EYEBALL_RADIUS;
    const iy = (d[1] / len) * EYEBALL_RADIUS;
    const at = (dx: number, dy: number): Landmark => project([eyeCentre[0] + dx, eyeCentre[1] + dy, 0]);
    landmarks[cornerA] = at(-EYE_HALF_WIDTH, 0);
    landmarks[cornerB] = at(EYE_HALF_WIDTH, 0);
    landmarks[upper] = at(ix * 0.3, (o.blink ? 0.03 : -0.5) + iy * 0.6);
    landmarks[lower] = at(ix * 0.3, (o.blink ? 0.06 : 0.42) + iy * 0.2);
    const r = 0.35;
    landmarks[iris[0]] = at(ix, iy);
    landmarks[iris[1]] = at(ix + r, iy);
    landmarks[iris[2]] = at(ix, iy - r);
    landmarks[iris[3]] = at(ix - r, iy);
    landmarks[iris[4]] = at(ix, iy + r);
  };
  // The subject's right eye is on the image's left: head-frame x negative.
  placeEye(-1, LM.rightOuter, LM.rightInner, LM.rightUpper, LM.rightLower, LM.rightIris);
  placeEye(1, LM.leftInner, LM.leftOuter, LM.leftUpper, LM.leftLower, LM.leftIris);
  landmarks[LM.noseTip] = project([0, 3.5, 3]);

  const frame: LandmarkFrame = { landmarks, aspect, t: o.t ?? 0 };
  if (o.matrix) {
    // Column-major, as MediaPipe gives it: the three head axes, then the head's position.
    const ax = rot([1, 0, 0]);
    const ay = rot([0, 1, 0]);
    const az = rot([0, 0, 1]);
    frame.matrix = [
      ax[0], ax[1], -ax[2], 0,
      ay[0], ay[1], -ay[2], 0,
      az[0], az[1], -az[2], 0,
      head[0], head[1], head[2], 1,
    ];
  }
  return frame;
}
