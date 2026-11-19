import { LANDMARK_COUNT, LM } from '../features.js';
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
  /** Where the synthetic person is looking, in normalized display space. */
  gazeX: number;
  gazeY: number;
  /** Face centre offset in the image, head turn, head roll (radians) and size. */
  headX?: number;
  headY?: number;
  yaw?: number;
  roll?: number;
  scale?: number;
  /** Eyes closed. */
  blink?: boolean;
  /** Landmark jitter, as a fraction of the eye width. A real webcam gives roughly 0.01 to 0.03. */
  noise?: number;
  random?: () => number;
  aspect?: number;
  t?: number;
}

/**
 * A face mesh for a simple model eye: the iris slides inside the eye opening in proportion to where
 * the person looks (with a little curvature, as a real eye has), and the head can sit anywhere in
 * the image. Only the landmarks the tracker reads are meaningful; the rest sit at the face centre.
 * It lets the whole pipeline, calibration included, be exercised without a camera.
 */
export function syntheticFace(o: SyntheticFaceOptions): LandmarkFrame {
  const aspect = o.aspect ?? 16 / 9;
  const scale = o.scale ?? 0.14;
  const roll = o.roll ?? 0;
  const yaw = o.yaw ?? 0;
  const random = o.random ?? Math.random;
  const centre = { x: (0.5 + (o.headX ?? 0)) * aspect, y: 0.45 + (o.headY ?? 0) };
  const ax = { x: Math.cos(roll), y: Math.sin(roll) };
  const ay = { x: -ax.y, y: ax.x };
  const w = scale * 0.42;
  const jitter = () => (o.noise ? (random() - 0.5) * 2 * o.noise * w : 0);

  const at = (base: { x: number; y: number }, u: number, v: number): Landmark => ({
    x: (base.x + ax.x * u + ay.x * v + jitter()) / aspect,
    y: base.y + ax.y * u + ay.y * v + jitter(),
    z: 0,
  });

  const landmarks: Landmark[] = Array.from({ length: LANDMARK_COUNT }, () => ({
    x: centre.x / aspect,
    y: centre.y,
    z: 0,
  }));

  const gx = o.gazeX - 0.5;
  const gy = o.gazeY - 0.5;
  // Looking toward the screen's right moves the iris toward image-left. A turned head moves it too.
  const irisU = (-0.24 * gx - 0.05 * gx * gx * gx + 0.12 * yaw) * w;
  const irisV = (0.11 * gy + 0.03 * gy * gy * gy - 0.02) * w;
  const upperV = (o.blink ? 0.01 : -0.16) * w + irisV * 0.6;
  const lowerV = (o.blink ? 0.02 : 0.13) * w + irisV * 0.2;
  const irisR = 0.12 * w;

  const placeEye = (
    mid: { x: number; y: number },
    cornerA: number,
    cornerB: number,
    upper: number,
    lower: number,
    iris: readonly number[],
  ) => {
    landmarks[cornerA] = at(mid, -w / 2, 0);
    landmarks[cornerB] = at(mid, w / 2, 0);
    landmarks[upper] = at(mid, irisU * 0.3, upperV);
    landmarks[lower] = at(mid, irisU * 0.3, lowerV);
    landmarks[iris[0]] = at(mid, irisU, irisV);
    landmarks[iris[1]] = at(mid, irisU + irisR, irisV);
    landmarks[iris[2]] = at(mid, irisU, irisV - irisR);
    landmarks[iris[3]] = at(mid, irisU - irisR, irisV);
    landmarks[iris[4]] = at(mid, irisU, irisV + irisR);
  };

  const half = scale / 2;
  const rightMid = { x: centre.x - ax.x * half, y: centre.y - ax.y * half };
  const leftMid = { x: centre.x + ax.x * half, y: centre.y + ax.y * half };
  placeEye(rightMid, LM.rightOuter, LM.rightInner, LM.rightUpper, LM.rightLower, LM.rightIris);
  placeEye(leftMid, LM.leftInner, LM.leftOuter, LM.leftUpper, LM.leftLower, LM.leftIris);
  landmarks[LM.noseTip] = at(centre, yaw * scale, 0.6 * scale);

  return { landmarks, aspect, t: o.t ?? 0 };
}
