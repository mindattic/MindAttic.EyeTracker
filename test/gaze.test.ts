import { describe, expect, it } from 'vitest';
import { CalibrationSession, calibrationPattern } from '../src/calibration.js';
import { FEATURE_COUNT, FEATURE_PENALTY, extractFeatures, featureVector } from '../src/features.js';
import { builtInModel, isValidModel, predict } from '../src/model.js';
import { GazePipeline } from '../src/pipeline.js';
import { seededRandom, syntheticFace } from '../src/testing/syntheticFace.js';

function calibrate(points: 5 | 9 | 13, noise: number, seed = 7) {
  const random = seededRandom(seed);
  const session = new CalibrationSession();
  for (const p of calibrationPattern(points)) {
    session.beginTarget(p.x, p.y);
    for (let i = 0; i < 27; i++) {
      const frame = syntheticFace({ gazeX: p.x, gazeY: p.y, noise, random, headX: (random() - 0.5) * 0.03 });
      session.add(featureVector(extractFeatures(frame)!));
    }
    session.endTarget();
  }
  return { ...session.fit(), random };
}

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

  it('gives the same eye features wherever the face sits, however large and however rolled', () => {
    const a = extractFeatures(syntheticFace({ gazeX: 0.7, gazeY: 0.3 }))!;
    const b = extractFeatures(syntheticFace({ gazeX: 0.7, gazeY: 0.3, headX: 0.2, headY: -0.1, scale: 0.22, roll: 0.3 }))!;
    expect(b.right.x).toBeCloseTo(a.right.x, 6);
    expect(b.left.y).toBeCloseTo(a.left.y, 6);
    expect(b.roll).toBeCloseTo(0.3, 6);
    expect(b.scale).toBeCloseTo(0.22, 6);
  });

  it('does not depend on the camera aspect ratio', () => {
    const wide = extractFeatures(syntheticFace({ gazeX: 0.2, gazeY: 0.8, aspect: 16 / 9 }))!;
    const tall = extractFeatures(syntheticFace({ gazeX: 0.2, gazeY: 0.8, aspect: 3 / 4 }))!;
    expect(tall.left.x).toBeCloseTo(wide.left.x, 6);
  });
});

describe('featureVector', () => {
  it('matches FEATURE_COUNT and the penalty list', () => {
    const phi = featureVector(extractFeatures(syntheticFace({ gazeX: 0.5, gazeY: 0.5 }))!);
    expect(phi).toHaveLength(FEATURE_COUNT);
    expect(FEATURE_PENALTY).toHaveLength(FEATURE_COUNT);
    expect(phi[0]).toBe(1);
  });
});

describe('built-in model', () => {
  it('puts the gaze on the correct side of the screen with no calibration', () => {
    const m = builtInModel();
    const at = (x: number, y: number) => predict(m, featureVector(extractFeatures(syntheticFace({ gazeX: x, gazeY: y }))!));
    expect(at(0.9, 0.5).x).toBeGreaterThan(at(0.1, 0.5).x);
    expect(at(0.5, 0.9).y).toBeGreaterThan(at(0.5, 0.1).y);
  });

  it('is a valid model, and a truncated one is not', () => {
    const m = builtInModel();
    expect(isValidModel(m)).toBe(true);
    expect(isValidModel({ ...m, wx: m.wx.slice(1) })).toBe(false);
    expect(isValidModel(null)).toBe(false);
  });
});

describe('CalibrationSession', () => {
  it('fits a clean nine-point calibration to within one percent of the screen', () => {
    const { model, result } = calibrate(9, 0);
    expect(result.ok).toBe(true);
    expect(result.targets).toBe(9);
    expect(result.fitError).toBeLessThan(0.01);
    expect(result.crossError).toBeLessThan(0.01);
    expect(isValidModel(model)).toBe(true);
  });

  it('predicts unseen points with webcam-level noise to within a few percent', () => {
    const { model, random } = calibrate(9, 0.01);
    const pipeline = new GazePipeline();
    pipeline.model = model;
    let sq = 0;
    const trials = 200;
    for (let i = 0; i < trials; i++) {
      const gx = random();
      const gy = random();
      pipeline.reset();
      let g = pipeline.process(null, 0);
      for (let j = 0; j < 20; j++) {
        g = pipeline.process(syntheticFace({ gazeX: gx, gazeY: gy, noise: 0.01, random, t: j * 33 }));
      }
      sq += (g.x - gx) ** 2 + (g.y - gy) ** 2;
    }
    expect(Math.sqrt(sq / trials)).toBeLessThan(0.04);
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
        const look = i < 4 ? { gazeX: 0.5, gazeY: 0.5 } : { gazeX: p.x, gazeY: p.y };
        session.add(featureVector(extractFeatures(syntheticFace({ ...look, noise: 0.005, random }))!));
      }
    }
    expect(session.fit().result.crossError).toBeLessThan(0.03);
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
    const { model } = calibrate(9, 0);
    const pipeline = new GazePipeline();
    pipeline.model = model;
    const g = pipeline.process(syntheticFace({ gazeX: 1.3, gazeY: 0.5, t: 0 }));
    expect(g.x).toBeLessThanOrEqual(1);
    expect(g.rawX).toBeGreaterThan(1);
    expect(g.calibrated).toBe(true);
  });
});
