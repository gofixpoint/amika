/**
 * Test support: an in-memory tunnel WebSocket that a test can cut, slow, or
 * make silent, at any frame. No production code imports this module.
 *
 * hostd's end is a `FakeHostSocket`, which looks to `TunnelLink` like the
 * `ws` client it normally gets. The relay's end is whatever the test
 * attaches: a simulated relay here, the real one in amika-mono's
 * integration test. Each direction is one queue, delivered on a later turn
 * of the event loop and in order, text and binary alike, so a cut loses
 * what is still in flight and a slow link holds a ping behind the data
 * sent before it, as real ones do.
 */
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";

/** What the relay's end of a pipe does with what crosses it. */
export interface PipeRelayEnd {
  /** One message from hostd: bytes for a binary message, a string for text. */
  message(data: Uint8Array | string): void;
  /** hostd closed with `code`, or the pipe was cut (`1006`). */
  closed(code: number): void;
}

/** One direction's queue. */
interface Lane {
  queue: Array<{ deliver: () => void; bytes: number }>;
  queuedBytes: number;
  budget: number;
  refilledAt: number;
}

export class FaultPipe {
  readonly host: FakeHostSocket;
  /**
   * Drop every message both ways, and report nothing to either end, as a
   * path that breaks without a close does. hostd finds it by its ping.
   */
  silent = false;
  /** Cut once this many more binary messages have crossed, either way. */
  cutAfter?: number;
  /** Carry at most this many bytes a second each way. Unset is unlimited. */
  bytesPerSecond?: number;
  private relayEnd?: PipeRelayEnd;
  private open = true;
  private readonly toHostLane = lane();
  private readonly toRelayLane = lane();
  private scheduled = false;

  constructor(protocol: string) {
    this.host = new FakeHostSocket(this, protocol);
  }

  /** hostd's end, as the `ws` client the tunnel takes. */
  get hostSocket(): WebSocket {
    return this.host as unknown as WebSocket;
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Bytes hostd sent that have not reached the relay yet. */
  get queuedFromHost(): number {
    return this.toRelayLane.queuedBytes;
  }

  /** Attach the relay's end. Messages before this are delivered to it. */
  attach(relayEnd: PipeRelayEnd): void {
    this.relayEnd = relayEnd;
  }

  /** The relay sends one message to hostd. */
  toHost(data: Uint8Array | string): void {
    if (!this.open || this.silent) return;
    const copy = typeof data === "string" ? data : Buffer.from(data);
    this.enqueue(this.toHostLane, () => this.host.deliver(copy), sizeOf(data));
    if (typeof data !== "string") this.counted();
  }

  /** The relay closes its end with `code`. */
  closeFromRelay(code: number, reason = ""): void {
    if (!this.open) return;
    this.open = false;
    this.enqueue(this.toHostLane, () => this.host.closed(code, reason), 0);
  }

  /**
   * The connection breaks. Messages in flight are lost. Each end sees
   * `1006`, except that a silent pipe tells the relay nothing.
   */
  cut(): void {
    if (!this.open) return;
    this.open = false;
    for (const each of [this.toHostLane, this.toRelayLane]) {
      each.queue.length = 0;
      each.queuedBytes = 0;
    }
    const tellRelay = !this.silent;
    setImmediate(() => {
      this.host.closed(1006, "");
      if (tellRelay) this.relayEnd?.closed(1006);
    });
  }

  /** hostd sends one message. */
  fromHost(data: Uint8Array | string): void {
    if (!this.open || this.silent) return;
    const copy = typeof data === "string" ? data : new Uint8Array(data);
    this.enqueue(
      this.toRelayLane,
      () => this.relayEnd?.message(copy),
      sizeOf(data),
    );
    if (typeof data !== "string") this.counted();
  }

  /** hostd closes its end with `code`. */
  closeFromHost(code: number): void {
    if (!this.open) return;
    this.open = false;
    this.enqueue(
      this.toRelayLane,
      () => {
        this.relayEnd?.closed(code);
        this.host.closed(code, "");
      },
      0,
    );
  }

  private counted(): void {
    if (this.cutAfter === undefined) return;
    this.cutAfter -= 1;
    if (this.cutAfter <= 0) {
      this.cutAfter = undefined;
      this.cut();
    }
  }

  private enqueue(into: Lane, deliver: () => void, bytes: number): void {
    into.queue.push({ deliver, bytes });
    into.queuedBytes += bytes;
    this.schedule(0);
  }

  private schedule(delayMs: number): void {
    if (this.scheduled) return;
    this.scheduled = true;
    const run = () => {
      this.scheduled = false;
      this.drain();
    };
    if (delayMs === 0) setImmediate(run);
    else setTimeout(run, delayMs);
  }

  private drain(): void {
    for (const each of [this.toRelayLane, this.toHostLane])
      this.drainLane(each);
    if (this.toRelayLane.queue.length > 0 || this.toHostLane.queue.length > 0) {
      this.schedule(this.bytesPerSecond === undefined ? 0 : 5);
    }
  }

  /** Deliver what the rate allows, one at a time, so a cut drops the rest. */
  private drainLane(from: Lane): void {
    const rate = this.bytesPerSecond;
    if (rate !== undefined) {
      const now = Date.now();
      // A burst of at most 20 ms of the rate.
      from.budget = Math.min(
        rate / 50,
        from.budget + ((now - from.refilledAt) * rate) / 1000,
      );
      from.refilledAt = now;
    }
    while (from.queue.length > 0) {
      if (rate !== undefined && from.budget <= 0) return;
      const next = from.queue.shift()!;
      from.queuedBytes -= next.bytes;
      from.budget -= next.bytes;
      next.deliver();
    }
  }
}

function lane(): Lane {
  return { queue: [], queuedBytes: 0, budget: 0, refilledAt: Date.now() };
}

function sizeOf(data: Uint8Array | string): number {
  return typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/** The subset of `ws`'s client that `TunnelLink` and the dial use. */
export class FakeHostSocket extends EventEmitter {
  readonly CONNECTING = CONNECTING;
  readonly OPEN = OPEN;
  readonly CLOSING = CLOSING;
  readonly CLOSED = CLOSED;
  readyState = OPEN;
  /**
   * Starts paused, as `dialTunnel` leaves a real socket: nothing is emitted
   * until `TunnelLink` resumes it.
   */
  private paused = true;
  private held: Array<Uint8Array | string> = [];

  constructor(
    private readonly pipe: FaultPipe,
    readonly protocol: string,
  ) {
    super();
  }

  /** What `ws` would hold unsent: what has not crossed the pipe yet. */
  get bufferedAmount(): number {
    return this.pipe.queuedFromHost;
  }

  send(data: Uint8Array | string): void {
    if (this.readyState !== OPEN) return;
    this.pipe.fromHost(data);
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    const held = this.held;
    this.held = [];
    for (const data of held) this.deliver(data);
  }

  /** One message from the relay arrives. */
  deliver(data: Uint8Array | string): void {
    if (this.readyState !== OPEN) return;
    if (this.paused) {
      this.held.push(data);
      return;
    }
    this.emit("message", data, typeof data !== "string");
  }

  close(code = 1005): void {
    if (this.readyState !== OPEN) return;
    this.readyState = CLOSING;
    this.pipe.closeFromHost(code);
  }

  terminate(): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSING;
    this.pipe.cut();
  }

  /** The close completed, with `code`. */
  closed(code: number, reason: string): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.emit("close", code, Buffer.from(reason));
  }
}
