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
 */
export interface FixationOptions {
  /**
   * How far (in display units) the recent average must be from the long one before the eyes are
   * taken to have moved. Larger is steadier but slower to notice a small eye movement.
   */
  radius: number;
  /**
   * The most estimates in the long average. A long window is steadier; a short one follows a
   * slowly moving gaze (watching a moving thing) more closely. At 30 frames a second, 30 is one second.
   */
  window: number;
  /** How many of the latest estimates make up the recent average. */
  recent: number;
}

export const DEFAULT_FIXATION: FixationOptions = { radius: 0.06, window: 30, recent: 4 };

export class FixationFilter {
  private cx = 0;
  private cy = 0;
  private count = 0;
  private readonly rx: number[] = [];
  private readonly ry: number[] = [];
  /** True while the output is the average of a steady look. */
  fixating = false;

  constructor(public options: FixationOptions = DEFAULT_FIXATION) {}

  reset(): void {
    this.count = 0;
    this.rx.length = 0;
    this.ry.length = 0;
    this.fixating = false;
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
    // The eyes have moved when the recent estimates, taken together, sit somewhere else. The bar
    // is lower when the latest estimate is itself far away, so a clean jump is caught on the spot.
    const drift = Math.hypot(sx - this.cx, sy - this.cy);
    const latest = Math.hypot(x - this.cx, y - this.cy);
    const full = this.rx.length >= o.recent;
    if ((full && drift > o.radius) || (latest > o.radius * 4 && drift > o.radius)) {
      // Start the new look from the estimates that are already there, not from the old spot.
      const from = latest > o.radius * 4 ? { x, y } : { x: sx, y: sy };
      this.cx = from.x;
      this.cy = from.y;
      this.count = 1;
      this.rx.length = 0;
      this.ry.length = 0;
      this.rx.push(x);
      this.ry.push(y);
      this.fixating = false;
      return { x: this.cx, y: this.cy };
    }

    this.count = Math.min(this.count + 1, o.window);
    this.cx += (x - this.cx) / this.count;
    this.cy += (y - this.cy) / this.count;
    this.fixating = this.count >= 4;
    return { x: this.cx, y: this.cy };
  }
}
