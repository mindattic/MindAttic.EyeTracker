/**
 * Steadies the gaze point while the eyes rest on one spot.
 *
 * Every estimate carries random error, so a fixed gaze shows up as a cloud of points around the
 * true spot. The centre of that cloud is a far better answer than any one point in it. While the
 * eyes stay put, this filter reports the running average of the estimates, which settles on the
 * centre and gets steadier the longer the look lasts.
 *
 * To tell a real eye movement from the cloud's own scatter it never trusts one estimate. It keeps
 * the average of the last few and compares that with the long average: a handful of estimates
 * that all sit somewhere else means the eyes have moved, and the filter starts again from there.
 * One wild estimate moves the short average only a little and is ignored.
 *
 * How far "somewhere else" is, is not a fixed distance. The filter measures how wide the cloud
 * actually is and sets the bar at a few times the scatter the short average would show by chance.
 * So with a clean signal it notices small eye movements, and with a noisy one it holds steady.
 */
export interface FixationOptions {
  /**
   * The smallest shift (in display units) ever treated as an eye movement, however clean the
   * signal. The working threshold is the larger of this and `sigmas` times the measured scatter.
   */
  radius: number;
  /** How many standard deviations of the recent average count as a real movement. */
  sigmas: number;
  /**
   * The most estimates in the long average. A long window is steadier; a short one follows a
   * slowly moving gaze (watching a moving thing) more closely. At 30 frames a second, 15 is half a second.
   */
  window: number;
  /** How many of the latest estimates make up the recent average. */
  recent: number;
}

export const DEFAULT_FIXATION: FixationOptions = { radius: 0.006, sigmas: 3, window: 15, recent: 4 };

export class FixationFilter {
  private cx = 0;
  private cy = 0;
  private count = 0;
  private readonly rx: number[] = [];
  private readonly ry: number[] = [];
  /** Running mean of the squared distance of single estimates from the long average. */
  private scatter2 = 0.02 * 0.02;
  /** True while the output is the average of a steady look. */
  fixating = false;

  constructor(public options: FixationOptions = DEFAULT_FIXATION) {}

  reset(): void {
    this.count = 0;
    this.rx.length = 0;
    this.ry.length = 0;
    this.fixating = false;
  }

  /** The shift that currently counts as an eye movement. */
  get threshold(): number {
    const o = this.options;
    return Math.max(o.radius, (o.sigmas * Math.sqrt(this.scatter2)) / Math.sqrt(o.recent));
  }

  filter(x: number, y: number): { x: number; y: number } {
    const o = this.options;
    this.rx.push(x);
    this.ry.push(y);
    if (this.rx.length > o.recent) {
      this.rx.shift();
      this.ry.shift();
    }
    if (this.count === 0) {
      this.cx = x;
      this.cy = y;
      this.count = 1;
      return { x, y };
    }

    let sx = 0;
    let sy = 0;
    for (let i = 0; i < this.rx.length; i++) {
      sx += this.rx[i];
      sy += this.ry[i];
    }
    sx /= this.rx.length;
    sy /= this.rx.length;
    const limit = this.threshold;
    // The eyes have moved when the recent estimates, taken together, sit somewhere else. A single
    // estimate far beyond anything the scatter explains is believed at once.
    const drift = Math.hypot(sx - this.cx, sy - this.cy);
    const latest = Math.hypot(x - this.cx, y - this.cy);
    const full = this.rx.length >= o.recent;
    const leap = latest > limit * 4 && drift > limit;
    if ((full && drift > limit) || leap) {
      // Start the new look from the estimates that are already there, not from the old spot.
      const from = leap ? { x, y } : { x: sx, y: sy };
      this.cx = from.x;
      this.cy = from.y;
      this.count = leap ? 1 : this.rx.length;
      if (leap) {
        this.rx.length = 0;
        this.ry.length = 0;
        this.rx.push(x);
        this.ry.push(y);
      }
      this.fixating = false;
      return { x: this.cx, y: this.cy };
    }

    // Still the same look: learn how wide its cloud is, and fold the estimate into the average.
    this.scatter2 += (latest * latest - this.scatter2) * 0.04;
    this.count = Math.min(this.count + 1, o.window);
    this.cx += (x - this.cx) / this.count;
    this.cy += (y - this.cy) / this.count;
    this.fixating = this.count >= 4;
    return { x: this.cx, y: this.cy };
  }
}
