/**
 * One yamux stream, with enough of a socket for `node:http` to serve on it.
 *
 * hostd does not parse HTTP for the tunnel. It hands Node's HTTP server a
 * connection and lets it read the request and write the response, exactly as
 * it does for a listening socket, so tunnel mode and listener mode run the
 * same routes through the same parser. Chunked bodies, `Transfer-Encoding`,
 * continuation lines and `Connection` rules are difficult, and Node already
 * handles them.
 *
 * In return Node needs an object that behaves like `net.Socket`. The TCP
 * methods below are the cost. They do nothing, because there is no TCP here:
 * the bytes already travel inside an established WebSocket.
 *
 * This is the mirror of the gateway's `StreamDuplex`, which gives the same
 * shape to Node's HTTP *client*.
 */
import { Duplex } from "node:stream";
import type { Stream, StreamMessageEvent } from "@libp2p/interface";

export interface TunnelSocketOptions {
  /**
   * What `req.socket.remoteAddress` reports. Nothing real is behind it: the
   * public client's address is the gateway's to know, and the gateway
   * deliberately sends no `x-forwarded-for`, so inventing one here would be
   * the same lie one hop earlier. The gateway's own address is the honest
   * answer to "who opened this connection".
   */
  remoteAddress?: string;
  remotePort?: number;
}

export class TunnelSocket extends Duplex {
  /**
   * `@hono/node-server` reads this to choose the scheme of the URL it builds,
   * and so decides whether hostd's `__Host-` cookies and its redirects come
   * out as `https`. It is true because it is true: the public request
   * reached the gateway over TLS, and this stream is inside the WSS
   * connection that carries it onward. The gateway drops every
   * `x-forwarded-*` header a client sent and adds none of its own, so this
   * flag is the only thing that can carry the fact.
   */
  readonly encrypted = true;
  readonly remoteAddress: string;
  readonly remotePort: number;
  readonly remoteFamily = "IPv4";
  readonly localAddress = "127.0.0.1";
  readonly localPort = 0;

  private timer?: NodeJS.Timeout;
  /** 0 when no timeout is armed. See `setTimeout`. */
  private timeoutMs = 0;
  /** The half-close in progress, so it is started at most once. */
  private closing?: Promise<void>;
  private readonly onMessage;
  private readonly onRemoteEnd;
  private readonly onClose;

  constructor(
    private readonly stream: Stream,
    options: TunnelSocketOptions = {},
  ) {
    // Half-open, because the gateway finishes sending a request long before
    // the response is written, and collapsing that into a full close would
    // cut off the reply before it started.
    super({ allowHalfOpen: true, highWaterMark: 64 * 1024 });
    this.remoteAddress = options.remoteAddress ?? "0.0.0.0";
    this.remotePort = options.remotePort ?? 0;

    this.onMessage = (event: StreamMessageEvent) => {
      // `push` returning false is Node's reader saying it has enough; the
      // yamux stream pauses until `_read` asks for more, which is what stops
      // a fast uploader outrunning a slow handler.
      this.touch();
      if (!this.push(Buffer.from(event.data.subarray()))) stream.pause();
    };
    this.onRemoteEnd = () => this.push(null);
    this.onClose = (event: { error?: Error }) => {
      if (event.error) {
        this.destroy(event.error);
        return;
      }
      // Only EOF if the readable half really did end. A close that arrives
      // while bytes are still buffered must let them through first, or the
      // last chunk of an upload is silently dropped.
      if (stream.readableEnded) this.push(null);
    };

    stream.addEventListener("message", this.onMessage);
    stream.addEventListener("end", this.onRemoteEnd);
    stream.addEventListener("close", this.onClose);
    // A stream that ended before anyone listened still has to report EOF.
    if (stream.readableEnded) this.push(null);
  }

  _read(): void {
    if (this.stream.readStatus === "paused") this.stream.resume();
  }

  _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.touch();
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      this.stream.removeEventListener("drain", onDrain);
      this.stream.removeEventListener("close", onClose);
      callback(error);
    };
    const onDrain = () => finish();
    const onClose = (event: { error?: Error }) =>
      finish(event.error ?? new Error("Stream closed while waiting to send"));

    // Listeners first: `send` can abort the stream synchronously when its
    // write buffer overflows, and a `close` fired before anyone is listening
    // leaves this callback pending for ever, which stalls the response
    // rather than failing it.
    this.stream.addEventListener("drain", onDrain, { once: true });
    this.stream.addEventListener("close", onClose, { once: true });
    try {
      if (this.stream.send(chunk)) finish();
      else if (this.stream.status !== "open") {
        finish(new Error("Stream closed while sending"));
      }
    } catch (error) {
      finish(error instanceof Error ? error : new Error("Tunnel write failed"));
    }
  }

  _final(callback: (error?: Error | null) => void): void {
    // Closes only the sending half. For an upgraded connection the gateway
    // may still have bytes to send after hostd stops writing.
    this.closeStream().then(() => callback(), callback);
  }

  _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    // Clearing the timer stops the armed one. Zeroing the interval stops
    // `touch` arming another, and `setTimeout` refuses on a destroyed socket,
    // so nothing can put the interval back.
    this.timeoutMs = 0;
    clearTimeout(this.timer);
    this.stream.removeEventListener("message", this.onMessage);
    this.stream.removeEventListener("end", this.onRemoteEnd);
    this.stream.removeEventListener("close", this.onClose);
    if (error) {
      // A reset, which is what a failure is. The gateway turns it into a
      // `502` for the public client rather than a truncated `200`.
      this.stream.abort(error);
    } else {
      // Not a reset. Node's HTTP server destroys a socket as the ordinary
      // end of a `Connection: close` exchange, through `destroySoon`, and
      // `net.Socket` sends a FIN there and not an RST. Resetting instead
      // tears the stream down under a response that was already written,
      // and the gateway reports a request that in fact succeeded as a
      // transport failure. Every ordinary request takes this path, so the
      // mistake is not an edge case: it is all of them.
      void this.closeStream();
    }
    callback(error);
  }

  /** Half-close the stream, at most once, bounded so it cannot hang. */
  private closeStream(): Promise<void> {
    this.closing ??= this.stream
      .close({ signal: AbortSignal.timeout(CLOSE_TIMEOUT_MS) })
      .catch(() => {
        // A peer that never acknowledges the close, or a stream already
        // gone. Neither is something this socket can do anything about,
        // and both end the same way.
      });
    return this.closing;
  }

  /**
   * End the writable half and tear down once it has flushed. Node's HTTP
   * server calls this to close a connection after a `Connection: close`
   * response, and `@hono/node-server` calls it on its own error path. A
   * missing method there is a `TypeError` inside the server, not a failed
   * request, so it takes the whole stream down with no status.
   */
  destroySoon(): void {
    if (this.destroyed) return;
    if (this.writableFinished) this.destroy();
    else this.end(() => this.destroy());
  }

  /** There is no listening socket under this; the shape is what Node reads. */
  address(): Record<string, never> {
    return {};
  }

  // Nagle and TCP keep-alive have no meaning inside an established
  // WebSocket, but Node's HTTP server sets them on every connection.
  setNoDelay(): this {
    return this;
  }

  setKeepAlive(): this {
    return this;
  }

  /**
   * Node's HTTP server arms `server.requestTimeout` and `server.timeout`
   * through this, so it has to exist and has to emit `timeout`. There is no
   * socket to ask, so the timer is kept here. Unreferenced, so a pending one
   * cannot hold the process open.
   *
   * This measures **inactivity**, as `net.Socket` does. A fixed deadline
   * would be a different contract, and it would cut off a long download or
   * an event stream while it was healthy.
   */
  setTimeout(milliseconds: number, callback?: () => void): this {
    // A destroyed socket ignores the call, as `net.Socket` does. Without
    // this, code on the failure path re-arms a timer on a dead socket and a
    // request that already failed hears `timeout` one more time.
    if (this.destroyed) return this;
    if (callback) {
      // Zero takes the callback back off. That is Node's own cancel idiom.
      if (milliseconds > 0) this.once("timeout", callback);
      else this.removeListener("timeout", callback);
    }
    this.timeoutMs = milliseconds > 0 ? milliseconds : 0;
    this.touch();
    return this;
  }

  /** `net.Socket`'s, so nothing that holds one keeps the process alive. */
  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  /**
   * Restart the inactivity timer, if one is armed. Called from both
   * directions of traffic.
   */
  private touch(): void {
    clearTimeout(this.timer);
    if (this.timeoutMs === 0) return;
    this.timer = setTimeout(() => this.emit("timeout"), this.timeoutMs).unref();
  }
}

/** How long a half-close may take before the stream is torn down instead. */
const CLOSE_TIMEOUT_MS = 5_000;
