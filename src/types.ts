/** A point in normalized display space: (0,0) is the top-left of the display, (1,1) the bottom-right. */
export interface Point {
  x: number;
  y: number;
}

/** One face-mesh landmark, in normalized image coordinates (x and y in 0..1, origin top-left). */
export interface Landmark {
  x: number;
  y: number;
  z?: number;
}

/** One camera frame's face mesh. `landmarks` uses MediaPipe Face Landmarker indices (478 points, irises at 468-477). */
export interface LandmarkFrame {
  landmarks: ArrayLike<Landmark>;
  /** Camera image width / height, so distances can be measured in a square space. */
  aspect: number;
  /**
   * The pose of the head in camera space as a 4x4 matrix (the MediaPipe facial transformation
   * matrix, in centimetres). Optional: without it the pose is estimated from the landmarks.
   */
  matrix?: ArrayLike<number> | null;
  /** Capture time in milliseconds (any monotonic clock). */
  t: number;
}

/** What the tracker emits for every camera frame. This is also the bridge wire format (docs/PROTOCOL.md). */
export interface GazeSample {
  /** Capture time in milliseconds. */
  t: number;
  /** Smoothed gaze point, clamped to the display (0..1). */
  x: number;
  y: number;
  /** Unsmoothed, unclamped estimate. May fall outside 0..1 when the user looks past the screen edge. */
  rawX: number;
  rawY: number;
  /** 0..1. Zero while no face is found or during a blink. */
  confidence: number;
  /** A face was found in this frame. */
  face: boolean;
  /** The eyes are closed in this frame; x and y hold the last open-eye value. */
  blink: boolean;
  /** A fitted calibration is in use. False means the rough built-in mapping. */
  calibrated: boolean;
}

export interface CalibrationResult {
  ok: boolean;
  /** Why it failed, when ok is false. */
  reason?: string;
  /** Number of targets and samples that went into the fit. */
  targets: number;
  samples: number;
  /** Root-mean-square error of the fit on its own samples, in display units (1 = the display's width or height). */
  fitError: number;
  /** Leave-one-target-out error: the honest estimate of accuracy on points it was not trained on. */
  crossError: number;
}

/**
 * Anything that produces gaze samples and can be calibrated. A local camera tracker and a remote
 * tracker reached through the bridge both implement it, so UI and games do not care which is in use.
 */
export interface GazeSource {
  readonly latest: GazeSample | null;
  on(event: 'gaze', handler: (sample: GazeSample) => void): () => void;
  /** Start a new calibration, dropping samples collected so far. */
  calibBegin(): void;
  /**
   * Collect samples for `ms` milliseconds while the user looks at (x, y). Resolves with the sample
   * count. `headMoving` marks a step where the user keeps looking at the point while moving their
   * head, which is what teaches the model to allow for head movement.
   */
  calibCollect(x: number, y: number, ms: number, headMoving?: boolean): Promise<number>;
  /** Fit a model from the collected samples and start using it. */
  calibFinish(): Promise<CalibrationResult>;
  /** Forget the calibration and go back to the built-in mapping. */
  calibClear(): void;
  /**
   * Tell the tracker where the user is looking right now, when the app has good reason to know
   * (they just clicked there, they are reading a prompt there). The tracker adds it to what it
   * learned at calibration, so it keeps getting more accurate in use. Optional to implement.
   */
  hint?(x: number, y: number, weight?: number): void;
}
