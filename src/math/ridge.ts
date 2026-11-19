/**
 * Ridge regression solved by the normal equations: (X'X / n + diag(penalty)) w = X'y / n.
 * A per-feature penalty lets weakly observed features (head pose during a still calibration)
 * stay near zero instead of soaking up noise.
 */
export function ridgeFit(rows: number[][], targets: number[], penalty: number[]): number[] {
  const n = rows.length;
  const d = penalty.length;
  if (n === 0) throw new Error('ridgeFit: no samples');
  const a: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  const b = new Array<number>(d).fill(0);
  for (let r = 0; r < n; r++) {
    const row = rows[r];
    const y = targets[r];
    for (let i = 0; i < d; i++) {
      const ri = row[i];
      b[i] += ri * y;
      const ai = a[i];
      for (let j = i; j < d; j++) ai[j] += ri * row[j];
    }
  }
  for (let i = 0; i < d; i++) {
    b[i] /= n;
    for (let j = i; j < d; j++) {
      a[i][j] /= n;
      a[j][i] = a[i][j];
    }
    a[i][i] += penalty[i];
  }
  return solveLinear(a, b);
}

/** Gaussian elimination with partial pivoting. `a` and `b` are overwritten. */
export function solveLinear(a: number[][], b: number[]): number[] {
  const d = b.length;
  for (let col = 0; col < d; col++) {
    let pivot = col;
    for (let r = col + 1; r < d; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (Math.abs(a[pivot][col]) < 1e-12) {
      // A feature that never varied and has no penalty: leave its weight at zero.
      for (let r = 0; r < d; r++) a[r][col] = 0;
      for (let j = 0; j < d; j++) a[col][j] = 0;
      a[col][col] = 1;
      b[col] = 0;
      continue;
    }
    if (pivot !== col) {
      [a[pivot], a[col]] = [a[col], a[pivot]];
      [b[pivot], b[col]] = [b[col], b[pivot]];
    }
    for (let r = col + 1; r < d; r++) {
      const f = a[r][col] / a[col][col];
      if (f === 0) continue;
      for (let j = col; j < d; j++) a[r][j] -= f * a[col][j];
      b[r] -= f * b[col];
    }
  }
  const w = new Array<number>(d).fill(0);
  for (let i = d - 1; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < d; j++) s -= a[i][j] * w[j];
    w[i] = s / a[i][i];
  }
  return w;
}

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((p, q) => p - q);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
