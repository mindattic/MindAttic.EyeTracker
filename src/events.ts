import type { WebcamFrame } from './types.js';

/**
 * One thing a module noticed, over a span of time. This is the shared shape of the integrity
 * stream (integrity.ts) and of every module's own events: `{type, start, end, confidence, summary}`.
 *
 * `start` and `end` are Unix milliseconds. `end` is null while the thing is still going on.
 * `confidence` is 0..1 and says how sure the detector is that it saw what `type` says, NOT how
 * likely anyone is to have done something wrong. `summary` is a sentence a reviewer can read.
 * Nothing in an event is an image, a landmark or any other biometric template.
 */
export interface WebcamEvent {
  type: string;
  start: number;
  end: number | null;
  confidence: number;
  summary: string;
}

/**
 * How much a reviewer should read into an event. `quality` is about the setup (lighting, framing)
 * and is for the student, `annotation` is context that explains behaviour as normal (a glance up
 * while thinking), `integrity` is something a reviewer may want to look at. Never an accusation.
 */
export type EventCategory = 'quality' | 'annotation' | 'integrity';

/** Anything that delivers frames: a WebcamCore, or a test feeding synthetic ones. */
export interface FrameSource {
  subscribe(handler: (frame: WebcamFrame) => void): () => void;
}

/** Converts the frame clock (performance.now()) to Unix milliseconds. */
export function epochClock(): (t: number) => number {
  const offset = typeof performance !== 'undefined' ? Date.now() - performance.now() : 0;
  return (t) => Math.round(offset + t);
}

/** "7 s" or "1 min 5 s", for summaries. */
export function spoken(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

/**
 * A condition that must hold for `minOnMs` before it counts as started, and be false for
 * `minOffMs` before it counts as ended, so a flicker is not an event. Times are on the frame clock.
 */
export class Episode {
  active = false;
  /** When the active episode began (the first moment the condition held). */
  start = 0;
  private pendingSince: number | null = null;
  private lastTrue = 0;

  constructor(
    readonly minOnMs: number,
    readonly minOffMs: number,
  ) {}

  /** Feed the condition at time `t`. Returns what changed. */
  update(t: number, holds: boolean): { started?: true; ended?: { start: number; end: number } } {
    if (!this.active) {
      if (!holds) {
        this.pendingSince = null;
        return {};
      }
      this.pendingSince ??= t;
      this.lastTrue = t;
      if (t - this.pendingSince >= this.minOnMs) {
        this.active = true;
        this.start = this.pendingSince;
        this.pendingSince = null;
        return { started: true };
      }
      return {};
    }
    if (holds) {
      this.lastTrue = t;
      return {};
    }
    if (t - this.lastTrue >= this.minOffMs) {
      this.active = false;
      return { ended: { start: this.start, end: this.lastTrue } };
    }
    return {};
  }

  /** How long the active episode has run, up to `t`. */
  duration(t: number): number {
    return this.active ? Math.max(0, t - this.start) : 0;
  }

  /** Close an active episode now (the camera stopped). */
  close(t: number): { start: number; end: number } | null {
    if (!this.active) {
      this.pendingSince = null;
      return null;
    }
    this.active = false;
    return { start: this.start, end: Math.max(this.start, Math.min(t, this.lastTrue + this.minOffMs)) };
  }
}
