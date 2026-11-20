import { FEATURE_COUNT, FEATURE_PENALTY } from './features.js';
import { solveLinear } from './math/ridge.js';

/**
 * Everything a fit needs to remember about the samples it was made from: the sums the regression
 * is solved from, not the samples themselves. Because they are sums, new samples can be added at
 * any time and the model solved again, which is how the tracker keeps learning after calibration.
 * It is small (a few hundred numbers) and is stored with the model.
 */
export interface FitStats {
  /** Total weight of the samples added. */
  n: number;
  /** Sum of weight * feature * feature, as a flattened FEATURE_COUNT by FEATURE_COUNT matrix. */
  a: number[];
  /** Sum of weight * feature * target, for x and for y. */
  bx: number[];
  by: number[];
}

export function emptyStats(): FitStats {
  return {
    n: 0,
    a: new Array<number>(FEATURE_COUNT * FEATURE_COUNT).fill(0),
    bx: new Array<number>(FEATURE_COUNT).fill(0),
    by: new Array<number>(FEATURE_COUNT).fill(0),
  };
}

/** Add one sample: the user was looking at (x, y) when the features were `phi`. */
export function addSample(stats: FitStats, phi: ArrayLike<number>, x: number, y: number, weight = 1): void {
  const d = FEATURE_COUNT;
  for (let i = 0; i < d; i++) {
    const wi = weight * phi[i];
    stats.bx[i] += wi * x;
    stats.by[i] += wi * y;
    const row = i * d;
    for (let j = 0; j < d; j++) stats.a[row + j] += wi * phi[j];
  }
  stats.n += weight;
}

/** Solve the ridge regression the sums describe. The same answer as fitting all the samples at once. */
export function solveStats(stats: FitStats): { wx: number[]; wy: number[] } {
  const d = FEATURE_COUNT;
  const n = Math.max(stats.n, 1e-9);
  const system = () => {
    const m: number[][] = [];
    for (let i = 0; i < d; i++) {
      const row = new Array<number>(d);
      for (let j = 0; j < d; j++) row[j] = stats.a[i * d + j] / n;
      row[i] += FEATURE_PENALTY[i];
      m.push(row);
    }
    return m;
  };
  return {
    wx: solveLinear(system(), stats.bx.map((v) => v / n)),
    wy: solveLinear(system(), stats.by.map((v) => v / n)),
  };
}

export function isValidStats(s: unknown): s is FitStats {
  const t = s as FitStats | null;
  return (
    !!t &&
    Number.isFinite(t.n) &&
    Array.isArray(t.a) &&
    t.a.length === FEATURE_COUNT * FEATURE_COUNT &&
    Array.isArray(t.bx) &&
    t.bx.length === FEATURE_COUNT &&
    Array.isArray(t.by) &&
    t.by.length === FEATURE_COUNT &&
    t.a.every(Number.isFinite) &&
    t.bx.every(Number.isFinite) &&
    t.by.every(Number.isFinite)
  );
}
