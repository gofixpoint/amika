/**
 * One live attachment: the WebSocket to the relay, the frames on it, and the
 * streams the relay opens through it.
 *
 * The relay opens one stream for each request or upgrade it forwards.
 * hostd opens none. That asymmetry is the protocol, and it is not a result
 * of which end dialled: a stream in the other direction would make the
 * relay carry traffic *for* a host, which is a forward proxy. Nothing here
 * can send `OPEN`, and an `OPEN` is the only frame that creates a stream.
 *
 * A session knows nothing about reconnecting. It opens, it serves, and it
 * ends. `TunnelClient` decides what to do about that.
 */
import type { Duplex } from "node:stream";
import type { RawData, WebSocket } from "ws";
import {
  decodeFrame,
  encodeFrame,
  MalformedHeadError,
  MAX_CONCURRENT_STREAMS,
  PING,
  PONG,
  ProtocolError,
  type Frame,
} from "@amika/tunnel-protocol";
import {
  openStream,
  type StreamCarrier,
  type TunnelStream,
} from "./tunnel-bridge.js";

export interface TunnelSessionOptions {
  /** How often to ping the relay. See `watchLiveness`. */
  keepAliveIntervalMs: number;
  /** How long a ping may go unanswered before the tunnel counts as dead. */
  pingTimeoutMs: number;
  /** How long `close` lets streams in flight finish. */
  drainMs: number;
  /** Hand one inbound connection to whatever serves HTTP on this host. */
  onConnection: (socket: Duplex) => void;
}

/**
 * The tunnel's send buffer above which streams stop producing, and below
 * which they start again. The relay cannot push back on a caller, so this
 * is what bounds how much a fast server queues on this machine.
 */
const HIGH_WATER_BYTES = 4 * 1024 * 1024;
const LOW_WATER_BYTES = 1024 * 1024;
const WRITABLE_POLL_MS = 20;

export class TunnelSession implements StreamCarrier {
  private readonly streams = new Map<number, TunnelStream>();
  /**
   * The highest stream id the relay has opened. Ids only rise on one
   * connection, so this is the whole record of which have been used: a
   * finished stream leaves `streams`, and a late frame for it must not
   * reach a new stream that reused its id.
   */
  private lastStreamId = 0;
  private readonly closeListeners = new Set<(error?: Error) => void>();
  /** The id of the stream being opened, so an early finish is not lost. */
  private opening?: { streamId: number; finished: boolean };
  private keepAlive?: NodeJS.Timeout;
  /** The ping awaiting its `PONG`, if any. */
  private pending?: {
    sentAt: number;
    resolve: (rttMs: number) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  };
  private draining = false;
  private ended = false;
  private endError?: Error;
  private served = 0;
  /** Set while `drain` is waiting; called as each stream finishes. */
  private whenIdle?: () => void;
  private drainTimer?: NodeJS.Timeout;

  constructor(
    private readonly ws: WebSocket,
    private readonly options: TunnelSessionOptions,
  ) {
    ws.on("message", (data, isBinary) => this.onMessage(data, isBinary));
    ws.once("close", (code, reason) =>
      this.finish(
        new Error(
          `the relay closed the tunnel (${code}${reason.length > 0 ? ` ${reason.toString("utf8")}` : ""})`,
        ),
      ),
    );
    ws.on("error", (error) => this.finish(error));
  }

  /**
   * Prove the tunnel works end to end, and start watching that it keeps
   * working. Resolves with the round trip of the first ping.
   *
   * The relay authorizes before its `101`, so an open socket already means
   * an attached host. The ping proves the relay's edge answers, which is
   * what the daemon reports as ready.
   */
  async acknowledge(): Promise<number> {
    const rttMs = await this.ping();
    this.watchLiveness();
    return rttMs;
  }

  /** Call `listener` when this session stops working, for any reason. */
  onEnded(listener: (error?: Error) => void): void {
    if (this.ended) {
      listener(this.endError);
      return;
    }
    this.closeListeners.add(listener);
  }

  get isEnded(): boolean {
    return this.ended;
  }

  /** How many streams the relay has open through this session. */
  get activeConnections(): number {
    return this.streams.size;
  }

  /** How many it has opened in total, which is how a session proves it worked. */
  get servedConnections(): number {
    return this.served;
  }

  /**
   * Stop serving and let the relay know, bounding how long it takes.
   *
   * Closing the WebSocket cleanly is what releases the attachment at the
   * far end. Dropping the TCP connection instead leaves the relay routing
   * into a socket nobody reads until it presumes the host gone.
   *
   * A caller with upgraded connections -- SSH, a terminal, a service
   * WebSocket -- should destroy those first. They are long-lived by design,
   * so waiting for them always runs the drain out to its bound.
   */
  async close(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    clearInterval(this.keepAlive);
    await this.drain();
    for (const stream of [...this.streams.values()]) {
      stream.abort("hostd is shutting down");
    }
    this.streams.clear();
    await this.closeWebSocket();
  }

  /** Stop now, failing every stream on this session. */
  abort(error: Error): void {
    clearInterval(this.keepAlive);
    this.draining = true;
    this.finish(error);
    this.ws.terminate();
  }

  // --- StreamCarrier --------------------------------------------------

  send(frame: Frame): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(encodeFrame(frame), { binary: true });
  }

  congested(): boolean {
    return this.ws.bufferedAmount > HIGH_WATER_BYTES;
  }

  writable(): Promise<void> {
    if (this.ws.bufferedAmount <= LOW_WATER_BYTES || this.ended) {
      return Promise.resolve();
    }
    // `ws` raises no event when its buffer drains, so this polls. It runs
    // only while the tunnel is backed up.
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        if (this.ws.bufferedAmount <= LOW_WATER_BYTES || this.ended) {
          clearInterval(timer);
          resolve();
        }
      }, WRITABLE_POLL_MS);
      timer.unref();
    });
  }

  finished(streamId: number): void {
    if (this.opening?.streamId === streamId) this.opening.finished = true;
    this.streams.delete(streamId);
    this.whenIdle?.();
  }

  // --- Frames ---------------------------------------------------------

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
      else this.abort(new ProtocolError("unexpected text message"));
      return;
    }
    let frame: Frame;
    try {
      frame = decodeFrame(bytes);
    } catch (error) {
      // An `OPEN` whose head breaks the schema still names its stream, and
      // the relay builds heads from public requests. Refusing that one
      // stream keeps one caller's odd URL from cutting every other stream
      // on this host. Anything less readable means a peer that is not
      // speaking this protocol.
      if (error instanceof MalformedHeadError && error.frameType === "open") {
        if (this.claimStreamId(error.streamId)) {
          this.send({
            type: "reset",
            streamId: error.streamId,
            reason: error.message,
          });
        }
        return;
      }
      this.abort(
        error instanceof Error ? error : new ProtocolError("bad frame"),
      );
      return;
    }
    this.dispatch(frame);
  }

  private dispatch(frame: Frame): void {
    if (frame.type === "open") {
      this.accept(frame.streamId, frame.head);
      return;
    }
    if (frame.type === "response") {
      // Only the relay asks; a host never receives an answer.
      this.send({
        type: "reset",
        streamId: frame.streamId,
        reason: "a host receives no RESPONSE",
      });
      this.streams.get(frame.streamId)?.abort("RESPONSE sent to the host");
      return;
    }
    const stream = this.streams.get(frame.streamId);
    if (stream) {
      stream.receive(frame);
      return;
    }
    // A stream this end has already finished, or never had. A late frame
    // after a reset is ordinary and dropped. `DATA` is answered, so a relay
    // that still thinks the stream is open stops sending.
    if (frame.type === "data") {
      this.send({
        type: "reset",
        streamId: frame.streamId,
        reason: "no such stream",
      });
    }
  }

  /** Serve one `OPEN`, or refuse it with a reset. */
  private accept(
    streamId: number,
    head: Parameters<typeof openStream>[1],
  ): void {
    if (!this.claimStreamId(streamId)) return;
    // A stream that arrives after shutdown started is reset rather than
    // served. The relay turns a reset into a `502`, which is truthful: this
    // host is going away and will not finish the request.
    const refusal = this.draining
      ? "hostd is shutting down"
      : this.streams.size >= MAX_CONCURRENT_STREAMS
        ? "too many streams"
        : undefined;
    if (refusal) {
      this.send({ type: "reset", streamId, reason: refusal });
      return;
    }
    this.served += 1;
    this.opening = { streamId, finished: false };
    let stream: TunnelStream;
    try {
      stream = openStream(streamId, head, this, this.options.onConnection);
    } catch (error) {
      // Node's HTTP client and `ws` validate the head as they build the
      // request, and throw synchronously. This runs inside the WebSocket's
      // message handler, so a throw that escaped would end the daemon over
      // one bad stream. The schema refuses what Node refuses; this is the
      // second lock.
      this.opening = undefined;
      this.send({
        type: "reset",
        streamId,
        reason: error instanceof Error ? error.message : "bad request head",
      });
      return;
    }
    // A stream can fail inside its own constructor, a head with no host for
    // one, and report that before it was ever recorded here.
    if (!this.opening.finished) this.streams.set(streamId, stream);
    this.opening = undefined;
  }

  /**
   * Record the id of an `OPEN`, served or refused, or end the session for
   * one that does not rise. Returns whether the session carries on.
   */
  private claimStreamId(streamId: number): boolean {
    if (streamId <= this.lastStreamId) {
      // Ids rise and are never reused on a connection, so this peer is
      // confused about which stream is which, and nothing it sends can be
      // trusted.
      this.abort(
        new ProtocolError(
          `stream ${streamId} opened after stream ${this.lastStreamId}`,
        ),
      );
      return false;
    }
    this.lastStreamId = streamId;
    return true;
  }

  // --- Liveness -------------------------------------------------------

  /** One ping, resolved with its round trip or rejected at the deadline. */
  private ping(): Promise<number> {
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
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    pending.resolve(Date.now() - pending.sentAt);
  }

  /**
   * Ping on a fixed interval, and end the session when one goes unanswered.
   *
   * A text `ping` and not a WebSocket ping frame. The relay's runtime
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
    // The session can end between the first pong and this call, and
    // `finish` has already run: an interval set now would never be cleared.
    if (this.ended) return;
    this.keepAlive = setInterval(() => {
      if (this.ended || this.draining || this.pending) return;
      this.ping().catch((error: Error) => {
        if (this.ended || this.draining) return;
        this.abort(error);
      });
    }, this.options.keepAliveIntervalMs);
    // Nothing about a tunnel should hold the process open by itself.
    this.keepAlive.unref();
  }

  // --- Ending ---------------------------------------------------------

  /** Wait for the streams in flight, up to `drainMs`. */
  private async drain(): Promise<void> {
    if (this.streams.size === 0) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(this.drainTimer);
        this.whenIdle = undefined;
        resolve();
      };
      this.drainTimer = setTimeout(done, this.options.drainMs);
      this.drainTimer.unref();
      this.whenIdle = () => {
        if (this.streams.size === 0 || this.ended) done();
      };
    });
  }

  /**
   * Close the WebSocket with 1001 "going away", and wait for the far end to
   * acknowledge it. The code lets the relay's logs tell a daemon that was
   * asked to stop from one whose network vanished.
   */
  private async closeWebSocket(): Promise<void> {
    if (this.ws.readyState === this.ws.CLOSED) return;
    const closed = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.ws.terminate();
        resolve();
      }, this.options.pingTimeoutMs);
      timer.unref();
      this.ws.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.ws.close(1001, "going away");
    await closed;
  }

  /** Idempotent: several events can describe one disconnect. */
  private finish(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.endError = error;
    clearInterval(this.keepAlive);
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error ?? new Error("the tunnel ended"));
      this.pending = undefined;
    }
    for (const stream of [...this.streams.values()]) {
      stream.abort(error?.message ?? "the tunnel ended");
    }
    this.streams.clear();
    this.whenIdle?.();
    if (this.ws.readyState === this.ws.OPEN) this.ws.close(1001);
    for (const listener of this.closeListeners) listener(error);
    this.closeListeners.clear();
  }
}
