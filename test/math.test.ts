import { describe, expect, it } from 'vitest';
import { OneEuroFilter } from '../src/filters/oneEuro.js';
import { median, ridgeFit, solveLinear } from '../src/math/ridge.js';
import { seededRandom } from '../src/testing/syntheticFace.js';

describe('solveLinear', () => {
  it('solves a small system', () => {
    const w = solveLinear(
      [
        [2, 1],
        [1, 3],
      ],
      [5, 10],
    );
    expect(w[0]).toBeCloseTo(1, 10);
    expect(w[1]).toBeCloseTo(3, 10);
  });

  it('leaves the weight of an unobserved feature at zero instead of dividing by zero', () => {
    const w = solveLinear(
      [
        [1, 0],
        [0, 0],
      ],
      [4, 0],
    );
    expect(w).toEqual([4, 0]);
  });
});

describe('ridgeFit', () => {
  it('recovers a linear relation when the penalty is tiny', () => {
    const random = seededRandom(1);
    const rows: number[][] = [];
    const ys: number[] = [];
    for (let i = 0; i < 200; i++) {
      const a = random() * 2 - 1;
      const b = random() * 2 - 1;
      rows.push([1, a, b]);
      ys.push(0.5 + 2 * a - 3 * b);
    }
    const w = ridgeFit(rows, ys, [0, 1e-9, 1e-9]);
    expect(w[0]).toBeCloseTo(0.5, 4);
    expect(w[1]).toBeCloseTo(2, 4);
    expect(w[2]).toBeCloseTo(-3, 4);
  });

  it('shrinks a feature harder the larger its penalty', () => {
    const rows = [
      [1, 1],
      [1, -1],
      [1, 2],
      [1, -2],
    ];
    const ys = [1, -1, 2, -2];
    const loose = ridgeFit(rows, ys, [0, 1e-6]);
    const tight = ridgeFit(rows, ys, [0, 10]);
    expect(loose[1]).toBeCloseTo(1, 3);
    expect(Math.abs(tight[1])).toBeLessThan(0.3);
  });

  it('throws when there is nothing to fit', () => {
    expect(() => ridgeFit([], [], [0])).toThrow();
  });
});

describe('median', () => {
  it('handles odd, even and empty lists', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe('OneEuroFilter', () => {
  it('returns the first value unchanged', () => {
    expect(new OneEuroFilter().filter(0.3, 0)).toBe(0.3);
  });

  it('reduces jitter on a still signal', () => {
    const random = seededRandom(2);
    const f = new OneEuroFilter();
    let rawSpread = 0;
    let outSpread = 0;
    for (let i = 0; i < 300; i++) {
      const noisy = 0.5 + (random() - 0.5) * 0.1;
      const out = f.filter(noisy, i * 33);
      if (i > 60) {
        rawSpread += Math.abs(noisy - 0.5);
        outSpread += Math.abs(out - 0.5);
      }
    }
    expect(outSpread).toBeLessThan(rawSpread * 0.5);
  });

  it('catches up with a jump within a quarter of a second', () => {
    const f = new OneEuroFilter();
    for (let i = 0; i < 30; i++) f.filter(0.1, i * 33);
    let out = 0;
    for (let i = 30; i < 38; i++) out = f.filter(0.9, i * 33);
    expect(out).toBeGreaterThan(0.8);
  });

  it('starts over after reset', () => {
    const f = new OneEuroFilter();
    f.filter(0.1, 0);
    f.reset();
    expect(f.filter(0.9, 33)).toBe(0.9);
  });
});
