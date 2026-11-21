import { Emitter } from './emitter.js';
import { epochClock, spoken, type EventCategory, type WebcamEvent } from './events.js';
import type { GazeRegionSample } from './headpose.js';

/**
 * Reading-pattern detector. Reading a line of text moves the eyes in a recognisable way: a slow,
 * steady sweep along the line, then a quick jump back to the start of the next one, over and over.
 * When that happens repeatedly while the person is looking toward ONE off-screen region (a second
 * monitor, notes beside the keyboard), it is the best signal a webcam gives for "reading
 * something that is not the exam". It is still only a signal: it says what the eyes did, not why.
 *
 * It consumes the samples of a HeadPoseMonitor. It never looks at pixels.
 */
export interface ReadingPatternOptions {
  /** Look back this far for sweeps. */
  windowMs: number;
  /** Sweep-and-return cycles needed before it is reported. */
  minCycles: number;
  /** The smallest sweep, in degrees of yaw, that counts as a line. */
  minSweepDeg: number;
  /** The slowest a sweep may be to count as reading rather than a deliberate look, in degrees per second (and no faster). */
  maxSweepSpeedDegPerSec: number;
  /** A sweep must last at least this long. */
  minSweepMs: number;
  /** The return jump must be at least this many times faster than the sweep. */
  returnSpeedRatio: number;
  /** A report ends when no new cycle arrives for this long, or the person looks back at the screen for more than `gapMs`. */
  endAfterMs: number;
  /** Time on-screen tolerated between off-screen samples before the look is considered over. */
  gapMs: number;
  epoch?: (t: number) => number;
}

export const DEFAULT_READING: ReadingPatternOptions = {
  windowMs: 30000,
  minCycles: 3,
  minSweepDeg: 4,
  maxSweepSpeedDegPerSec: 28,
  minSweepMs: 500,
  returnSpeedRatio: 2.5,
  endAfterMs: 5000,
  gapMs: 1500,
};

export interface ReadingPatternEvent extends WebcamEvent {
  type: 'reading-pattern';
  category: EventCategory;
  region: string;
  cycles: number;
}

export interface ReadingPatternEvents extends Record<string, unknown> {
  begin: { type: 'reading-pattern'; start: number; category: EventCategory };
  event: ReadingPatternEvent;
}

interface Pivot {
  t: number;
  v: number;
}

interface Cycle {
  start: number;
  end: number;
  sign: number;
  sweepDeg: number;
}

/** Peaks and troughs of a signal that differ by more than `thr`. Exported for testing. */
export function zigzag(points: ReadonlyArray<Pivot>, thr: number): Pivot[] {
  const pivots: Pivot[] = [];
  if (points.length === 0) return pivots;
  let trend = 0;
  let lo = points[0];
  let hi = points[0];
  let cand = points[0];
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    if (trend === 0) {
      if (p.v < lo.v) lo = p;
      if (p.v > hi.v) hi = p;
      if (p.v - lo.v > thr && lo.t <= p.t) {
        pivots.push(lo);
        trend = 1;
        cand = p;
      } else if (hi.v - p.v > thr) {
        pivots.push(hi);
        trend = -1;
        cand = p;
      }
    } else if (trend > 0) {
      if (p.v > cand.v) cand = p;
      else if (cand.v - p.v > thr) {
        pivots.push(cand);
        trend = -1;
        cand = p;
      }
    } else {
      if (p.v < cand.v) cand = p;
      else if (p.v - cand.v > thr) {
        pivots.push(cand);
        trend = 1;
        cand = p;
      }
    }
  }
  if (trend !== 0) pivots.push(cand);
  return pivots;
}

export class ReadingPatternDetector extends Emitter<ReadingPatternEvents> {
  readonly options: ReadingPatternOptions;
  private readonly epoch: (t: number) => number;
  private buf: Pivot[] = [];
  private region: string | null = null;
  private lastOff = 0;
  private lastCheck = 0;
  private active: { start: number; end: number; cycles: number; sign: number; region: string; sweep: number } | null = null;

  constructor(options: Partial<ReadingPatternOptions> = {}) {
    super();
    this.options = { ...DEFAULT_READING, ...options };
    this.epoch = this.options.epoch ?? epochClock();
  }

  push(s: GazeRegionSample): void {
    const o = this.options;
    if (!s.ready) return;
    if (s.region === 'on-screen') {
      if (this.region !== null && s.t - this.lastOff > o.gapMs) this.reset(s.t);
      return;
    }
    if (this.region !== null && this.region !== s.region) this.reset(s.t);
    this.region = s.region;
    this.lastOff = s.t;
    this.buf.push({ t: s.t, v: s.yawDeg });
    while (this.buf.length && s.t - this.buf[0].t > o.windowMs) this.buf.shift();
    if (s.t - this.lastCheck >= 200) {
      this.lastCheck = s.t;
      this.check(s.t);
    }
  }

  /** Close an open report (the exam ended). */
  flush(t?: number): void {
    this.finish(t);
    this.buf = [];
    this.region = null;
  }

  private reset(t: number): void {
    this.finish(t);
    this.buf = [];
    this.region = null;
  }

  private finish(_t?: number): void {
    const a = this.active;
    if (!a) return;
    this.active = null;
    const span = a.end - a.start;
    const confidence = Math.min(0.85, 0.35 + 0.1 * a.cycles) * (a.sweep >= 6 ? 1 : 0.85);
    this.emit('event', {
      type: 'reading-pattern',
      category: 'integrity',
      region: a.region,
      cycles: a.cycles,
      start: this.epoch(a.start),
      end: this.epoch(a.end),
      confidence: Math.round(confidence * 100) / 100,
      summary: `The eyes swept ${a.sign > 0 ? 'toward the right' : 'toward the left'} and jumped back ${a.cycles} times in ${spoken(span)} while looking ${a.region === 'up' || a.region === 'down' ? a.region : 'to the ' + a.region} of the screen, the movement of reading text placed there. It can have other explanations; check it against the answers given.`,
    });
  }

  private check(t: number): void {
    const o = this.options;
    const cycles = this.findCycles();
    if (cycles.length >= o.minCycles) {
      // Cycles must agree on direction (a person reads every line the same way).
      const plus = cycles.filter((c) => c.sign > 0).length;
      const sign = plus >= cycles.length - plus ? 1 : -1;
      const same = cycles.filter((c) => c.sign === sign);
      if (same.length >= o.minCycles) {
        const start = same[0].start;
        const end = same[same.length - 1].end;
        const sweep = same.reduce((s, c) => s + c.sweepDeg, 0) / same.length;
        if (!this.active) {
          this.active = { start, end, cycles: same.length, sign, region: this.region ?? 'off-screen', sweep };
          this.emit('begin', { type: 'reading-pattern', start: this.epoch(start), category: 'integrity' });
        } else {
          this.active.end = Math.max(this.active.end, end);
          this.active.cycles = Math.max(this.active.cycles, same.length);
          this.active.sweep = sweep;
        }
      }
    }
    if (this.active && t - this.active.end > o.endAfterMs) this.finish(t);
  }

  private findCycles(): Cycle[] {
    const o = this.options;
    const piv = zigzag(this.buf, o.minSweepDeg * 0.5);
    const cycles: Cycle[] = [];
    for (let i = 0; i + 2 < piv.length; i++) {
      const a = piv[i];
      const b = piv[i + 1];
      const c = piv[i + 2];
      const sweep = b.v - a.v;
      const back = c.v - b.v;
      const dur = b.t - a.t;
      const backDur = Math.max(1, c.t - b.t);
      if (Math.abs(sweep) < o.minSweepDeg || Math.sign(sweep) === Math.sign(back)) continue;
      if (dur < o.minSweepMs) continue;
      const speed = (Math.abs(sweep) / dur) * 1000;
      const backSpeed = (Math.abs(back) / backDur) * 1000;
      if (speed > o.maxSweepSpeedDegPerSec) continue;
      if (backSpeed < speed * o.returnSpeedRatio) continue;
      if (Math.abs(back) < Math.abs(sweep) * 0.5) continue;
      cycles.push({ start: a.t, end: c.t, sign: Math.sign(sweep), sweepDeg: Math.abs(sweep) });
      i++; // the return leg belongs to this cycle
    }
    return cycles;
  }
}
