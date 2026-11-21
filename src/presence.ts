import { Emitter } from './emitter.js';
import { Episode, epochClock, spoken, type EventCategory, type FrameSource, type WebcamEvent } from './events.js';
import { extractFeatures } from './features.js';
import type { LandmarkFrame, WebcamFrame } from './types.js';

/**
 * Presence module (@mindattic/webcam/presence): is there a face, is there more than one, is it the
 * same person throughout, and is the setup good enough (lighting, framing) for any of that to mean
 * anything.
 *
 * Privacy: the "same person" check compares a small vector of face-geometry ratios held in this
 * object's memory. It is never written to storage, never serialised (there is no export method),
 * never sent anywhere, and is gone when `reset()` is called or the monitor is garbage collected.
 * It is also a WEAK signal (landmark geometry is far less discriminating than a face-recognition
 * model, on purpose) and is reported as "may be a different person", with modest confidence, for a
 * human to look at. Face geometry can count as biometric data (Illinois BIPA, GDPR Art. 9): get
 * consent before turning the monitor on. It infers nothing about emotion or intent.
 */

export type PresenceEventType =
  | 'face-absent'
  | 'multiple-faces'
  | 'identity-drift'
  | 'low-light'
  | 'face-too-small'
  | 'face-cut-off'
  | 'face-off-center';

export interface PresenceEvent extends WebcamEvent {
  type: PresenceEventType;
  category: EventCategory;
}

export interface PresenceStatus {
  /** Faces in the latest frame. */
  faces: number;
  /** No face for long enough to count as absent right now. */
  absent: boolean;
  /** More than one face for long enough to count right now. */
  multiple: boolean;
  /** "unenrolled" until a reference has been taken from the first frames. */
  identity: 'unenrolled' | 'enrolling' | 'match' | 'drift';
  /** Setup problems active right now: low-light, face-too-small, face-cut-off, face-off-center. */
  warnings: PresenceEventType[];
}

export interface PresenceOptions {
  /** No face for this long counts as absent. */
  absentMs: number;
  /** A second face for this long counts. */
  multipleMs: number;
  /** A different-looking face for this long counts as identity drift. */
  driftMs: number;
  /** How long a setup problem must last before it is reported. */
  qualityMs: number;
  /** Frames of a single frontal face averaged into the reference. */
  enrollFrames: number;
  /** Mean relative difference between signatures above which the face looks different. */
  driftThreshold: number;
  /** Mean brightness (0..255) below which the picture is too dark. */
  minLuma: number;
  /** Eye distance as a fraction of image height below which the face is too small. */
  minScale: number;
  /** Converts the frame clock to Unix ms. Default: performance.now() based. */
  epoch?: (t: number) => number;
}

export const DEFAULT_PRESENCE: PresenceOptions = {
  absentMs: 2000,
  multipleMs: 1000,
  driftMs: 3000,
  qualityMs: 3000,
  enrollFrames: 45,
  driftThreshold: 0.08,
  minLuma: 45,
  minScale: 0.045,
};

export interface PresenceEvents extends Record<string, unknown> {
  /** A condition has just held long enough to count; the finished event follows when it ends. */
  begin: { type: PresenceEventType; start: number; category: EventCategory };
  event: PresenceEvent;
  status: PresenceStatus;
}

// MediaPipe Face Landmarker indices.
const PAIRS: ReadonlyArray<readonly [number, number]> = [
  [33, 133], // right eye width
  [362, 263], // left eye width
  [159, 145], // right eye height
  [386, 374], // left eye height
  [129, 358], // nose width
  [168, 1], // nose length
  [61, 291], // mouth width
  [234, 454], // face width
  [10, 152], // face height
  [172, 397], // jaw width
  [105, 159], // right brow to eye
  [334, 386], // left brow to eye
  [1, 13], // nose to mouth
  [13, 152], // mouth to chin
  [116, 345], // cheekbone width
  [10, 168], // forehead to nose bridge
];

/**
 * Pose-insensitive-ish face geometry: distances between landmark pairs as a fraction of the
 * distance between the eyes. Meaningful for a near-frontal face only (see `isFrontal`).
 */
export function faceSignature(frame: LandmarkFrame): number[] | null {
  const lm = frame.landmarks;
  if (!lm || lm.length < 468) return null;
  const a = frame.aspect > 0 ? frame.aspect : 1;
  const d = (i: number, j: number) => Math.hypot((lm[i].x - lm[j].x) * a, lm[i].y - lm[j].y);
  const mid = (i: number, j: number) => ({ x: ((lm[i].x + lm[j].x) / 2) * a, y: (lm[i].y + lm[j].y) / 2 });
  const r = mid(33, 133);
  const l = mid(362, 263);
  const iod = Math.hypot(l.x - r.x, l.y - r.y);
  if (!(iod > 1e-6)) return null;
  return PAIRS.map(([i, j]) => d(i, j) / iod);
}

/** The face is turned little enough that its geometry ratios can be compared. */
export function isFrontal(frame: LandmarkFrame): boolean {
  const f = extractFeatures(frame);
  if (!f) return false;
  return Math.abs(f.yaw) < 0.22 && Math.abs(f.pitch - 0.556) < 0.25 && Math.abs(f.roll) < 0.35;
}

/** Mean relative difference between two signatures, ignoring ratios that are degenerate in either. */
export function signatureDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    const m = Math.max(a[i], b[i]);
    if (!(m > 1e-3)) continue;
    sum += Math.abs(a[i] - b[i]) / m;
    n++;
  }
  return n === 0 ? 0 : sum / n;
}

function median(values: number[]): number {
  const s = [...values].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export class PresenceMonitor extends Emitter<PresenceEvents> {
  readonly options: PresenceOptions;
  status: PresenceStatus = { faces: 0, absent: false, multiple: false, identity: 'unenrolled', warnings: [] };

  private readonly epoch: (t: number) => number;
  private readonly absent: Episode;
  private readonly multiple: Episode;
  private readonly drift: Episode;
  private readonly quality: Record<'low-light' | 'face-too-small' | 'face-cut-off' | 'face-off-center', Episode>;
  /** In-memory only. No getter, no serialisation. */
  #reference: number[] | null = null;
  #samples: number[][] = [];
  #recent: number | null = null;
  #worst = 0;
  #lastT = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(options: Partial<PresenceOptions> = {}) {
    super();
    this.options = { ...DEFAULT_PRESENCE, ...options };
    const o = this.options;
    this.epoch = o.epoch ?? epochClock();
    this.absent = new Episode(o.absentMs, 400);
    this.multiple = new Episode(o.multipleMs, 600);
    this.drift = new Episode(o.driftMs, 1500);
    const q = () => new Episode(o.qualityMs, 1000);
    this.quality = { 'low-light': q(), 'face-too-small': q(), 'face-cut-off': new Episode(2000, 1000), 'face-off-center': q() };
  }

  /** Listen to a WebcamCore (or any frame source). Returns the function that stops listening. */
  connect(source: FrameSource): () => void {
    this.unsubscribe?.();
    this.unsubscribe = source.subscribe((f) => this.process(f));
    this.emit('status', this.status);
    return () => {
      this.unsubscribe?.();
      this.unsubscribe = null;
    };
  }

  /** Forget the reference face and start enrolling again from the next frontal frames. */
  reset(): void {
    this.#reference = null;
    this.#samples = [];
    this.#recent = null;
    this.#worst = 0;
  }

  get enrolled(): boolean {
    return this.#reference !== null;
  }

  /** Close open episodes (the camera stopped, the exam ended) so each is reported with an end. */
  flush(t: number = this.#lastT): void {
    this.closeEpisode(this.absent, 'face-absent', t, 'integrity');
    this.closeEpisode(this.multiple, 'multiple-faces', t, 'integrity');
    this.closeEpisode(this.drift, 'identity-drift', t, 'integrity');
    for (const key of Object.keys(this.quality) as (keyof typeof this.quality)[]) {
      this.closeEpisode(this.quality[key], key, t, 'quality');
    }
  }

  process(frame: WebcamFrame): void {
    const t = frame.t;
    this.#lastT = t;
    const o = this.options;
    const n = frame.faces.length;
    const primary = frame.faces[0];
    const features = primary ? extractFeatures(primary) : null;

    this.step(this.absent, 'face-absent', t, n === 0, 'integrity');
    this.step(this.multiple, 'multiple-faces', t, n >= 2, 'integrity');

    // Identity: enrol from a lone frontal face, then compare.
    let driftNow = false;
    if (n === 1 && primary && isFrontal(primary)) {
      const sig = faceSignature(primary);
      if (sig) {
        if (!this.#reference) {
          this.#samples.push(sig);
          if (this.#samples.length >= o.enrollFrames) {
            this.#reference = sig.map((_, k) => median(this.#samples.map((s) => s[k])));
            this.#samples = [];
          }
        } else {
          const d = signatureDistance(this.#reference, sig);
          this.#recent = this.#recent === null ? d : this.#recent * 0.9 + d * 0.1;
          driftNow = this.#recent > o.driftThreshold;
          if (driftNow) this.#worst = Math.max(this.#worst, this.#recent);
        }
      }
    }
    // Only a lone, frontal face can say anything about identity; otherwise hold the last verdict.
    const identityKnown = n === 1 && primary && isFrontal(primary);
    if (this.#reference && identityKnown) this.step(this.drift, 'identity-drift', t, driftNow, 'integrity');

    // Setup quality.
    const lowLight = frame.luma !== undefined && frame.luma < o.minLuma;
    this.step(this.quality['low-light'], 'low-light', t, lowLight, 'quality');
    this.step(this.quality['face-too-small'], 'face-too-small', t, !!features && features.scale < o.minScale, 'quality');
    const cutOff =
      !!primary &&
      [10, 152, 234, 454].some((i) => {
        const p = primary.landmarks[i];
        return p.x < 0.01 || p.x > 0.99 || p.y < 0.01 || p.y > 0.99;
      });
    this.step(this.quality['face-cut-off'], 'face-cut-off', t, cutOff, 'quality');
    this.step(
      this.quality['face-off-center'],
      'face-off-center',
      t,
      !!features && (Math.abs(features.px) > 0.3 || Math.abs(features.py) > 0.3),
      'quality',
    );

    const warnings = (Object.keys(this.quality) as (keyof typeof this.quality)[]).filter((k) => this.quality[k].active);
    const identity: PresenceStatus['identity'] = !this.#reference
      ? this.#samples.length > 0
        ? 'enrolling'
        : 'unenrolled'
      : this.drift.active
        ? 'drift'
        : 'match';
    const next: PresenceStatus = { faces: n, absent: this.absent.active, multiple: this.multiple.active, identity, warnings };
    const s = this.status;
    const changed =
      s.faces !== next.faces ||
      s.absent !== next.absent ||
      s.multiple !== next.multiple ||
      s.identity !== next.identity ||
      s.warnings.join() !== next.warnings.join();
    this.status = next;
    if (changed) this.emit('status', next);
  }

  private step(ep: Episode, type: PresenceEventType, t: number, holds: boolean, category: EventCategory): void {
    const r = ep.update(t, holds);
    if (r.started) this.emit('begin', { type, start: this.epoch(ep.start), category });
    if (r.ended) this.finish(type, r.ended.start, r.ended.end, category);
  }

  private closeEpisode(ep: Episode, type: PresenceEventType, t: number, category: EventCategory): void {
    const r = ep.close(t);
    if (r) this.finish(type, r.start, r.end, category);
  }

  private finish(type: PresenceEventType, start: number, end: number, category: EventCategory): void {
    const span = spoken(end - start);
    const worst = this.#worst;
    if (type === 'identity-drift') this.#worst = 0;
    const [confidence, summary] = ((): [number, string] => {
      switch (type) {
        case 'face-absent':
          return [0.9, `No face was in view for ${span}.`];
        case 'multiple-faces':
          return [0.7, `More than one face was in view for ${span}. It may be a person, a photo or a reflection.`];
        case 'identity-drift':
          return [
            Math.min(0.6, 0.3 + worst * 2),
            `The face in view looked different from the one at the start for ${span}. Face geometry is a weak signal; it may be a different person or a change in pose, lighting or glasses.`,
          ];
        case 'low-light':
          return [0.9, `The picture was too dark for reliable face tracking for ${span}.`];
        case 'face-too-small':
          return [0.9, `The face was too small in the picture for ${span}; sitting closer helps.`];
        case 'face-cut-off':
          return [0.9, `Part of the face was outside the picture for ${span}.`];
        case 'face-off-center':
          return [0.9, `The face was far from the middle of the picture for ${span}.`];
      }
    })();
    this.emit('event', { type, start: this.epoch(start), end: this.epoch(end), confidence, summary, category });
  }
}
