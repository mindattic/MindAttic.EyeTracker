import { Emitter } from './emitter.js';
import type { EventCategory, FrameSource, WebcamEvent } from './events.js';
import { HeadPoseMonitor, type HeadPoseOptions } from './headpose.js';
import { PresenceMonitor, type PresenceOptions } from './presence.js';
import { ReadingPatternDetector, type ReadingPatternOptions } from './reading.js';

/**
 * Integrity event stream (@mindattic/webcam/integrity): presence, gaze region and the
 * reading-pattern detector merged into ONE stream of events in ONE shape,
 * `{type, start, end, confidence, summary}`, ready for an exam server.
 *
 * What the stream is, and is not (see docs/GAZE-AND-DECEPTION.md):
 *  - It reports behaviour a reviewer can verify: no face, a second face, a face that looks
 *    different, a long look off-screen, repeated reading sweeps toward one off-screen region.
 *  - `confidence` is how sure the detector is of WHAT it saw, never how likely it is that anyone
 *    cheated. Brief glances away are annotated as thinking and are not integrity events.
 *  - It never infers emotion, stress or deception (EU AI Act Art. 5(1)(f)), and nothing in it is
 *    meant to be used as proof of misconduct or to fail anyone automatically: a human reviews it.
 *  - Privacy: see `PRIVACY`. No frame, image or face template is ever part of an event, and the
 *    only way data leaves is through events that passed `sanitizeEvent`.
 */

export interface IntegrityEvent extends WebcamEvent {
  /** Which module produced it. */
  module: 'presence' | 'headpose' | 'reading';
  category: EventCategory;
}

/** What the library guarantees about data leaving the device. */
export const PRIVACY = Object.freeze({
  mode: 'no-frames-leave-device',
  guarantee:
    'No video frame, image, landmark or face signature is encoded, stored or sent by this library. ' +
    'Modules receive landmark numbers in memory; the only pixel read is a 16x9 brightness thumbnail that is averaged to one number and dropped. ' +
    'The only output is a list of events (type, start, end, confidence, summary), each passed through sanitizeEvent. ' +
    'The same-person signature lives in memory inside the presence monitor and has no export method.',
  leaves: ['type', 'start', 'end', 'confidence', 'summary'],
});

const MAX_TYPE = 60;
const MAX_SUMMARY = 500;

/**
 * Reduce an event to exactly the five documented fields, with bounded text. Anything else that was
 * attached (an image, a typed array, a landmark list, a canvas) is dropped, so an event can never
 * carry pixels or biometric data out. Returns null for an event that cannot be made valid.
 */
export function sanitizeEvent(e: WebcamEvent): WebcamEvent | null {
  if (!e || typeof e.type !== 'string' || !Number.isFinite(e.start)) return null;
  const clip = (s: unknown, max: number) => (typeof s === 'string' ? s.replace(/data:[^\s]*/gi, '').slice(0, max) : '');
  const confidence = Number.isFinite(e.confidence) ? Math.min(1, Math.max(0, e.confidence)) : 0;
  return {
    type: clip(e.type, MAX_TYPE),
    start: Math.round(e.start),
    end: e.end === null || !Number.isFinite(e.end) ? null : Math.round(e.end),
    confidence: Math.round(confidence * 100) / 100,
    summary: clip(e.summary, MAX_SUMMARY),
  };
}

/** The shape of Gadfly's SessionHub.Integrity events: HubIntegrityEvent(Source, Type, StartedAt, EndedAt, Confidence, Summary). */
export interface HubIntegrityEvent {
  source: 'webcam';
  type: string;
  startedAt: string;
  endedAt: string | null;
  confidence: number;
  summary: string;
}

/**
 * Convert to what SessionHub.Integrity takes (property names are camelCase; SignalR binds them
 * case-insensitively). Annotations ("thinking") have their confidence capped below 0.4 so the
 * server records them as Info, never as a flag. Server-side the severity is a function of the
 * confidence alone, which is why it is capped here and not left to chance.
 */
export function toHubEvent(e: WebcamEvent & { category?: EventCategory }): HubIntegrityEvent | null {
  const s = sanitizeEvent(e);
  if (!s) return null;
  const confidence = e.category === 'annotation' ? Math.min(s.confidence, 0.3) : s.confidence;
  return {
    source: 'webcam',
    type: s.type,
    startedAt: new Date(s.start).toISOString(),
    endedAt: s.end === null ? null : new Date(s.end).toISOString(),
    confidence,
    summary: s.summary,
  };
}

export interface IntegrityOptions {
  presence?: Partial<PresenceOptions> | false;
  headpose?: Partial<HeadPoseOptions> | false;
  reading?: Partial<ReadingPatternOptions> | false;
  /** Also stream setup-quality events (lighting, framing). They are for the student, so off by default. */
  includeQuality: boolean;
  /** Also stream "thinking glance" annotations, so a reviewer can see that glances were seen and judged normal. */
  includeAnnotations: boolean;
}

export const DEFAULT_INTEGRITY: IntegrityOptions = { includeQuality: false, includeAnnotations: true };

export interface IntegrityEvents extends Record<string, unknown> {
  event: IntegrityEvent;
  /** A condition has started and has not ended yet (for a live indicator). Not an event for the record. */
  begin: { type: string; start: number; module: IntegrityEvent['module'] };
}

/** The part of WebcamCore the monitor needs to own the camera's lifetime. */
export interface RetainableSource extends FrameSource {
  retain(): Promise<void>;
  release(): void;
}

export class IntegrityMonitor extends Emitter<IntegrityEvents> {
  readonly options: IntegrityOptions;
  readonly presence: PresenceMonitor | null;
  readonly headpose: HeadPoseMonitor | null;
  readonly reading: ReadingPatternDetector | null;
  /** Always the same value: nothing but sanitized events leaves. */
  readonly privacy = PRIVACY;
  private offs: Array<() => void> = [];
  private held: RetainableSource | null = null;

  constructor(options: Partial<IntegrityOptions> = {}) {
    super();
    this.options = { ...DEFAULT_INTEGRITY, ...options };
    const o = this.options;
    this.presence = o.presence === false ? null : new PresenceMonitor(o.presence);
    this.headpose = o.headpose === false ? null : new HeadPoseMonitor(o.headpose);
    this.reading = o.reading === false || !this.headpose ? null : new ReadingPatternDetector(o.reading);
    const forward = (module: IntegrityEvent['module']) => (e: WebcamEvent & { category: EventCategory }) => {
      if (e.category === 'quality' && !this.options.includeQuality) return;
      if (e.category === 'annotation' && !this.options.includeAnnotations) return;
      const s = sanitizeEvent(e);
      if (s) this.emit('event', { ...s, module, category: e.category });
    };
    const begins = (module: IntegrityEvent['module']) => (b: { type: string; start: number; category: EventCategory }) => {
      if (b.category === 'integrity') this.emit('begin', { type: b.type, start: b.start, module });
    };
    this.presence?.on('event', forward('presence'));
    this.presence?.on('begin', begins('presence'));
    this.headpose?.on('event', forward('headpose'));
    this.headpose?.on('begin', begins('headpose'));
    this.reading?.on('event', forward('reading'));
    this.reading?.on('begin', begins('reading'));
    if (this.reading) this.headpose?.on('sample', (s) => this.reading?.push(s));
  }

  /** Listen to frames from any source (a WebcamCore, or synthetic ones in a demo). Does not touch the camera. */
  connect(source: FrameSource): () => void {
    const offs = [this.presence?.connect(source), this.headpose?.connect(source)].filter((f): f is () => void => !!f);
    const off = () => {
      offs.forEach((f) => f());
      this.presence?.flush();
      this.headpose?.flush();
      this.reading?.flush();
    };
    this.offs.push(off);
    return off;
  }

  /** Start the camera on `core` (if nobody has) and listen. The camera stops again on `stop()`. */
  async start(core: RetainableSource): Promise<void> {
    if (this.held) return;
    await core.retain();
    this.held = core;
    this.connect(core);
  }

  /** Stop listening, close open events so each has an end, and release the camera. */
  stop(): void {
    this.offs.forEach((f) => f());
    this.offs = [];
    this.held?.release();
    this.held = null;
  }

  /**
   * Batch events for a server: calls `send` with up to `maxBatch` hub events at a time (the server
   * accepts 50 per call), every `everyMs` and on `flush()`. Failed sends are put back and retried.
   */
  sink(
    send: (events: HubIntegrityEvent[]) => Promise<unknown>,
    options: { everyMs?: number; maxBatch?: number } = {},
  ): { flush(): Promise<void>; close(): Promise<void> } {
    const maxBatch = Math.min(50, options.maxBatch ?? 50);
    const queue: HubIntegrityEvent[] = [];
    let busy = false;
    const flush = async () => {
      if (busy) return;
      busy = true;
      try {
        while (queue.length) {
          const batch = queue.splice(0, maxBatch);
          try {
            await send(batch);
          } catch {
            queue.unshift(...batch);
            break;
          }
        }
      } finally {
        busy = false;
      }
    };
    const off = this.on('event', (e) => {
      const h = toHubEvent(e);
      if (h) queue.push(h);
    });
    const timer = setInterval(() => void flush(), options.everyMs ?? 5000);
    return {
      flush,
      close: async () => {
        off();
        clearInterval(timer);
        await flush();
      },
    };
  }
}
