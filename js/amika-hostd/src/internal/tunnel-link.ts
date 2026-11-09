/**
 * One WebSocket to the relay: the bytes of the frames on it, and its
 * keep-alive.
 *
 * A link knows nothing about streams. A `TunnelSession` reads the frames.
 * In `amika.tunnel.v2` a session has one link and ends with it. In
 * `amika.tunnel.v3` a session outlives its link, and takes a new one when
 * the host dials again and the relay resumes the session.
 */
import type { RawData, WebSocket } from "ws";
import { PING, PONG, ProtocolError } from "@amika/tunnel-protocol";

export interface LinkOptions {
  /** How often to ping the relay. See `watchLiveness`. */
  keepAliveIntervalMs: number;
  /** How long a ping may go unanswered before it counts as missed. */
  pingTimeoutMs: number;
  /** How many pings in a row may be missed before the link counts as dead. */
  maxMissedPings: number;
}

/** Why a link ended, in words safe to log: never a close reason's text. */
export interface LinkEnd {
  error: Error;
  /** The close code the relay sent, when it sent one. */
  code?: number;
  /** `closed 1006`, `socket error`, `missed ping`, or `dropped`. */
  summary: string;
}

export class TunnelLink {
  private ended?: LinkEnd;
  private readonly endListeners = new Set<(error: Error) => void>();
  private keepAlive?: NodeJS.Timeout;
  /** Pings in a row with no `PONG`. Any `PONG` resets it. */
  private missedPings = 0;
  /** The ping awaiting its `PONG`, if any. */
  private pending?: {
    sentAt: number;
    resolve: (rttMs: number) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  };

  /**
   * `onFrame` gets each binary message. `onEnd` is called once, first of
   * every listener, when the link ends for any reason.
   */
  constructor(
    private readonly ws: WebSocket,
    private readonly options: LinkOptions,
    private readonly onFrame: (bytes: Buffer) => void,
    private readonly onEnd: (end: LinkEnd) => void,
  ) {
    ws.on("message", (data, isBinary) => this.onMessage(data, isBinary));
    ws.once("close", (code, reason) =>
      this.end({
        error: new Error(
          `the relay closed the tunnel (${code}${reason.length > 0 ? ` ${reason.toString("utf8")}` : ""})`,
        ),
        code,
        summary: `closed ${code}`,
      }),
    );
    ws.on("error", (error) =>
      this.end({
        // `ws` names a frame no WebSocket peer may send with a `WS_ERR_`
        // code. A relay that sends one would send it again on every
        // resume, so it is a protocol error and not a drop.
        error: isFrameError(error) ? new ProtocolError(error.message) : error,
        summary: "socket error",
      }),
    );
    // The dial pauses the socket so that no frame is emitted before these
    // listeners exist. Now they do.
    ws.resume();
  }

  get isEnded(): boolean {
    return this.ended !== undefined;
  }

  /** How many bytes `ws` holds that the network has not taken yet. */
  get bufferedAmount(): number {
    return this.ws.bufferedAmount;
  }

  /**
   * Prove the link works end to end, and start watching that it keeps
   * working. Resolves with the round trip of the first ping.
   */
  async acknowledge(): Promise<number> {
    const rttMs = await this.ping();
    this.watchLiveness();
    return rttMs;
  }

  /** Call `listener` when this link ends, for any reason. */
  onEnded(listener: (error: Error) => void): void {
    if (this.ended) {
      listener(this.ended.error);
      return;
    }
    this.endListeners.add(listener);
  }

  /** Send one frame's bytes. A link that is not open drops them. */
  send(bytes: Uint8Array): void {
    if (this.ended || this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(bytes, { binary: true });
  }

  /** Stop pinging. A link that is shutting down must not end on a ping. */
  quiet(): void {
    clearInterval(this.keepAlive);
  }

  /** End now: terminate the socket without a close handshake. */
  drop(error: Error): void {
    this.end({ error, summary: "dropped" });
    this.ws.terminate();
  }

  /**
   * Close with `code`, and wait for the far end to acknowledge it, up to
   * `timeoutMs`. The link ends when the close completes.
   */
  async close(code: number, reason: string, timeoutMs: number): Promise<void> {
    this.quiet();
    if (this.ws.readyState === this.ws.CLOSED) return;
    const closed = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.ws.terminate();
        resolve();
      }, timeoutMs);
      timer.unref();
      this.ws.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.ws.close(code, reason);
    await closed;
  }

  /**
   * Start a close with `code` and do not wait. For a session that ends
   * while a caller is not waiting on it.
   */
  closeSoon(code: number, reason: string): void {
    this.quiet();
    if (this.ws.readyState === this.ws.OPEN) this.ws.close(code, reason);
  }

  private onMessage(data: RawData, isBinary: boolean): void {
    if (this.ended) return;
    const bytes = Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.isBuffer(data)
        ? data
        : Buffer.from(data);
    if (!isBinary) {
      // The only text this end expects is the relay's answer to a ping.
      // Anything else means a peer that is not speaking this protocol.
      if (bytes.toString("utf8") === PONG) this.onPong();
      else this.drop(new ProtocolError("unexpected text message"));
      return;
    }
    this.onFrame(bytes);
  }

  // --- Liveness -------------------------------------------------------

  /** One ping, resolved with its round trip or rejected at the deadline. */
  private ping(): Promise<number> {
    if (this.ended) return Promise.reject(this.ended.error);
    if (this.pending) return Promise.reject(new Error("a ping is in flight"));
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        reject(
          new Error(
            `the relay did not answer a tunnel ping within ${this.options.pingTimeoutMs}ms`,
          ),
        );
      }, this.options.pingTimeoutMs);
      timer.unref();
      this.pending = { sentAt: Date.now(), resolve, reject, timer };
      if (this.ws.readyState === this.ws.OPEN) this.ws.send(PING);
    });
  }

  private onPong(): void {
    // A late answer still shows that the tunnel carries traffic.
    this.missedPings = 0;
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    pending.resolve(Date.now() - pending.sentAt);
  }

  /**
   * Ping on a fixed interval, and end the link when `maxMissedPings` pings
   * in a row go unanswered.
   *
   * A text `PING` and not a WebSocket ping frame. The relay's runtime
   * answers it without waking the relay, so an idle host costs nothing, and
   * the relay can read when it last answered to tell a live host from one
   * whose laptop lid closed. The normal way a tunnel dies is that lid: the
   * socket stays in `ESTABLISHED`, the kernel accepts writes, and nothing
   * reports anything. Only an unanswered round trip finds it.
   *
   * The interval doubles as the idle keep-alive that NATs and load
   * balancers need between here and the relay.
   */
  private watchLiveness(): void {
    // The link can end between the first pong and this call: an interval
    // set now would never be cleared.
    if (this.ended) return;
    this.keepAlive = setInterval(() => {
      if (this.ended || this.pending) return;
      this.ping().catch((error: Error) => {
        if (this.ended) return;
        this.missedPings += 1;
        if (this.missedPings < this.options.maxMissedPings) return;
        this.end({
          error: new Error(
            `${error.message}, ${this.missedPings} times in a row`,
          ),
          summary: "missed ping",
        });
        this.ws.terminate();
      });
    }, this.options.keepAliveIntervalMs);
    // Nothing about a tunnel should hold the process open by itself.
    this.keepAlive.unref();
  }

  /** Idempotent: several events can describe one disconnect. */
  private end(end: LinkEnd): void {
    if (this.ended) return;
    this.ended = end;
    clearInterval(this.keepAlive);
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(end.error);
      this.pending = undefined;
    }
    this.onEnd(end);
    for (const listener of this.endListeners) listener(end.error);
    this.endListeners.clear();
  }
}

function isFrameError(error: Error): boolean {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("WS_ERR_");
}
