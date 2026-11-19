/**
 * One Euro filter (Casiez, Roussel, Vogel 2012): a low-pass filter whose cutoff rises with speed,
 * so a still gaze is steady and a saccade is not dragged behind.
 */
export interface OneEuroOptions {
  /** Cutoff in Hz when the signal is still. Lower is steadier and laggier. */
  minCutoff: number;
  /** How fast the cutoff grows with speed. Higher follows fast movement more closely. */
  beta: number;
  /** Cutoff in Hz for the speed estimate. */
  dCutoff: number;
}

export const DEFAULT_ONE_EURO: OneEuroOptions = { minCutoff: 0.9, beta: 2.0, dCutoff: 1.0 };

export class OneEuroFilter {
  private x: number | null = null;
  private dx = 0;
  private lastT = 0;

  constructor(public options: OneEuroOptions = DEFAULT_ONE_EURO) {}

  reset(): void {
    this.x = null;
    this.dx = 0;
  }

  /** `tMs` is the sample time in milliseconds. */
  filter(value: number, tMs: number): number {
    if (this.x === null) {
      this.x = value;
      this.lastT = tMs;
      return value;
    }
    const dt = Math.max((tMs - this.lastT) / 1000, 1e-3);
    this.lastT = tMs;
    const rawDx = (value - this.x) / dt;
    this.dx += alpha(this.options.dCutoff, dt) * (rawDx - this.dx);
    const cutoff = this.options.minCutoff + this.options.beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

function alpha(cutoffHz: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dt);
}
