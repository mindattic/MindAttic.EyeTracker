import { FEATURE_COUNT } from './features.js';
import { dot } from './math/ridge.js';
import type { Point } from './types.js';

/** A fitted gaze mapping: two weight vectors over `featureVector`. Plain JSON, safe to store. */
export interface GazeModel {
  version: 1;
  features: number;
  wx: number[];
  wy: number[];
  createdAt: number;
  /** Leave-one-target-out error at fit time, in display units. Zero for the built-in model. */
  crossError: number;
  builtIn?: boolean;
}

export function predict(model: GazeModel, phi: ArrayLike<number>): Point {
  return { x: dot(model.wx, phi), y: dot(model.wy, phi) };
}

/**
 * The mapping used before any calibration: iris position only, with typical gains for a laptop
 * webcam at arm's length. It is good enough to tell left from right and up from down, and no
 * better. Calibrate before relying on it.
 */
export function builtInModel(): GazeModel {
  const wx = new Array<number>(FEATURE_COUNT).fill(0);
  const wy = new Array<number>(FEATURE_COUNT).fill(0);
  // Unmirrored image: looking toward the screen's right moves the iris toward image-left.
  wx[0] = 0.5;
  wx[1] = -0.25;
  wx[3] = -0.25;
  wy[0] = 0.5;
  wy[2] = 0.5;
  wy[4] = 0.5;
  return { version: 1, features: FEATURE_COUNT, wx, wy, createdAt: 0, crossError: 0, builtIn: true };
}

export function isValidModel(m: unknown): m is GazeModel {
  const g = m as GazeModel | null;
  return (
    !!g &&
    g.version === 1 &&
    g.features === FEATURE_COUNT &&
    Array.isArray(g.wx) &&
    Array.isArray(g.wy) &&
    g.wx.length === FEATURE_COUNT &&
    g.wy.length === FEATURE_COUNT &&
    g.wx.every(Number.isFinite) &&
    g.wy.every(Number.isFinite)
  );
}
