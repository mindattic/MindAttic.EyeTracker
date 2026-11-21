/**
 * @mindattic/webcam: the webcam core plus its modules. The subpaths import one piece each
 * (/eyetracking, /presence, /headpose, /integrity, /core); this root re-exports all of them, which
 * is also what the old @mindattic/eyetracker name resolves to.
 */
export * from './webcam.js';
export * from './eyetracking.js';
