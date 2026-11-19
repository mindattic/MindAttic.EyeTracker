import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, bridgeUrl, decode, encode } from '../src/protocol.js';

describe('protocol', () => {
  it('round-trips a gaze message', () => {
    const message = {
      type: 'gaze' as const,
      t: 12.5,
      x: 0.25,
      y: 0.75,
      rawX: 0.26,
      rawY: 0.74,
      confidence: 0.9,
      face: true,
      blink: false,
      calibrated: true,
    };
    expect(decode(encode(message))).toEqual(message);
  });

  it('round-trips a hello', () => {
    const hello = { type: 'hello' as const, v: PROTOCOL_VERSION, role: 'display' as const, room: 'den' };
    expect(decode(encode(hello))).toEqual(hello);
  });

  it('rejects text that is not a typed JSON object', () => {
    expect(decode('not json')).toBeNull();
    expect(decode('42')).toBeNull();
    expect(decode('null')).toBeNull();
    expect(decode('{"x":1}')).toBeNull();
  });

  it('builds bridge addresses', () => {
    expect(bridgeUrl()).toBe('ws://localhost:8787/gaze');
    expect(bridgeUrl('192.168.1.20', 8788, true)).toBe('wss://192.168.1.20:8788/gaze');
  });
});
