import { describe, expect, it } from 'vitest';
import { CalibrationSession, calibrationPattern } from '../src/calibration.js';
import { FEATURE_COUNT, FEATURE_PENALTY, extractFeatures, featureVector } from '../src/features.js';
import { builtInModel, isValidModel, predict, type GazeModel } from '../src/model.js';
import { GazePipeline } from '../src/pipeline.js';
import { seededRandom, syntheticFace, type SyntheticFaceOptions } from '../src/testing/syntheticFace.js';

type Scene = Partial<SyntheticFaceOptions>;

/** A head pose somewhere within normal fidgeting range of the resting position. */
function movedPose(random: () => number): Scene {
  return {
    headXCm: (random() - 0.5) * 14,
    headYCm: 12 + (random() - 0.5) * 8,
    distanceCm: 55 + (random() - 0.5) * 20,
    yaw: (random() - 0.5) * 0.5,
    pitch: (random() - 0.5) * 0.3,
    roll: (random() - 0.5) * 0.25,
  };
}

function vector(gazeX: number, gazeY: number, scene: Scene): number[] {
  return featureVector(extractFeatures(syntheticFace({ gazeX, gazeY, ...scene }))!);
}

/** Nine dots with a still head, then (optionally) the head-movement steps the calibration screen runs. */
function calibrate(scene: Scene, options: { headMovement: boolean; noise?: number; seed?: number }) {
  const random = seededRandom(options.seed ?? 11);
  const noise = options.noise ?? 0.01;
  const session = new CalibrationSession();
  for (const p of calibrationPattern(9)) {
    session.beginTarget(p.x, p.y);
    for (let i = 0; i < 27; i++) {
      session.add(vector(p.x, p.y, { ...scene, noise, random, headXCm: random() - 0.5, yaw: (random() - 0.5) * 0.03 }));
    }
    session.endTarget();
  }
  if (options.headMovement) {
    for (const [x, y, count] of [
      [0.5, 0.5, 180],
      [0.18, 0.22, 120],
      [0.82, 0.78, 120],
    ]) {
      session.beginTarget(x, y, true);
      for (let i = 0; i < count; i++) session.add(vector(x, y, { ...scene, noise, random, ...movedPose(random) }));
      session.endTarget();
    }
  }
  return { ...session.fit(), random, noise };
}

/** Root-mean-square error over random targets, as a fraction of the screen. */
function errorOf(model: GazeModel, scene: Scene, random: () => number, noise: number, moving: boolean): number {
  let sq = 0;
  const trials = 300;
  for (let i = 0; i < trials; i++) {
    const gx = 0.05 + random() * 0.9;
    const gy = 0.05 + random() * 0.9;
    const pose = moving ? movedPose(random) : {};
    const p = predict(model, vector(gx, gy, { ...scene, ...pose, noise, random }));
    sq += (p.x - gx) ** 2 + (p.y - gy) ** 2;
  }
  return Math.sqrt(sq / trials);
}

const MATRIX: Scene = { matrix: true };

describe('extractFeatures', () => {
  it('returns null for a mesh without iris points', () => {
    expect(extractFeatures({ landmarks: new Array(468).fill({ x: 0.5, y: 0.5 }), aspect: 1, t: 0 })).toBeNull();
  });

  it('moves the iris feature toward image-left when the gaze moves right', () => {
    const left = extractFeatures(syntheticFace({ gazeX: 0.1, gazeY: 0.5 }))!;
    const right = extractFeatures(syntheticFace({ gazeX: 0.9, gazeY: 0.5 }))!;
    expect(right.right.x).toBeLessThan(left.right.x);
    expect(right.left.x).toBeLessThan(left.left.x);
  });

  it('moves the iris feature down when the gaze moves down', () => {
    const up = extractFeatures(syntheticFace({ gazeX: 0.5, gazeY: 0.1 }))!;
    const down = extractFeatures(syntheticFace({ gazeX: 0.5, gazeY: 0.9 }))!;
    expect(down.right.y).toBeGreaterThan(up.right.y);
  });

  it('reads distance and roll from the landmarks alone', () => {
    const f = extractFeatures(syntheticFace({ gazeX: 0.5, gazeY: 0.5, distanceCm: 70, roll: 0.2 }))!;
    expect(f.dist).toBeGreaterThan(63);
    expect(f.dist).toBeLessThan(77);
    expect(f.roll).toBeCloseTo(0.2, 1);
  });

  it('takes the head point and distance from the pose matrix when there is one', () => {
    const f = extractFeatures(syntheticFace({ gazeX: 0.5, gazeY: 0.5, headXCm: 8, headYCm: 10, distanceCm: 60, matrix: true }))!;
    // Facing straight at the camera plane: the head points at the spot directly in front of it.
    expect(f.dist).toBeCloseTo(60, 6);
    expect(f.hx).toBeCloseTo(8, 6);
    expect(f.hy).toBeCloseTo(10, 6);
  });

  it('moves the head point when the head turns, without the head moving', () => {
    const ahead = extractFeatures(syntheticFace({ gazeX: 0.5, gazeY: 0.5, matrix: true }))!;
    const turned = extractFeatures(syntheticFace({ gazeX: 0.5, gazeY: 0.5, yaw: 0.3, matrix: true }))!;
    expect(Math.abs(turned.hx - ahead.hx)).toBeGreaterThan(10);
    expect(turned.hy).toBeCloseTo(ahead.hy, 6);
  });

  it('reads a row-major matrix the same as a column-major one', () => {
    const frame = syntheticFace({ gazeX: 0.3, gazeY: 0.6, yaw: 0.2, pitch: -0.1, headXCm: 5, matrix: true });
    const m = frame.matrix!;
    const rowMajor = [m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14], m[3], m[7], m[11], m[15]];
    const a = extractFeatures(frame)!;
    const b = extractFeatures({ ...frame, matrix: rowMajor })!;
    expect(b.hx).toBeCloseTo(a.hx, 9);
    expect(b.hy).toBeCloseTo(a.hy, 9);
    expect(b.dist).toBeCloseTo(a.dist, 9);
  });
});

describe('featureVector', () => {
  it('matches FEATURE_COUNT and the penalty list', () => {
    const phi = vector(0.5, 0.5, {});
    expect(phi).toHaveLength(FEATURE_COUNT);
    expect(FEATURE_PENALTY).toHaveLength(FEATURE_COUNT);
    expect(phi[0]).toBe(1);
    expect(phi.every(Number.isFinite)).toBe(true);
  });
});

describe('built-in model', () => {
  it('puts the gaze on the correct side of the screen with no calibration', () => {
    const m = builtInModel();
    const at = (x: number, y: number) => predict(m, vector(x, y, {}));
    expect(at(0.9, 0.5).x).toBeGreaterThan(at(0.1, 0.5).x);
    expect(at(0.5, 0.9).y).toBeGreaterThan(at(0.5, 0.1).y);
  });

  it('is a valid model; a truncated one or one from an older feature layout is not', () => {
    const m = builtInModel();
    expect(isValidModel(m)).toBe(true);
    expect(isValidModel({ ...m, wx: m.wx.slice(1) })).toBe(false);
    expect(isValidModel({ ...m, version: m.version - 1 })).toBe(false);
    expect(isValidModel(null)).toBe(false);
  });
});

describe('calibration with a still head', () => {
  it('fits nine dots and predicts unseen points to within a few percent', () => {
    const { model, result, random, noise } = calibrate(MATRIX, { headMovement: false });
    expect(result.ok).toBe(true);
    expect(result.targets).toBe(9);
    expect(isValidModel(model)).toBe(true);
    expect(errorOf(model!, MATRIX, random, noise, false)).toBeLessThan(0.05);
  });

  it('fails with a reason when too few targets had samples', () => {
    const session = new CalibrationSession();
    session.beginTarget(0.5, 0.5);
    session.endTarget();
    const { model, result } = session.fit();
    expect(model).toBeNull();
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/targets/);
  });

  it('ignores samples offered between targets and malformed vectors', () => {
    const session = new CalibrationSession();
    session.add(new Array(FEATURE_COUNT).fill(0));
    session.beginTarget(0.5, 0.5);
    session.add([1, 2, 3]);
    session.add(new Array(FEATURE_COUNT).fill(Number.NaN));
    expect(session.endTarget()).toBe(0);
  });

  it('is not thrown off by a few frames taken while the eye was still moving', () => {
    const random = seededRandom(3);
    const session = new CalibrationSession();
    for (const p of calibrationPattern(9)) {
      session.beginTarget(p.x, p.y);
      for (let i = 0; i < 25; i++) {
        // The first four frames of every target still look at the screen centre.
        const look = i < 4 ? { x: 0.5, y: 0.5 } : p;
        session.add(vector(look.x, look.y, { ...MATRIX, noise: 0.005, random, headXCm: random() - 0.5 }));
      }
    }
    const { model } = session.fit();
    expect(errorOf(model!, MATRIX, random, 0.005, false)).toBeLessThan(0.05);
  });
});

describe('camera placement', () => {
  const placements: Array<[string, Scene]> = [
    ['above the screen, centred', { cameraX: 0.5, cameraY: -0.03 }],
    ['at the bottom-left corner, tilted up', { cameraX: 0.05, cameraY: 1.05, cameraTilt: -0.25 }],
    ['off the right-hand side', { cameraX: 1.1, cameraY: 0.4 }],
  ];

  it.each(placements)('needs no knowledge of a camera %s', (_name, placement) => {
    const scene = { ...MATRIX, ...placement };
    const { model, random, noise } = calibrate(scene, { headMovement: true });
    expect(errorOf(model!, scene, random, noise, false)).toBeLessThan(0.07);
  });

  it('copes with a head that rests well off the camera axis', () => {
    const scene = { ...MATRIX, headXCm: 20, headYCm: 20 };
    const { model, random, noise } = calibrate(scene, { headMovement: false });
    expect(errorOf(model!, scene, random, noise, false)).toBeLessThan(0.06);
  });
});

describe('head movement', () => {
  it('is compensated once the calibration has seen the head move', () => {
    const { model, random, noise } = calibrate(MATRIX, { headMovement: true });
    expect(errorOf(model!, MATRIX, random, noise, true)).toBeLessThan(0.06);
  });

  it('is much better compensated with the head-movement step than without it', () => {
    const without = calibrate(MATRIX, { headMovement: false });
    const withStep = calibrate(MATRIX, { headMovement: true });
    const before = errorOf(without.model!, MATRIX, without.random, without.noise, true);
    const after = errorOf(withStep.model!, MATRIX, withStep.random, withStep.noise, true);
    expect(after).toBeLessThan(before * 0.6);
  });

  it('keeps every sample of a head-movement step instead of trimming them as outliers', () => {
    const random = seededRandom(5);
    const session = new CalibrationSession();
    session.beginTarget(0.5, 0.5, true);
    for (let i = 0; i < 50; i++) session.add(vector(0.5, 0.5, { ...MATRIX, ...movedPose(random) }));
    expect(session.endTarget()).toBe(50);
    for (const p of calibrationPattern(5)) {
      session.beginTarget(p.x, p.y);
      for (let i = 0; i < 20; i++) session.add(vector(p.x, p.y, MATRIX));
    }
    // Five dots keep 16 of 20 samples each (the trim); the head-movement step keeps all 50.
    expect(session.fit().result.samples).toBe(50 + 5 * 16);
  });
});

describe('calibrationPattern', () => {
  it.each([5, 9, 13] as const)('gives %i distinct points inside the display', (n) => {
    const points = calibrationPattern(n);
    expect(points).toHaveLength(n);
    expect(new Set(points.map((p) => `${p.x},${p.y}`)).size).toBe(n);
    for (const p of points) {
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(1);
      expect(p.y).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(1);
    }
  });
});

describe('GazePipeline', () => {
  it('reports no face with zero confidence and holds the last point', () => {
    const pipeline = new GazePipeline();
    const seen = pipeline.process(syntheticFace({ gazeX: 0.8, gazeY: 0.2, t: 0 }));
    const lost = pipeline.process(null, 33);
    expect(lost.face).toBe(false);
    expect(lost.confidence).toBe(0);
    expect(lost.x).toBe(seen.x);
  });

  it('flags a blink and does not move the gaze point during it', () => {
    const pipeline = new GazePipeline();
    let open = pipeline.process(syntheticFace({ gazeX: 0.3, gazeY: 0.3, t: 0 }));
    for (let i = 1; i < 10; i++) open = pipeline.process(syntheticFace({ gazeX: 0.3, gazeY: 0.3, t: i * 33 }));
    const shut = pipeline.process(syntheticFace({ gazeX: 0.3, gazeY: 0.3, blink: true, t: 340 }));
    expect(shut.blink).toBe(true);
    expect(shut.confidence).toBe(0);
    expect(shut.x).toBe(open.x);
    expect(pipeline.lastVector).toBeNull();
  });

  it('clamps the smoothed point to the display but leaves the raw estimate free', () => {
    const { model } = calibrate(MATRIX, { headMovement: false, noise: 0 });
    const pipeline = new GazePipeline();
    pipeline.model = model;
    const g = pipeline.process(syntheticFace({ gazeX: 1.3, gazeY: 0.5, matrix: true, t: 0 }));
    expect(g.x).toBeLessThanOrEqual(1);
    expect(g.rawX).toBeGreaterThan(1);
    expect(g.calibrated).toBe(true);
  });
});
