/**
 * The tunnel's WebSocket, which the multiplexer reads as ordered bytes.
 *
 * yamux needs a byte stream. A WebSocket delivers messages. The two do not
 * align, and nothing here may align them: a yamux frame can span several
 * messages, and one message can carry several frames. No code here may treat
 * a message boundary as meaningful.
 *
 * This is the host end of the gateway's `WebSocketByteStream`. It is
 * deliberately the same class with one difference, `direction`, because the
 * two ends have to agree on every byte between them.
 */
import { AbstractMessageStream, type SendResult } from "@libp2p/utils";
import { defaultLogger } from "@libp2p/logger";
import type { MessageStreamDirection } from "@libp2p/interface";
import type { Uint8ArrayList } from "uint8arraylist";
import { createWebSocketStream, type WebSocket } from "ws";
import { YamuxFrameGuard } from "./tunnel-frame-guard.js";

export interface TunnelByteStreamOptions {
  /**
   * The largest DATA frame the gateway may declare. This is also the read
   * buffer: the decoder could never assemble a larger frame.
   *
   * The multiplexer refuses a value below 256 KiB, because the value becomes
   * the stream window and the library sets a floor for that. It must be at
   * least the gateway's own initial stream window, which nothing negotiates;
   * Amika owns both ends, so that is a deployment rule rather than a check.
   */
  maxFrameBytes: number;
  /** How much may be queued towards the gateway before backpressure. */
  maxWriteBufferBytes: number;
  /**
   * How large an outgoing write may be before this class splits it.
   *
   * It does **not** limit what arrives, although its name suggests so: `ws`
   * assembles a whole message before one byte reaches this class. Only
   * `maxPayload` on the `WebSocket` limits an inbound message, and that is a
   * construction option, so `dialTunnel` sets it.
   */
  maxMessageBytes: number;
  /**
   * Defaults to `"outbound"`, which is what hostd is: it dials.
   * `@libp2p/yamux` reads this to decide stream-id parity, so two ends that
   * agree on it refuse each other's streams. Only a test gateway, standing
   * in for the real one, has any reason to pass `"inbound"`.
   */
  direction?: MessageStreamDirection;
}

export class TunnelByteStream extends AbstractMessageStream {
  private readonly socket;
  private readonly guard;

  constructor(ws: WebSocket, options: TunnelByteStreamOptions) {
    super({
      direction: options.direction ?? "outbound",
      log: defaultLogger().forComponent("amika:hostd:tunnel"),
      maxMessageSize: options.maxMessageBytes,
      maxReadBufferLength: options.maxFrameBytes,
      maxWriteBufferLength: options.maxWriteBufferBytes,
    });
    this.guard = new YamuxFrameGuard(options.maxFrameBytes);
    // Binary frames only, matching the gateway. A text frame means a peer
    // that misread the connection, or something on the path that is not the
    // gateway at all. Those bytes do not belong in the decoder.
    ws.on("message", (_data, isBinary) => {
      if (!isBinary) {
        this.abort(new Error("Tunnel accepts binary WebSocket messages only"));
      }
    });
    this.socket = createWebSocketStream(ws, {
      highWaterMark: options.maxMessageBytes,
    });
    this.socket.on("data", (data: Buffer) => {
      // Dropped, not queued, after an abort. The decoder's framing is already
      // in doubt; more bytes only move the point of failure.
      if (this.status !== "open") return;
      try {
        this.guard.consume(data);
        this.onData(data);
      } catch (error) {
        this.abort(
          error instanceof Error ? error : new Error("Invalid tunnel frame"),
        );
      }
    });
    this.socket.on("drain", () => this.safeDispatchEvent("drain"));
    this.socket.on("error", (error) => this.closeTransport(error));
    // `createWebSocketStream` builds its duplex with `emitClose: false` and
    // `autoDestroy: false`, so a gateway that goes away produces `end` and
    // nothing else: no `close`, no `error`. Code that listens only for those
    // two believes a dead tunnel is live, and the daemon never reconnects.
    this.socket.on("end", () => this.closeTransport());
    ws.on("close", () => this.closeTransport());
    ws.on("error", (error) => this.closeTransport(error));
  }

  /** Close the WebSocket under this stream, for an orderly shutdown. */
  async closeSocket(): Promise<void> {
    await this.close();
  }

  /** Tear the WebSocket down now. */
  destroySocket(error?: Error): void {
    this.socket.destroy(error);
  }

  sendData(data: Uint8ArrayList): SendResult {
    // The multiplexer answers what it receives, so a frame can arrive after
    // the socket has ended and get a reply -- an inbound ping during
    // shutdown does this. A write then throws "write after end" where
    // nothing catches it. These bytes have nowhere to go, and the correct
    // answer is that the transport has gone, not an exception.
    if (!this.socket.writable) {
      this.closeTransport();
      return { sentBytes: data.byteLength, canSendMore: false };
    }
    return {
      sentBytes: data.byteLength,
      // `write` returning false is the socket's buffer filling, which the
      // multiplexer reads as "stop until drain" rather than as a failure.
      canSendMore: this.socket.write(Buffer.from(data.subarray())),
    };
  }

  sendReset(error: Error): void {
    this.socket.destroy(error);
  }

  sendPause(): void {
    this.socket.pause();
  }

  sendResume(): void {
    this.socket.resume();
  }

  async close(): Promise<void> {
    // An orderly close needs a transport that can still finish one. A tunnel
    // whose TCP connection died abruptly leaves `ws` holding a destroyed
    // socket, and the duplex's `_final` then waits for a `finish` that cannot
    // arrive: `ws.close()` is a no-op at readyState 3. `close` has no
    // deadline, so a shutdown that awaited it would hang for ever on a
    // tunnel that was reset. Nothing is lost by dropping it instead.
    if (this.status !== "open" || this.socket.destroyed) {
      this.socket.destroy();
      return;
    }
    await new Promise<void>((resolve, reject) => {
      // Removed on either outcome. An attached listener outlives the call
      // that added it, so a socket error after this promise settles would
      // call a `reject` that nobody holds.
      const onError = (error: Error) => {
        this.socket.removeListener("error", onError);
        reject(error);
      };
      this.socket.once("error", onError);
      this.socket.end(() => {
        this.socket.removeListener("error", onError);
        resolve();
      });
    });
  }

  /** Idempotent: several constructor events can describe one disconnect. */
  private closeTransport(error?: Error): void {
    if (this.status !== "open") return;
    this.onTransportClosed(error);
  }
}
