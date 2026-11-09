/**
 * Test support: an in-memory tunnel WebSocket that a test can cut, or make
 * silent, at any frame. No production code imports this module.
 *
 * hostd's end is a `FakeHostSocket`, which looks to `TunnelLink` like the
 * `ws` client it normally gets. The relay's end is whatever the test
 * attaches: a simulated relay here, the real one in amika-mono's
 * integration test. Messages cross on a later turn of the event loop, in
 * order, so a cut loses what is still in flight, as a real one does.
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

export class FaultPipe {
  readonly host: FakeHostSocket;
  /**
   * Drop every message both ways, and report nothing to either end, as a
   * path that breaks without a close does. hostd finds it by its ping.
   */
  silent = false;
  /** Cut once this many more binary messages have crossed, either way. */
  cutAfter?: number;
  private relayEnd?: PipeRelayEnd;
  private open = true;
  private readonly queue: Array<() => void> = [];
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

  /** Attach the relay's end. Messages before this are delivered to it. */
  attach(relayEnd: PipeRelayEnd): void {
    this.relayEnd = relayEnd;
  }

  /** The relay sends one message to hostd. */
  toHost(data: Uint8Array | string): void {
    if (!this.open || this.silent) return;
    const copy = typeof data === "string" ? data : Buffer.from(data);
    this.enqueue(() => {
      if (this.host.readyState !== OPEN) return;
      this.host.emit("message", copy, typeof copy !== "string");
    });
    if (typeof data !== "string") this.counted();
  }

  /** The relay closes its end with `code`. */
  closeFromRelay(code: number, reason = ""): void {
    if (!this.open) return;
    this.open = false;
    this.enqueue(() => this.host.closed(code, reason));
  }

  /**
   * The connection breaks. Messages in flight are lost. Each end sees
   * `1006`, except that a silent pipe tells the relay nothing.
   */
  cut(): void {
    if (!this.open) return;
    this.open = false;
    this.queue.length = 0;
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
    this.enqueue(() => this.relayEnd?.message(copy));
    if (typeof data !== "string") this.counted();
  }

  /** hostd closes its end with `code`. */
  closeFromHost(code: number): void {
    if (!this.open) return;
    this.open = false;
    this.enqueue(() => {
      this.relayEnd?.closed(code);
      this.host.closed(code, "");
    });
  }

  private counted(): void {
    if (this.cutAfter === undefined) return;
    this.cutAfter -= 1;
    if (this.cutAfter <= 0) {
      this.cutAfter = undefined;
      this.cut();
    }
  }

  private enqueue(deliver: () => void): void {
    this.queue.push(deliver);
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => this.drain());
  }

  private drain(): void {
    this.scheduled = false;
    // One at a time, so a cut that a delivery causes drops the rest.
    while (this.queue.length > 0) this.queue.shift()!();
  }
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
  /** What `ws` would hold unsent. A test sets it to simulate a backlog. */
  bufferedAmount = 0;

  constructor(
    private readonly pipe: FaultPipe,
    readonly protocol: string,
  ) {
    super();
  }

  send(data: Uint8Array | string): void {
    if (this.readyState !== OPEN) return;
    this.pipe.fromHost(data);
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
