/**
 * One stream the relay opened, turned into a connection to this daemon's own
 * HTTP server.
 *
 * The relay sends a request head and a body; it never sends HTTP bytes.
 * Each stream gets a socket pair: one end goes to the daemon's virtual
 * server exactly as a listener's accepted socket would, and Node's HTTP
 * client (or `ws`, for an upgrade) writes the request into the other end.
 * Node parses at both ends, so nothing here reads HTTP.
 *
 * A plain request moves bodies as `DATA` under credit, in both directions.
 * An upgrade becomes a WebSocket at this end too, and messages and close
 * codes cross the tunnel one for one.
 */
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, type RawData } from "ws";
import {
  closeReason,
  MAX_DATA_BYTES,
  MAX_MESSAGE_BYTES,
  sendableCloseCode,
  type Frame,
  type HeaderPair,
  type RequestHead,
} from "@amika/tunnel-protocol";
import { ReceiveWindow, SendWindow } from "@amika/tunnel-protocol/window";
import { socketPair } from "./tunnel-socket-pair.js";

/** What a stream needs from the session that carries it. */
export interface StreamCarrier {
  send(frame: Frame): void;
  /** Whether the tunnel's own send buffer is over its high-water mark. */
  congested(): boolean;
  /** Resolves once the tunnel's send buffer has drained below its low mark. */
  writable(): Promise<void>;
  /** The stream is over at this end. The session forgets it. */
  finished(streamId: number): void;
}

/** One stream's handling of the frames addressed to it. */
export interface TunnelStream {
  receive(frame: Frame): void;
  /** The tunnel is gone. Tear down without sending anything. */
  abort(reason: string): void;
}

/** Start serving one `OPEN`. */
export function openStream(
  streamId: number,
  head: RequestHead,
  carrier: StreamCarrier,
  accept: (socket: Duplex) => void,
): TunnelStream {
  return head.upgrade
    ? new UpgradeStream(streamId, head, carrier, accept)
    : new RequestStream(streamId, head, carrier, accept);
}

/**
 * Hop-by-hop headers. The relay has already dropped them; this end drops
 * them again because the request it writes is a new hop, and Node frames
 * the body itself.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Headers `ws` writes for its own handshake. A second copy would conflict. */
const HANDSHAKE = new Set([
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
]);

/** Methods whose requests carry no body from a Fetch caller. */
const BODILESS = new Set(["GET", "HEAD"]);

/**
 * A plain request: `OPEN`, `DATA*`, `END` in, `RESPONSE`, `DATA*`, `END`
 * out. Over once both `END`s have passed, or at a `RESET` either way.
 */
class RequestStream implements TunnelStream {
  private readonly sendWindow = new SendWindow();
  private readonly receiveWindow = new ReceiveWindow();
  private readonly outbound: ClientRequest;
  private readonly client: Duplex;
  private readonly bodyAllowed: boolean;
  private requestEnded = false;
  private responseStarted = false;
  private responseEnded = false;
  private done = false;

  constructor(
    private readonly streamId: number,
    head: RequestHead,
    private readonly carrier: StreamCarrier,
    accept: (socket: Duplex) => void,
  ) {
    const [client, server] = socketPair();
    this.client = client;
    const { headers, bodyAllowed } = requestHeaders(head);
    this.bodyAllowed = bodyAllowed;
    this.outbound = httpRequest({
      method: head.method,
      path: head.target,
      // Node writes header values as Latin-1, which is how the relay
      // spells them: one character per byte.
      headers: headers.flat(),
      // The pair is the connection. No `agent` key at all: `agent: false`
      // makes Node build a fresh default agent, and an agent ignores
      // `createConnection` and dials a real TCP socket instead. Left unset,
      // Node uses the socket below and sends `Connection: close`, which is
      // right: one request, one stream.
      createConnection: () => client,
      setHost: false,
    });
    // Only once the request is built. Node validates the head as it builds
    // it and throws; a server end handed over before that would be left
    // waiting on a request that never comes. Node writes nothing to the
    // connection until a later tick, so the server has its end in time.
    accept(server);
    this.outbound.once("response", (response) => {
      this.responseStarted = true;
      void this.relayResponse(response);
    });
    // A `101` to a request that asked for no upgrade is a protocol fault
    // on the server's side. Without a listener Node destroys the socket and
    // raises nothing, and the relay would wait out its deadline.
    this.outbound.once("upgrade", () =>
      this.reset("hostd answered an ordinary request with 101"),
    );
    // Once the response has started, its own reader decides how the
    // stream ends: a response cut off part way is reset there. A server
    // that answers before reading the whole upload is allowed to, and the
    // write errors that follow are not a failure of the answer.
    this.outbound.on("error", (error) => {
      if (!this.responseStarted) this.reset(error.message);
    });
    this.outbound.once("close", () => {
      if (!this.responseStarted) this.reset("hostd closed the request");
    });
  }

  receive(frame: Frame): void {
    if (this.done) return;
    switch (frame.type) {
      case "data":
        if (this.requestEnded) {
          this.reset("DATA after END");
          return;
        }
        if (!this.bodyAllowed) {
          this.reset("DATA on a request whose head declares no body");
          return;
        }
        if (!this.receiveWindow.receive(frame.bytes.byteLength)) {
          this.reset("DATA beyond the credit granted");
          return;
        }
        if (this.responseEnded) {
          // The server has answered and gone. Drop the rest of the upload,
          // but keep granting credit so the relay can reach its `END`.
          this.grant(frame.bytes.byteLength);
          return;
        }
        // Credit goes back once Node has taken the bytes, so the relay is
        // never more than one window ahead of the server reading them.
        this.outbound.write(frame.bytes, () =>
          this.grant(frame.bytes.byteLength),
        );
        return;
      case "end":
        if (this.requestEnded) return;
        this.requestEnded = true;
        if (!this.responseEnded) this.outbound.end();
        this.settle();
        return;
      case "window":
        this.sendWindow.grant(frame.credit);
        return;
      case "reset":
        this.teardown(`the relay reset the stream: ${frame.reason}`);
        return;
      case "open":
      case "response":
      case "message":
      case "close":
        this.reset(`${frame.type} on a plain request`);
        return;
    }
  }

  abort(reason: string): void {
    this.teardown(reason);
  }

  private grant(bytes: number): void {
    if (this.done) return;
    const credit = this.receiveWindow.release(bytes);
    if (credit > 0) {
      this.carrier.send({ type: "window", streamId: this.streamId, credit });
    }
  }

  private async relayResponse(response: IncomingMessage): Promise<void> {
    this.carrier.send({
      type: "response",
      streamId: this.streamId,
      head: {
        status: response.statusCode ?? 502,
        statusText: response.statusMessage ?? "",
        headers: pairs(response.rawHeaders),
      },
    });
    try {
      for await (const chunk of response as AsyncIterable<Buffer>) {
        await this.sendData(chunk);
      }
    } catch (error) {
      this.reset(error instanceof Error ? error.message : "response failed");
      return;
    }
    if (this.done) return;
    // `end` without `complete` is a response cut off part way.
    if (!response.complete) {
      this.reset("the response ended before it was complete");
      return;
    }
    this.carrier.send({ type: "end", streamId: this.streamId });
    this.responseEnded = true;
    this.settle();
  }

  /** Send a body chunk as `DATA`, waiting for credit and for the tunnel. */
  private async sendData(chunk: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const size = await this.sendWindow.take(
        Math.min(MAX_DATA_BYTES, chunk.byteLength - offset),
      );
      if (this.carrier.congested()) await this.carrier.writable();
      if (this.done) throw new Error("stream closed");
      this.carrier.send({
        type: "data",
        streamId: this.streamId,
        bytes: chunk.subarray(offset, offset + size),
      });
      offset += size;
    }
  }

  private settle(): void {
    if (!this.requestEnded || !this.responseEnded || this.done) return;
    this.done = true;
    this.sendWindow.close(new Error("stream finished"));
    this.client.destroy();
    this.carrier.finished(this.streamId);
  }

  /** Fail the stream and tell the relay. */
  private reset(reason: string): void {
    if (this.done) return;
    this.carrier.send({ type: "reset", streamId: this.streamId, reason });
    this.teardown(reason);
  }

  /** Fail the stream without a word to the relay. */
  private teardown(reason: string): void {
    if (this.done) return;
    this.done = true;
    const error = new Error(reason);
    this.sendWindow.close(error);
    this.outbound.destroy();
    this.client.destroy(error);
    this.carrier.finished(this.streamId);
  }
}

/**
 * An upgrade. A `101` turns the stream into a relay of WebSocket messages;
 * anything else is answered as a plain response.
 */
class UpgradeStream implements TunnelStream {
  private readonly upstream?: WebSocket;
  private readonly sendWindow = new SendWindow();
  /** The server's `101`, held until `ws` has checked it and opened. */
  private handshake?: IncomingMessage;
  private open = false;
  private done = false;

  constructor(
    private readonly streamId: number,
    head: RequestHead,
    private readonly carrier: StreamCarrier,
    accept: (socket: Duplex) => void,
  ) {
    const host = headerValue(head.headers, "host");
    if (host === undefined) {
      this.reset("the request head names no host");
      return;
    }
    const [client, server] = socketPair();
    let upstream: WebSocket;
    try {
      // The URL's authority is never dialled: `createConnection` hands `ws`
      // the pair. `Host` travels as a header, so the server sees the
      // authority the relay presented.
      upstream = new WebSocket(
        `ws://tunnel.invalid${head.target}`,
        protocolsOf(head.headers),
        {
          createConnection: () => client,
          headers: upgradeHeaders(head.headers),
          perMessageDeflate: false,
          followRedirects: false,
          maxPayload: MAX_MESSAGE_BYTES,
        },
      );
    } catch (error) {
      client.destroy();
      server.destroy();
      this.reset(error instanceof Error ? error.message : "bad upgrade");
      return;
    }
    this.upstream = upstream;
    accept(server);

    upstream.once("upgrade", (response) => {
      this.handshake = response;
    });
    upstream.once("open", () => {
      if (this.done) return;
      this.open = true;
      const response = this.handshake;
      this.carrier.send({
        type: "response",
        streamId: this.streamId,
        head: {
          status: 101,
          statusText: response?.statusMessage ?? "Switching Protocols",
          headers: response ? pairs(response.rawHeaders) : [],
        },
      });
    });
    upstream.on("unexpected-response", (_request, response) => {
      void this.relayRefusal(response);
    });
    upstream.on("message", (data, isBinary) =>
      this.relayMessage(data, isBinary),
    );
    upstream.once("close", (code, reason) => {
      if (this.done) return;
      if (!this.open) {
        this.reset("the upgrade failed before it opened");
        return;
      }
      this.done = true;
      this.carrier.send({
        type: "close",
        streamId: this.streamId,
        code: sendableCloseCode(code),
        reason: closeReason(reason.toString("utf8")),
      });
      this.carrier.finished(this.streamId);
    });
    upstream.on("error", (error) => {
      if (!this.open) this.reset(error.message);
    });
  }

  receive(frame: Frame): void {
    if (this.done) return;
    switch (frame.type) {
      case "message":
        if (!this.open) {
          this.reset("a message before the 101");
          return;
        }
        this.upstream?.send(frame.data, {
          binary: typeof frame.data !== "string",
        });
        return;
      case "close":
        // Over at both ends now. The upstream's own close handshake runs
        // on, bounded by `ws`'s close timeout.
        this.done = true;
        this.carrier.finished(this.streamId);
        try {
          this.upstream?.close(
            sendableCloseCode(frame.code),
            closeReason(frame.reason),
          );
        } catch {
          this.upstream?.terminate();
        }
        return;
      case "window":
        this.sendWindow.grant(frame.credit);
        return;
      case "end":
        // The relay treats an upgrade's request side as ended and sends no
        // `END`. One that does is harmless.
        return;
      case "reset":
        this.teardown();
        return;
      case "open":
      case "response":
      case "data":
        this.reset(`${frame.type} on an upgrade`);
        return;
    }
  }

  abort(): void {
    this.teardown();
  }

  /**
   * Relay one message from the server, and stop reading it while the
   * tunnel is backed up. The relay cannot push back on a caller, so this
   * is the only bound on how far a fast server gets ahead.
   */
  private relayMessage(data: RawData, isBinary: boolean): void {
    if (this.done) return;
    const bytes = Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.isBuffer(data)
        ? data
        : Buffer.from(data);
    this.carrier.send({
      type: "message",
      streamId: this.streamId,
      data: isBinary ? bytes : bytes.toString("utf8"),
    });
    if (this.carrier.congested()) {
      this.upstream?.pause();
      void this.carrier.writable().then(
        () => this.upstream?.resume(),
        () => {},
      );
    }
  }

  /** A server that refused the upgrade has something to say. Say it. */
  private async relayRefusal(response: IncomingMessage): Promise<void> {
    this.carrier.send({
      type: "response",
      streamId: this.streamId,
      head: {
        status: response.statusCode ?? 502,
        statusText: response.statusMessage ?? "",
        headers: pairs(response.rawHeaders),
      },
    });
    try {
      for await (const chunk of response as AsyncIterable<Buffer>) {
        let offset = 0;
        while (offset < chunk.byteLength) {
          const size = await this.sendWindow.take(
            Math.min(MAX_DATA_BYTES, chunk.byteLength - offset),
          );
          if (this.done) return;
          this.carrier.send({
            type: "data",
            streamId: this.streamId,
            bytes: chunk.subarray(offset, offset + size),
          });
          offset += size;
        }
      }
    } catch (error) {
      this.reset(error instanceof Error ? error.message : "response failed");
      return;
    }
    if (this.done) return;
    this.done = true;
    this.carrier.send({ type: "end", streamId: this.streamId });
    this.carrier.finished(this.streamId);
    // `ws` hands the response over and leaves the connection to us.
    response.destroy();
    this.upstream?.terminate();
  }

  private reset(reason: string): void {
    if (this.done) return;
    this.carrier.send({ type: "reset", streamId: this.streamId, reason });
    this.teardown();
  }

  private teardown(): void {
    if (this.done) return;
    this.done = true;
    this.sendWindow.close(new Error("stream closed"));
    this.upstream?.terminate();
    this.carrier.finished(this.streamId);
  }
}

/**
 * The relay's headers for a plain request, and whether a body may follow.
 *
 * The relay frames a body of unknown length as `Transfer-Encoding:
 * chunked`, and Node chunk-encodes what it writes when that header is
 * set. A request with neither that nor a `Content-Length` is still sent
 * chunked unless its method carries no body. A body behind a header block
 * that declared none would be read by the server as the start of a second
 * request, so such a request gets no body at all.
 *
 * The other hop-by-hop headers are dropped: the request written here is a
 * new hop. The relay has already dropped them; this is the second lock.
 */
function requestHeaders(head: RequestHead): {
  headers: HeaderPair[];
  bodyAllowed: boolean;
} {
  const chunked = head.headers.some(
    ([name, value]) =>
      name.toLowerCase() === "transfer-encoding" &&
      value
        .split(",")
        .some((token) => token.trim().toLowerCase() === "chunked"),
  );
  const headers = head.headers.filter(([name]) => {
    const lowered = name.toLowerCase();
    // Never both: a message that carries a length and chunking is a
    // request smuggling shape.
    if (chunked && lowered === "content-length") return false;
    return !HOP_BY_HOP.has(lowered);
  });
  const hasLength = headers.some(
    ([name]) => name.toLowerCase() === "content-length",
  );
  if (chunked || (!hasLength && !BODILESS.has(head.method.toUpperCase()))) {
    headers.push(["transfer-encoding", "chunked"]);
    return { headers, bodyAllowed: true };
  }
  return { headers, bodyAllowed: hasLength };
}

/** The relay's headers for an upgrade, less what `ws` writes itself. */
function upgradeHeaders(
  headers: HeaderPair[],
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of headers) {
    const lowered = name.toLowerCase();
    if (HOP_BY_HOP.has(lowered) || HANDSHAKE.has(lowered)) continue;
    if (lowered === "content-length") continue;
    const existing = out[lowered];
    if (existing === undefined) out[lowered] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[lowered] = [existing, value];
  }
  return out;
}

/** The subprotocols the caller offered, in order. */
function protocolsOf(headers: HeaderPair[]): string[] {
  return headers
    .filter(([name]) => name.toLowerCase() === "sec-websocket-protocol")
    .flatMap(([, value]) => value.split(","))
    .map((protocol) => protocol.trim())
    .filter((protocol) => protocol !== "");
}

function headerValue(headers: HeaderPair[], name: string): string | undefined {
  return headers.find(([key]) => key.toLowerCase() === name)?.[1];
}

/** Node's flat `rawHeaders` as name and value pairs. */
function pairs(rawHeaders: string[]): HeaderPair[] {
  const out: HeaderPair[] = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    out.push([rawHeaders[index]!, rawHeaders[index + 1]!]);
  }
  return out;
}
