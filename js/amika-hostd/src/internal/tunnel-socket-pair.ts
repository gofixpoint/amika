/**
 * Two connected sockets with nothing under them.
 *
 * hostd does not parse HTTP for the tunnel. The relay sends a request head
 * and a body; hostd writes them into one end of this pair with Node's HTTP
 * client (or `ws`, for an upgrade), and hands the other end to the daemon's
 * own HTTP server as if a listener had accepted it. Node's parser runs at
 * both ends, so tunnel mode and listener mode serve through the same routes,
 * the same `Connection` rules and the same upgrade handler.
 *
 * In return Node needs objects that behave like `net.Socket`. The TCP
 * methods below are the cost. They do nothing, because there is no TCP: the
 * bytes already travel inside the tunnel's WebSocket.
 */
import { Duplex } from "node:stream";

/**
 * What `req.socket.remoteAddress` reports on the server's end. Nothing real
 * is behind it: the public client's address is the gateway's to know, and
 * the gateway forwards no claim about it, so inventing one here would be the
 * same lie one hop earlier. It is not loopback, so nothing downstream
 * mistakes a tunnelled request for a local one.
 */
const GATEWAY_PEER_ADDRESS = "0.0.0.0";

/** Connect two sockets. Bytes written to one are read from the other. */
export function socketPair(): [client: PairSocket, server: PairSocket] {
  const client = new PairSocket();
  const server = new PairSocket();
  client.link(server);
  server.link(client);
  return [client, server];
}

export class PairSocket extends Duplex {
  /**
   * `@hono/node-server` reads this to choose the scheme of the URL it builds,
   * and so decides whether hostd's `__Host-` cookies and its redirects come
   * out as `https`. It is true because it is true: the public request
   * reached the gateway over TLS, and these bytes travel inside the WSS
   * connection that carries it onward.
   */
  readonly encrypted = true;
  readonly remoteAddress = GATEWAY_PEER_ADDRESS;
  readonly remotePort = 0;
  readonly remoteFamily = "IPv4";
  readonly localAddress = "127.0.0.1";
  readonly localPort = 0;

  private peer?: PairSocket;
  /** A write the peer has not yet asked to read, held back as backpressure. */
  private pendingWrite?: (error?: Error) => void;
  private timer?: NodeJS.Timeout;
  /** 0 when no timeout is armed. See `setTimeout`. */
  private timeoutMs = 0;

  constructor() {
    // Half-open, because a client finishes sending a request long before
    // the response is written, and collapsing that into a full close would
    // cut off the reply before it started.
    super({ allowHalfOpen: true, highWaterMark: 64 * 1024 });
  }

  /** @internal */
  link(peer: PairSocket): void {
    this.peer = peer;
  }

  _read(): void {
    // The peer's writer was waiting for this side to want more.
    const resume = this.peer?.pendingWrite;
    if (resume && this.peer) {
      this.peer.pendingWrite = undefined;
      resume();
    }
  }

  _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const peer = this.peer;
    if (!peer || peer.destroyed || peer.readableEnded) {
      callback(epipe());
      return;
    }
    this.touch();
    peer.touch();
    // `push` returning false is the peer's reader saying it has enough. The
    // callback waits for its next `_read`, which is what stops a fast writer
    // from outrunning a slow handler.
    if (peer.push(chunk)) callback();
    else this.pendingWrite = callback;
  }

  _final(callback: (error?: Error | null) => void): void {
    // Only this side's writes are over. For an upgraded connection the
    // other side may still have bytes to send.
    const peer = this.peer;
    if (peer && !peer.destroyed && !peer.readableEnded) peer.push(null);
    callback();
  }

  _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    this.timeoutMs = 0;
    clearTimeout(this.timer);
    const peer = this.peer;
    // A write held back for this side's reader will never be read now.
    const pending = this.pendingWrite;
    this.pendingWrite = undefined;
    pending?.();
    if (peer?.pendingWrite) {
      const held = peer.pendingWrite;
      peer.pendingWrite = undefined;
      held(epipe());
    }
    if (peer && !peer.destroyed) {
      if (error) {
        // A failure. The other end hears it as a reset.
        peer.destroy(error);
      } else {
        // Not a reset. Node's HTTP server destroys a socket as the ordinary
        // end of a `Connection: close` exchange, and `net.Socket` sends a
        // FIN there. Resetting instead would tear down a response that was
        // already written. The peer reads EOF and then goes too, because
        // there is nobody left to write to.
        if (!peer.readableEnded) peer.push(null);
        peer.destroySoon();
      }
    }
    callback(error);
  }

  /**
   * End the writable half and tear down once it has flushed. Node's HTTP
   * server calls this to close a connection after a `Connection: close`
   * response, and `@hono/node-server` calls it on its own error path. A
   * missing method there is a `TypeError` inside the server.
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

  // Nagle and TCP keep-alive have no meaning here, but Node's HTTP server
  // and `ws` set them on every connection.
  setNoDelay(): this {
    return this;
  }

  setKeepAlive(): this {
    return this;
  }

  /**
   * Node's HTTP server arms `server.timeout` through this, and its client
   * arms a request's timeout, so it has to exist and has to emit `timeout`.
   * Unreferenced, so a pending one cannot hold the process open.
   *
   * This measures **inactivity**, as `net.Socket` does. A fixed deadline
   * would cut off a long download or an event stream while it was healthy.
   */
  setTimeout(milliseconds: number, callback?: () => void): this {
    // A destroyed socket ignores the call, as `net.Socket` does.
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

  /** Restart the inactivity timer, if one is armed. */
  private touch(): void {
    clearTimeout(this.timer);
    if (this.timeoutMs === 0) return;
    this.timer = setTimeout(() => this.emit("timeout"), this.timeoutMs).unref();
  }
}

function epipe(): Error {
  return Object.assign(new Error("write after the other end closed"), {
    code: "EPIPE",
  });
}
