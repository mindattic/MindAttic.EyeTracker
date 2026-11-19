import { Emitter } from './emitter.js';
import { PROTOCOL_VERSION, decode, encode, type BridgeMessage, type PeersMessage, type Role } from './protocol.js';
import type { CalibrationResult, GazeSample, GazeSource } from './types.js';

export interface BridgeOptions {
  room?: string;
  name?: string;
  /** Milliseconds between reconnection attempts. Zero turns reconnection off. */
  reconnectMs?: number;
}

interface LinkEvents extends Record<string, unknown> {
  message: BridgeMessage;
  open: void;
  close: void;
}

/** A WebSocket to the bridge that says hello and reconnects by itself. Works in browsers and in Node 22+. */
class BridgeLink extends Emitter<LinkEvents> {
  private socket: WebSocket | null = null;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly url: string,
    private readonly role: Role,
    private readonly options: BridgeOptions,
  ) {
    super();
    this.connect();
  }

  get connected(): boolean {
    return this.socket?.readyState === 1;
  }

  private connect(): void {
    if (this.closed) return;
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.onopen = () => {
      socket.send(
        encode({ type: 'hello', v: PROTOCOL_VERSION, role: this.role, room: this.options.room, name: this.options.name }),
      );
      this.emit('open', undefined);
    };
    socket.onmessage = (ev) => {
      const message = typeof ev.data === 'string' ? decode(ev.data) : null;
      if (message) this.emit('message', message);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.emit('close', undefined);
      const wait = this.options.reconnectMs ?? 1500;
      if (!this.closed && wait > 0) this.timer = setTimeout(() => this.connect(), wait);
    };
    socket.onerror = () => socket.close();
  }

  send(message: BridgeMessage): boolean {
    if (!this.connected) return false;
    this.socket!.send(encode(message));
    return true;
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.socket?.close();
  }
}

export interface RemoteEvents extends Record<string, unknown> {
  gaze: GazeSample;
  /** How many trackers and displays share the room. */
  peers: PeersMessage;
  connection: boolean;
}

const FAILED: CalibrationResult = { ok: false, targets: 0, samples: 0, fitError: 0, crossError: 0 };

/**
 * A display's view of a tracker running somewhere else (a phone, another tab, another machine),
 * reached through the bridge. It is a GazeSource, so it calibrates and reads exactly like a local
 * EyeTracker: this side shows the targets, the far side collects the samples.
 */
export class RemoteGazeSource extends Emitter<RemoteEvents> implements GazeSource {
  latest: GazeSample | null = null;
  trackers = 0;
  private readonly link: BridgeLink;
  private nextId = 1;
  private waiting = new Map<number, (message: BridgeMessage | null) => void>();

  constructor(url: string, options: BridgeOptions = {}) {
    super();
    this.link = new BridgeLink(url, 'display', options);
    this.link.on('open', () => this.emit('connection', true));
    this.link.on('close', () => {
      this.trackers = 0;
      for (const done of this.waiting.values()) done(null);
      this.waiting.clear();
      this.emit('connection', false);
    });
    this.link.on('message', (m) => {
      if (m.type === 'gaze') {
        this.latest = m;
        this.emit('gaze', m);
      } else if (m.type === 'peers' || m.type === 'welcome') {
        this.trackers = m.trackers;
        this.emit('peers', { type: 'peers', trackers: m.trackers, displays: m.displays });
      } else if (m.type === 'calib.collected' || m.type === 'calib.result') {
        const done = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        done?.(m);
      }
    });
  }

  get connected(): boolean {
    return this.link.connected;
  }

  private request(id: number, timeoutMs: number): Promise<BridgeMessage | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve(null);
      }, timeoutMs);
      this.waiting.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
  }

  calibBegin(): void {
    this.link.send({ type: 'calib', op: 'begin' });
  }

  async calibCollect(x: number, y: number, ms: number): Promise<number> {
    const id = this.nextId++;
    if (!this.link.send({ type: 'calib', op: 'collect', id, x, y, ms })) return 0;
    const reply = await this.request(id, ms + 3000);
    return reply?.type === 'calib.collected' ? reply.samples : 0;
  }

  async calibFinish(): Promise<CalibrationResult> {
    const id = this.nextId++;
    if (!this.link.send({ type: 'calib', op: 'finish', id })) return { ...FAILED, reason: 'not connected to the bridge' };
    const reply = await this.request(id, 8000);
    if (reply?.type !== 'calib.result') return { ...FAILED, reason: 'the tracker did not answer' };
    const { type: _type, id: _id, ...result } = reply;
    return result;
  }

  calibClear(): void {
    this.link.send({ type: 'calib', op: 'clear' });
  }

  close(): void {
    this.link.close();
  }
}

export interface BridgePublisher {
  readonly connected: boolean;
  /** How many displays are listening. */
  readonly displays: number;
  onChange(handler: () => void): void;
  close(): void;
}

/**
 * Connect a local tracker to the bridge so displays elsewhere (a Unity or Unreal game, another
 * browser) receive its gaze and can calibrate it against their own screen.
 */
export function publishToBridge(source: GazeSource, url: string, options: BridgeOptions = {}): BridgePublisher {
  const link = new BridgeLink(url, 'tracker', options);
  let displays = 0;
  let changed: () => void = () => {};
  const off = source.on('gaze', (g) => {
    if (displays > 0) link.send({ type: 'gaze', ...g });
  });
  link.on('open', () => changed());
  link.on('close', () => {
    displays = 0;
    changed();
  });
  link.on('message', async (m) => {
    if (m.type === 'peers' || m.type === 'welcome') {
      displays = m.displays;
      changed();
    } else if (m.type === 'calib') {
      if (m.op === 'begin') source.calibBegin();
      else if (m.op === 'clear') source.calibClear();
      else if (m.op === 'collect') {
        const samples = await source.calibCollect(m.x, m.y, m.ms);
        link.send({ type: 'calib.collected', id: m.id, samples });
      } else if (m.op === 'finish') {
        const result = await source.calibFinish();
        link.send({ type: 'calib.result', id: m.id, ...result });
      }
    }
  });
  return {
    get connected() {
      return link.connected;
    },
    get displays() {
      return displays;
    },
    onChange(handler) {
      changed = handler;
    },
    close() {
      off();
      link.close();
    },
  };
}
