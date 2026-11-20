import type { CalibrationResult, GazeSample } from './types.js';

/**
 * The bridge wire format, version 1. Every message is one JSON text frame. docs/PROTOCOL.md is
 * the reference; the Unity and Unreal clients implement the same messages.
 */
export const PROTOCOL_VERSION = 1;
export const DEFAULT_BRIDGE_PORT = 8787;
export const DEFAULT_BRIDGE_TLS_PORT = 8788;

/** A tracker owns a camera and produces gaze. A display shows something and consumes gaze. */
export type Role = 'tracker' | 'display';

export interface HelloMessage {
  type: 'hello';
  v: number;
  role: Role;
  /** Trackers and displays in the same room are connected to each other. Default "default". */
  room?: string;
  name?: string;
}

export interface WelcomeMessage {
  type: 'welcome';
  v: number;
  id: string;
  room: string;
  trackers: number;
  displays: number;
}

/** Sent to everyone in a room whenever someone joins or leaves it. */
export interface PeersMessage {
  type: 'peers';
  trackers: number;
  displays: number;
}

/** Tracker to displays, once per camera frame. */
export interface GazeMessage extends GazeSample {
  type: 'gaze';
}

/** Display to trackers: drive a calibration whose targets the display is showing. */
export type CalibMessage =
  | { type: 'calib'; op: 'begin' }
  | { type: 'calib'; op: 'collect'; id: number; x: number; y: number; ms: number; headMoving?: boolean }
  | { type: 'calib'; op: 'finish'; id: number }
  | { type: 'calib'; op: 'clear' };

/** Tracker to displays: a `collect` finished. */
export interface CalibCollectedMessage {
  type: 'calib.collected';
  id: number;
  samples: number;
}

/** Tracker to displays: a `finish` produced this result. */
export interface CalibResultMessage extends CalibrationResult {
  type: 'calib.result';
  id: number;
}

export type BridgeMessage =
  | HelloMessage
  | WelcomeMessage
  | PeersMessage
  | GazeMessage
  | CalibMessage
  | CalibCollectedMessage
  | CalibResultMessage;

export function encode(message: BridgeMessage): string {
  return JSON.stringify(message);
}

/** Returns null for anything that is not a JSON object with a string `type`. */
export function decode(text: string): BridgeMessage | null {
  try {
    const m = JSON.parse(text) as { type?: unknown };
    return m && typeof m === 'object' && typeof m.type === 'string' ? (m as BridgeMessage) : null;
  } catch {
    return null;
  }
}

export function bridgeUrl(host = 'localhost', port = DEFAULT_BRIDGE_PORT, secure = false): string {
  return `${secure ? 'wss' : 'ws'}://${host}:${port}/gaze`;
}
