import type { Point } from './types.js';

/**
 * Where the page's viewport sits on the physical screen, in CSS pixels.
 *
 * The eyes look at the screen, not at a window. A calibration that only knows "30% across the
 * window" goes wrong the moment the window is a different size or in a different place than it was
 * during calibration (most visibly: calibrate fullscreen, then play in a smaller window). So the
 * tracker fits its model in screen space and converts to the viewport as it is at that moment.
 */
export interface ViewportOnScreen {
  left: number;
  top: number;
  width: number;
  height: number;
  screenWidth: number;
  screenHeight: number;
}

export function viewportOnScreen(): ViewportOnScreen {
  const w = window as Window & { mozInnerScreenX?: number; mozInnerScreenY?: number };
  // Browsers do not report the viewport's screen position directly (Firefox aside). The window
  // frame is the same thickness on the left, right and bottom; whatever is left over is the
  // toolbar area above the page.
  const side = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
  const chromeTop = Math.max(0, window.outerHeight - window.innerHeight - side);
  return {
    left: w.mozInnerScreenX ?? window.screenX + side,
    top: w.mozInnerScreenY ?? window.screenY + chromeTop,
    width: Math.max(1, window.innerWidth),
    height: Math.max(1, window.innerHeight),
    screenWidth: Math.max(1, window.screen.width),
    screenHeight: Math.max(1, window.screen.height),
  };
}

/** A viewport point (0..1 across the page) as a screen point (0..1 across the monitor). */
export function viewportToScreen(x: number, y: number, v: ViewportOnScreen = viewportOnScreen()): Point {
  return { x: (v.left + x * v.width) / v.screenWidth, y: (v.top + y * v.height) / v.screenHeight };
}

/** A screen point (0..1 across the monitor) as a viewport point. Outside 0..1 when the gaze is off the page. */
export function screenToViewport(x: number, y: number, v: ViewportOnScreen = viewportOnScreen()): Point {
  return { x: (x * v.screenWidth - v.left) / v.width, y: (y * v.screenHeight - v.top) / v.height };
}
