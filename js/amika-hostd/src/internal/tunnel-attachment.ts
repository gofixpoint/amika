/**
 * One live attachment: the WebSocket to the gateway, the yamux session on
 * it, and the connections the gateway opens through it.
 *
 * The gateway opens one stream for each request or upgrade it forwards.
 * hostd opens none. That asymmetry is the protocol, and it is not a result
 * of which end dialled: a stream in the other direction would make the
 * gateway carry traffic *for* a host, which is a forward proxy. The gateway
 * sets `maxInboundStreams: 0` to refuse one; this end sets
 * `maxOutboundStreams: 0` so a bug here fails locally instead of being
 * refused at the far end and reported as a transport fault.
 *
 * An attachment knows nothing about reconnecting. It opens, it serves, and
 * it ends. `TunnelClient` decides what to do about that.
 */
import { yamux } from "@libp2p/yamux";
import type { Stream } from "@libp2p/interface";
import type { Duplex } from "node:stream";
import type { WebSocket } from "ws";
import { TunnelByteStream } from "./tunnel-byte-stream.js";
import { TunnelSocket } from "./tunnel-socket.js";

export interface TunnelLimits {
  /**
   * How many requests the gateway may have in flight to this host. The
   * gateway bounds the same number from its side; this one is what protects
   * the operator's machine if the gateway's bound is wrong or absent.
   */
  maxConcurrentStreams: number;
  /**
   * The largest yamux DATA frame, and so the stream window. It must be at
   * least the gateway's initial stream window, because the frame guard at
   * each end refuses anything larger and nothing negotiates the value.
   * Amika owns both ends, so keeping these two numbers equal is a
   * deployment rule that no code can enforce.
   */
  maxFrameBytes: number;
  /** The write buffer of each stream, and of the connection. */
  maxWriteBufferBytes: number;
  /** How large an outgoing WebSocket message may be before it is split. */
  maxMessageBytes: number;
}

/** The same numbers the gateway's `HostTunnel` is deployed with. */
export const DEFAULT_LIMITS: TunnelLimits = {
  maxConcurrentStreams: 256,
  maxFrameBytes: 256 * 1024,
  maxWriteBufferBytes: 4 * 1024 * 1024,
  maxMessageBytes: 64 * 1024,
};

export interface TunnelAttachmentOptions {
  limits?: TunnelLimits;
  /**
   * How often to ping the gateway. See `watchLiveness` for why this is
   * unconditional rather than driven by idleness.
   */
  keepAliveIntervalMs: number;
  /** How long a ping may go unanswered before the tunnel counts as dead. */
  pingTimeoutMs: number;
  /** How long `close` lets connections in flight finish. */
  drainMs: number;
  /** Hand one inbound connection to whatever serves HTTP on this host. */
  onConnection: (socket: Duplex) => void;
}

/**
 * The gateway's address as `req.socket.remoteAddress`, so nothing downstream
 * mistakes a tunnelled request for a loopback one. It is not a real address
 * and must not be read as one: the public client's address is the gateway's
 * to know, and the gateway deliberately forwards no claim about it.
 */
const GATEWAY_PEER_ADDRESS = "0.0.0.0";

export class TunnelAttachment {
  private readonly bytes: TunnelByteStream;
  /**
   * Left to inference. The declared `StreamMuxer` interface has no `ping`,
   * and the ping is this file's whole liveness story.
   */
  private readonly muxer;
  private readonly open = new Set<TunnelSocket>();
  private readonly closeListeners = new Set<(error?: Error) => void>();
  private keepAlive?: NodeJS.Timeout;
  private draining = false;
  private ended = false;
  private endError?: Error;
  private served = 0;
  /** Set while `drain` is waiting; called as each connection closes. */
  private whenIdle?: () => void;

  constructor(
    private readonly ws: WebSocket,
    private readonly options: TunnelAttachmentOptions,
  ) {
    const limits = options.limits ?? DEFAULT_LIMITS;
    this.bytes = new TunnelByteStream(ws, limits);
    this.muxer = yamux({
      // Off deliberately. The library's keep-alive sends pings and swallows
      // the error when one is not answered -- its own source carries a
      // "TODO: should abort here?" where the abort would go. A keep-alive
      // that cannot report a dead peer is the one thing this daemon needs
      // most, because the normal way a tunnel dies is a closed laptop lid,
      // where the socket stays in ESTABLISHED and nothing is reported at
      // all. `watchLiveness` runs the pings instead, with a deadline.
      enableKeepAlive: false,
      // Validated even when disabled, so it needs a legal value either way.
      keepAliveInterval: options.keepAliveIntervalMs,
      maxInboundStreams: limits.maxConcurrentStreams,
      maxOutboundStreams: 0,
      streamOptions: {
        initialStreamWindowSize: limits.maxFrameBytes,
        maxStreamWindowSize: limits.maxFrameBytes,
        // Per stream, not per connection. The library merges no default
        // here, so without this line every stream's write buffer is
        // unbounded, and a gateway that stops reading a response grows one
        // as far as this machine's memory allows.
        maxWriteBufferLength: limits.maxWriteBufferBytes,
      },
    })().createStreamMuxer(this.bytes);

    this.muxer.addEventListener("stream", (event) => {
      this.accept(event.detail);
    });
    // The byte stream knows first. It watches the duplex and the WebSocket,
    // and reports one disconnect however many events describe it.
    this.bytes.addEventListener("close", (event) => this.finish(event.error));
  }

  /**
   * Prove the tunnel works end to end, and start watching that it keeps
   * working.
   *
   * The round trip is a yamux ping, not a WebSocket ping. A WebSocket ping
   * is answered by the peer's `ws` library, below the multiplexer and below
   * the event loop that serves requests, so a pong proves only that bytes
   * move. A yamux ping is answered by the peer's multiplexer, so it proves
   * the whole stack that a request has to travel through.
   *
   * This is also as close to an attachment acknowledgement as the current
   * gateway can give. The gateway accepts the WebSocket first and
   * authorizes afterwards, and it reports a refusal by aborting the socket,
   * which on the wire is indistinguishable from a dropped connection. A
   * ping answered therefore means "the gateway is speaking this protocol",
   * not "the gateway has authorized this host". See `tunnel-client.ts` for
   * what is done about the difference, and `docs/tunnel.md` for the change
   * to the gateway that would remove it.
   */
  async acknowledge(): Promise<number> {
    const rttMs = await this.muxer.ping({
      signal: AbortSignal.timeout(this.options.pingTimeoutMs),
    });
    this.watchLiveness();
    return rttMs;
  }

  /** Call `listener` when this attachment stops working, for any reason. */
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

  /** How many connections the gateway has open through this attachment. */
  get activeConnections(): number {
    return this.open.size;
  }

  /** How many it has opened in total, which is how a session proves it worked. */
  get servedConnections(): number {
    return this.served;
  }

  /**
   * Stop serving and let the gateway know, bounding how long it takes.
   *
   * The order matters. Closing the WebSocket cleanly is what releases the
   * attachment at the far end: the gateway's close handler gives up the
   * route, so a daemon that has gone does not leave the gateway holding one
   * and answering requests into a socket nobody is reading. Dropping the
   * TCP connection instead leaves the gateway waiting for its own liveness
   * check to notice, and every request in that window is lost rather than
   * answered with `503 host_offline`.
   *
   * A caller with upgraded connections -- SSH, a terminal, a service
   * WebSocket -- should destroy those first. They are long-lived by design,
   * so waiting for them always runs the drain out to its bound, and hostd's
   * listener-mode shutdown makes the same distinction.
   */
  async close(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    clearInterval(this.keepAlive);
    await this.drain();
    for (const socket of this.open) socket.destroy();
    this.open.clear();
    await this.muxer
      .close({ signal: AbortSignal.timeout(this.options.pingTimeoutMs) })
      .catch(() => {
        // GO_AWAY is a courtesy. A gateway that has already gone cannot
        // acknowledge it, and the WebSocket close below is what matters.
      });
    // The multiplexer's close sends GO_AWAY and stops: it does not own the
    // connection. Without the close below the WebSocket stays open and the
    // gateway keeps routing to a daemon that has finished.
    await this.closeWebSocket();
  }

  /** Stop now, failing every connection on this attachment. */
  abort(error: Error): void {
    clearInterval(this.keepAlive);
    this.draining = true;
    // Before the teardown. The library's abort path reports a closed
    // transport with no error attached, so a listener registered through
    // `onEnded` would otherwise be told the tunnel ended for no reason --
    // and the reason is the whole point when the reason is an unanswered
    // ping.
    this.finish(error);
    this.muxer.abort(error);
    this.bytes.destroySocket(error);
  }

  /**
   * Close the WebSocket with 1001 "going away", and wait for the far end to
   * acknowledge it.
   *
   * The code is worth the trouble. The gateway logs why each attachment
   * ended, and an operator reading those logs has to be able to tell a
   * daemon that was asked to stop from one whose network vanished. Ending
   * the duplex instead closes with 1005 ("no status"), which is the same
   * thing the second case produces.
   */
  private async closeWebSocket(): Promise<void> {
    if (this.ws.readyState === this.ws.CLOSED) {
      this.bytes.destroySocket();
      return;
    }
    const closed = new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      // Bounded, because a peer that never answers a close frame would
      // otherwise hold up the daemon's shutdown for ever.
      const timer = setTimeout(() => {
        this.ws.terminate();
        resolve();
      }, this.options.pingTimeoutMs);
      timer.unref();
      this.ws.once("close", done);
    });
    this.ws.close(1001, "going away");
    await closed;
    this.bytes.destroySocket();
  }

  /**
   * Ping the gateway on a fixed interval, and end the attachment when one
   * goes unanswered.
   *
   * Unconditional, rather than only when the tunnel has been idle. Inbound
   * traffic proves the gateway can reach this host; it proves nothing about
   * the other direction, and a response that cannot be written is the
   * failure that matters. The cost of being wrong about that is one 12-byte
   * frame per interval.
   *
   * The interval doubles as the idle keep-alive the gateway's deployment
   * needs. An edge that closes an idle WebSocket after a minute or two
   * would otherwise cost every host a reconnect each hour of quiet.
   */
  private watchLiveness(): void {
    const { keepAliveIntervalMs, pingTimeoutMs } = this.options;
    this.keepAlive = setInterval(() => {
      if (this.ended || this.draining) return;
      this.muxer
        .ping({ signal: AbortSignal.timeout(pingTimeoutMs) })
        .catch(() => {
          if (this.ended || this.draining) return;
          this.abort(
            new Error(
              `Gateway did not answer a tunnel ping within ${pingTimeoutMs}ms`,
            ),
          );
        });
    }, keepAliveIntervalMs);
    // Nothing about a tunnel should hold the process open by itself.
    this.keepAlive.unref();
  }

  /** Give one inbound stream to the HTTP server, as a socket. */
  private accept(stream: Stream): void {
    // A stream that arrives after shutdown started is reset rather than
    // served. The gateway turns a reset into a `502`, which is a truthful
    // answer: this host is going away and will not finish the request.
    // Serving it instead would extend the drain indefinitely, because the
    // gateway keeps sending for as long as it holds the route.
    if (this.draining || this.ended) {
      stream.abort(new Error("hostd is shutting down"));
      return;
    }
    this.served += 1;
    const socket = new TunnelSocket(stream, {
      remoteAddress: GATEWAY_PEER_ADDRESS,
    });
    this.open.add(socket);
    socket.once("close", () => {
      this.open.delete(socket);
      this.whenIdle?.();
    });
    this.options.onConnection(socket);
  }

  /** Wait for the connections in flight, up to `drainMs`. */
  private async drain(): Promise<void> {
    if (this.open.size === 0) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.whenIdle = undefined;
        resolve();
      };
      const timer = setTimeout(done, this.options.drainMs);
      timer.unref();
      this.whenIdle = () => {
        if (this.open.size === 0) done();
      };
    });
  }

  /** Idempotent: several events can describe one disconnect. */
  private finish(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.endError = error;
    clearInterval(this.keepAlive);
    this.whenIdle?.();
    // The WebSocket may still be open when the duplex under it ends, and a
    // gateway that is merely slow to notice would keep the route. 1001 is
    // "going away".
    if (this.ws.readyState === this.ws.OPEN) this.ws.close(1001);
    for (const listener of this.closeListeners) listener(error);
    this.closeListeners.clear();
  }
}
