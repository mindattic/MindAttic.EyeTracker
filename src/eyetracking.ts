/**
 * The eye tracking module (@mindattic/webcam/eyetracking): camera-driven gaze with calibration.
 * Everything here was the whole of @mindattic/eyetracker before it became one module of the webcam
 * library. Share a WebcamCore with the other modules by passing `{ core }` to the EyeTracker.
 */
export * from './core.js';
export * from './camera.js';
export * from './eyeTracker.js';
export * from './calibrationUI.js';
export * from './mouseSource.js';
export * from './screenSpace.js';
