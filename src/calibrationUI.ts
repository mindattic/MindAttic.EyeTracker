import { calibrationPattern } from './calibration.js';
import type { CalibrationResult, GazeSource, Point } from './types.js';

export interface CalibrationUIOptions {
  /** How many targets: 5 is quick, 9 the default, 13 the most accurate. */
  points: 5 | 9 | 13;
  /** Or your own targets, as normalized display points. Overrides `points`. */
  targets?: Point[];
  /** Time to let the eye land on a target before sampling starts. */
  settleMs: number;
  /** Time spent sampling each target. */
  collectMs: number;
  /**
   * After the dots, ask the user to keep looking at a dot while moving their head. This is what
   * teaches the tracker where the camera is and how to allow for head movement. On by default.
   */
  headMovement: boolean;
  /** Go fullscreen for the duration, so the display space is the whole screen. */
  fullscreen: boolean;
  /** The element the targets are laid out over. Defaults to the viewport. */
  container?: HTMLElement;
  /** Shown before the first target. */
  intro: string;
}

export const DEFAULT_CALIBRATION_UI: CalibrationUIOptions = {
  points: 9,
  settleMs: 700,
  collectMs: 900,
  fullscreen: false,
  headMovement: true,
  intro: 'Look at each dot until it fills. Keep your head still and move only your eyes.',
};

/** A cross error above this (in display units) means the gaze point will be of little use. */
export const POOR_CALIBRATION = 0.2;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Show the calibration targets and drive `source` through them. Resolves with the fit result, or
 * with ok false and reason "cancelled" if the user pressed Escape.
 *
 * The gaze this produces is relative to the area the targets covered: the viewport by default.
 * Resizing or moving the window afterwards makes the calibration wrong; calibrate again.
 */
export async function runCalibration(
  source: GazeSource,
  options: Partial<CalibrationUIOptions> = {},
): Promise<CalibrationResult> {
  const o = { ...DEFAULT_CALIBRATION_UI, ...options };
  const targets = o.targets ?? calibrationPattern(o.points);
  const host = o.container ?? document.body;

  const overlay = document.createElement('div');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'Eye tracking calibration');
  overlay.style.cssText =
    `position:${o.container ? 'absolute' : 'fixed'};inset:0;z-index:2147483000;background:#05070d;color:#e8eefc;` +
    'font:500 18px/1.5 system-ui,sans-serif;cursor:none;overflow:hidden;touch-action:none';
  const message = document.createElement('div');
  message.style.cssText =
    'position:absolute;left:50%;top:38%;transform:translate(-50%,-50%);max-width:34em;text-align:center;padding:0 24px';
  const dot = document.createElement('div');
  dot.style.cssText =
    'position:absolute;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:3px solid #7fd4ff;' +
    'box-sizing:border-box;display:none;transition:left .32s cubic-bezier(.3,.7,.2,1),top .32s cubic-bezier(.3,.7,.2,1)';
  const fill = document.createElement('div');
  fill.style.cssText =
    'position:absolute;left:50%;top:50%;width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:50%;background:#fff';
  dot.appendChild(fill);
  overlay.append(message, dot);
  host.appendChild(overlay);

  let cancelled = false;
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') cancelled = true;
  };
  window.addEventListener('keydown', onKey);
  const cleanup = async () => {
    window.removeEventListener('keydown', onKey);
    overlay.remove();
    if (o.fullscreen && document.fullscreenElement) await document.exitFullscreen().catch(() => {});
  };
  const cancelResult: CalibrationResult = {
    ok: false,
    reason: 'cancelled',
    targets: 0,
    samples: 0,
    fitError: 0,
    crossError: 0,
  };

  try {
    message.innerHTML = '';
    const lead = document.createElement('p');
    lead.textContent = o.intro;
    const hint = document.createElement('p');
    hint.style.cssText = 'opacity:.6;font-size:15px';
    hint.textContent = 'Click or press Space to begin. Esc cancels.';
    message.append(lead, hint);
    overlay.style.cursor = 'pointer';
    await new Promise<void>((resolve) => {
      const go = (ev: Event) => {
        if (ev instanceof KeyboardEvent && ev.key !== ' ' && ev.key !== 'Enter' && ev.key !== 'Escape') return;
        overlay.removeEventListener('pointerdown', go);
        window.removeEventListener('keydown', go);
        resolve();
      };
      overlay.addEventListener('pointerdown', go);
      window.addEventListener('keydown', go);
    });
    if (cancelled) return cancelResult;
    overlay.style.cursor = 'none';
    if (o.fullscreen && !document.fullscreenElement) {
      // Some browsers never answer a fullscreen request they will not grant; do not wait on them.
      await Promise.race([document.documentElement.requestFullscreen().catch(() => {}), wait(1500)]);
      await wait(300);
    }

    message.style.display = 'none';
    dot.style.display = 'block';
    source.calibBegin();
    for (const target of targets) {
      if (cancelled) return cancelResult;
      dot.style.left = `${target.x * 100}%`;
      dot.style.top = `${target.y * 100}%`;
      fill.style.transition = 'none';
      fill.style.transform = 'scale(1)';
      await wait(o.settleMs);
      if (cancelled) return cancelResult;
      fill.style.transition = `transform ${o.collectMs}ms linear`;
      fill.style.transform = 'scale(4.6)';
      await source.calibCollect(target.x, target.y, o.collectMs);
    }
    if (cancelled) return cancelResult;

    if (o.headMovement) {
      // Eyes fixed, head moving: the only way to learn how head movement shifts the picture, and
      // with it where the camera sits relative to the screen.
      const prompt = document.createElement('div');
      prompt.style.cssText =
        'position:absolute;left:50%;bottom:9%;transform:translateX(-50%);max-width:36em;text-align:center;padding:0 24px';
      overlay.appendChild(prompt);
      dot.style.borderColor = '#ffc266';
      const steps: Array<{ x: number; y: number; ms: number; text: string }> = [
        { x: 0.5, y: 0.5, ms: 6000, text: 'Keep your eyes on the dot and slowly turn your head left and right, then nod up and down.' },
        { x: 0.18, y: 0.22, ms: 4000, text: 'Eyes on the dot again. Lean a little closer, then back, then side to side.' },
        { x: 0.82, y: 0.78, ms: 4000, text: 'Once more: eyes on the dot, move your head around gently.' },
      ];
      for (const step of steps) {
        if (cancelled) return cancelResult;
        prompt.textContent = step.text;
        dot.style.left = `${step.x * 100}%`;
        dot.style.top = `${step.y * 100}%`;
        fill.style.transition = 'none';
        fill.style.transform = 'scale(1)';
        await wait(1200);
        if (cancelled) return cancelResult;
        fill.style.transition = `transform ${step.ms}ms linear`;
        fill.style.transform = 'scale(4.6)';
        await source.calibCollect(step.x, step.y, step.ms, true);
      }
      prompt.remove();
      if (cancelled) return cancelResult;
    }

    dot.style.display = 'none';
    message.style.display = 'block';
    message.textContent = 'Working it out...';
    const result = await source.calibFinish();
    const percent = Math.round(result.crossError * 100);
    const poor = result.ok && result.crossError > POOR_CALIBRATION;
    message.textContent = !result.ok
      ? `Calibration failed: ${result.reason ?? 'unknown reason'}.`
      : poor
        ? `Calibrated, but poorly: about ${percent}% of the screen off. Face the light, keep your head still and try again.`
        : `Calibrated. Typical error: about ${percent}% of the screen.`;
    await wait(result.ok && !poor ? 1100 : 2600);
    return result;
  } finally {
    await cleanup();
  }
}

/**
 * A dot that follows the gaze point, for demos and for checking a calibration by eye.
 * Returns the function that removes it.
 */
export function showGazeDot(source: GazeSource, container: HTMLElement = document.body): () => void {
  const dot = document.createElement('div');
  dot.style.cssText =
    'position:fixed;left:0;top:0;width:36px;height:36px;margin:-18px 0 0 -18px;border-radius:50%;z-index:2147482000;' +
    'pointer-events:none;border:2px solid rgba(127,212,255,.9);background:rgba(127,212,255,.18);will-change:transform';
  container.appendChild(dot);
  const off = source.on('gaze', (g) => {
    dot.style.transform = `translate(${g.x * window.innerWidth}px,${g.y * window.innerHeight}px)`;
    dot.style.opacity = g.confidence > 0 ? '1' : '.3';
  });
  return () => {
    off();
    dot.remove();
  };
}
