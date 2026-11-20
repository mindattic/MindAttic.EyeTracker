import { FEATURE_COUNT, FEATURE_VERSION } from './features.js';
import { addSample, emptyStats, solveStats, type FitStats } from './learning.js';
import { median } from './math/ridge.js';
import { predict, type GazeModel } from './model.js';
import type { CalibrationResult, Point } from './types.js';

interface Target {
  x: number;
  y: number;
  rows: number[][];
  /** The head was moving on purpose during this target, so its samples legitimately differ. */
  headMoving: boolean;
}

/** A target needs at least this many samples to count. */
export const MIN_SAMPLES_PER_TARGET = 5;
/** A moving target (head movement, or a short stretch of following a moving dot) needs only this many. */
export const MIN_SAMPLES_MOVING = 3;
/**
 * Samples taken while something was moving count for this much of a still sample. There are many
 * more of them and each is less certain (the eyes lag a moving dot, and wander during head
 * movement), so they inform the fit without outvoting the still dots.
 */
export const MOVING_WEIGHT = 0.35;
/** A fit needs at least this many usable targets. */
export const MIN_TARGETS = 4;

/**
 * Collects feature vectors while the user looks at known points, then fits a GazeModel.
 * It knows nothing about cameras or screens, so it runs the same in a browser, in Node and in tests.
 */
export class CalibrationSession {
  private targets: Target[] = [];
  private current: Target | null = null;

  get collecting(): boolean {
    return this.current !== null;
  }

  /**
   * Start collecting for a point the user is looking at. Pass `headMoving` for a step where they
   * keep their eyes on the point while turning and moving their head: those samples show the fit
   * how the features change when only the head moves, which is what lets it compensate later.
   */
  beginTarget(x: number, y: number, headMoving = false): void {
    this.endTarget();
    this.current = { x, y, rows: [], headMoving };
  }

  /** Add one frame's feature vector to the target being collected. Ignored between targets. */
  add(phi: number[]): void {
    if (this.current && phi.length === FEATURE_COUNT && phi.every(Number.isFinite)) this.current.rows.push(phi);
  }

  /** Close the current target and return how many samples it got. */
  endTarget(): number {
    const t = this.current;
    this.current = null;
    if (!t) return 0;
    this.targets.push(t);
    return t.rows.length;
  }

  fit(): { model: GazeModel | null; result: CalibrationResult } {
    this.endTarget();
    const usable = this.targets
      .map((t) => ({ ...t, rows: t.headMoving ? t.rows : trimOutliers(t.rows) }))
      .filter((t) => t.rows.length >= (t.headMoving ? MIN_SAMPLES_MOVING : MIN_SAMPLES_PER_TARGET));
    const still = usable.filter((t) => !t.headMoving);
    const samples = usable.reduce((n, t) => n + t.rows.length, 0);
    const fail = (reason: string) => ({
      model: null,
      result: { ok: false, reason, targets: usable.length, samples, fitError: 0, crossError: 0 },
    });
    if (still.length < MIN_TARGETS) {
      return fail(`only ${still.length} of the dots had a visible face and open eyes`);
    }

    const stats = statsOf(usable);
    const weights = modelOf(stats);
    let sq = 0;
    let count = 0;
    for (const t of still) {
      for (const row of t.rows) {
        const p = predict(weights, row);
        sq += (p.x - t.x) ** 2 + (p.y - t.y) ** 2;
        count++;
      }
    }
    const fitError = Math.sqrt(sq / count);

    // Leave each still dot out in turn and predict it from everything else.
    let crossSq = 0;
    for (const held of still) {
      const p = predict(modelOf(statsOf(usable.filter((t) => t !== held))), meanRow(held.rows));
      crossSq += (p.x - held.x) ** 2 + (p.y - held.y) ** 2;
    }
    const crossError = Math.sqrt(crossSq / still.length);
    if (!Number.isFinite(fitError) || !Number.isFinite(crossError)) return fail('the fit did not converge');

    // The sums are kept with the model, so learning can carry on from here.
    const model: GazeModel = { ...weights, createdAt: Date.now(), crossError, stats, learned: 0 };
    return { model, result: { ok: true, targets: usable.length, samples, fitError, crossError } };
  }
}

function statsOf(targets: Target[]): FitStats {
  const stats = emptyStats();
  for (const t of targets) {
    const weight = t.headMoving ? MOVING_WEIGHT : 1;
    for (const row of t.rows) addSample(stats, row, t.x, t.y, weight);
  }
  return stats;
}

function modelOf(stats: FitStats): GazeModel {
  return { version: FEATURE_VERSION, features: FEATURE_COUNT, ...solveStats(stats), createdAt: 0, crossError: 0 };
}

function meanRow(rows: number[][]): number[] {
  const m = new Array<number>(FEATURE_COUNT).fill(0);
  for (const row of rows) for (let i = 0; i < FEATURE_COUNT; i++) m[i] += row[i];
  return m.map((v) => v / rows.length);
}

/**
 * Drop the frames where the eye was still travelling to the target or half-way through a blink:
 * the fifth of the samples whose iris terms sit farthest from the target's median.
 */
function trimOutliers(rows: number[][]): number[][] {
  if (rows.length < 5) return rows;
  const med = [1, 2, 3, 4].map((i) => median(rows.map((r) => r[i])));
  const scored = rows.map((row) => ({
    row,
    d: Math.max(...[1, 2, 3, 4].map((i, k) => Math.abs(row[i] - med[k]))),
  }));
  scored.sort((a, b) => a.d - b.d);
  return scored.slice(0, Math.ceil(rows.length * 0.8)).map((s) => s.row);
}

/**
 * Target layouts, as normalized display points in an order that keeps consecutive targets far
 * apart (so the eye makes a clear jump to each one). 5 is a quick check, 9 the default, 13 the best fit.
 */
export function calibrationPattern(count: 5 | 9 | 13 = 9, margin = 0.08): Point[] {
  const lo = margin;
  const hi = 1 - margin;
  const mid = 0.5;
  const q1 = lo + (hi - lo) * 0.25;
  const q3 = lo + (hi - lo) * 0.75;
  const five: Point[] = [
    { x: mid, y: mid },
    { x: lo, y: lo },
    { x: hi, y: hi },
    { x: hi, y: lo },
    { x: lo, y: hi },
  ];
  if (count === 5) return five;
  const nine: Point[] = [
    ...five,
    { x: mid, y: lo },
    { x: mid, y: hi },
    { x: lo, y: mid },
    { x: hi, y: mid },
  ];
  if (count === 9) return nine;
  return [
    ...nine,
    { x: q1, y: q1 },
    { x: q3, y: q3 },
    { x: q3, y: q1 },
    { x: q1, y: q3 },
  ];
}
