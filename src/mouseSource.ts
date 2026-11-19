import { Emitter } from './emitter.js';
import type { CalibrationResult, GazeSample, GazeSource } from './types.js';

/**
 * The pointer standing in for the eyes: a GazeSource driven by the mouse or a finger. Use it as
 * the fallback when there is no camera, and for developing against the gaze API without one.
 */
export class MouseGazeSource extends Emitter<{ gaze: GazeSample }> implements GazeSource {
  latest: GazeSample | null = null;
  private x = 0.5;
  private y = 0.5;
  private raf = 0;
  private readonly onMove = (ev: PointerEvent) => {
    const r = this.target === window ? null : (this.target as HTMLElement).getBoundingClientRect();
    const w = r ? r.width : window.innerWidth;
    const h = r ? r.height : window.innerHeight;
    this.x = Math.min(1, Math.max(0, (ev.clientX - (r?.left ?? 0)) / w));
    this.y = Math.min(1, Math.max(0, (ev.clientY - (r?.top ?? 0)) / h));
  };

  /** `target` is the element whose box is the display space. Defaults to the viewport. */
  constructor(private readonly target: HTMLElement | Window = window) {
    super();
  }

  start(): void {
    if (this.raf) return;
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerdown', this.onMove);
    const tick = () => {
      const sample: GazeSample = {
        t: performance.now(),
        x: this.x,
        y: this.y,
        rawX: this.x,
        rawY: this.y,
        confidence: 1,
        face: true,
        blink: false,
        calibrated: true,
      };
      this.latest = sample;
      this.emit('gaze', sample);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerdown', this.onMove);
  }

  calibBegin(): void {}
  calibCollect(_x: number, _y: number, ms: number): Promise<number> {
    return new Promise((resolve) => setTimeout(() => resolve(1), ms));
  }
  async calibFinish(): Promise<CalibrationResult> {
    return { ok: true, targets: 0, samples: 0, fitError: 0, crossError: 0 };
  }
  calibClear(): void {}
}
