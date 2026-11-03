/**
 * `amika.tunnel.v2`: what amika-hostd and Amika's per-host relay say to each
 * other over the host's WebSocket.
 *
 * Both ends import this module, so a constant that has to agree at both ends
 * is defined here and nowhere else.
 *
 * Runs in Node and in a Cloudflare Worker, so it uses `Uint8Array`,
 * `DataView` and `TextEncoder`, never `Buffer`.
 */
import { z } from "zod";

/** The WebSocket subprotocol. The version is in the name. */
export const TUNNEL_SUBPROTOCOL = "amika.tunnel.v2";

/** Where a host dials. */
export const HOST_TUNNEL_PATH = "/v2/host-tunnel";

/**
 * Where amika-hostd 0.5.x and earlier dial, speaking yamux. The gateway
 * answers it `426`, which those releases report as "upgrade amika-hostd"
 * rather than retrying for ever.
 */
export const LEGACY_HOST_TUNNEL_PATH = "/v1/host-tunnel";

/** Handshake headers, in the spelling both ends read and write. */
export const HOST_ID_HEADER = "x-amika-host-id";
export const CREDENTIAL_HEADER = "x-amika-host-token";
export const CONNECTION_ID_HEADER = "x-amika-connection-id";

/**
 * Where amika-hostd 0.6.0 and earlier send the credential. The gateway
 * still reads it, so those hosts keep attaching until they update.
 */
export const LEGACY_CREDENTIAL_HEADER = "x-amika-host-credential";

/**
 * The keep-alive. The host sends `PING` as a text message and the relay's
 * runtime answers `PONG` without waking the relay. These are the only text
 * messages on a tunnel.
 *
 * Namespaced, because Cloudflare's auto-response applies to every WebSocket
 * the relay accepts, the callers of relayed upgrades included. A plain
 * `ping` there would be answered by the runtime and never reach the
 * service, which breaks any application heartbeat that uses that word. A
 * caller that sends exactly `PING` is still answered `PONG` by the
 * runtime; no application has a reason to.
 */
export const PING = "amika.tunnel.v2.ping";
export const PONG = "amika.tunnel.v2.pong";

/** How often hostd pings. */
export const KEEP_ALIVE_INTERVAL_MS = 30_000;
/** How long hostd waits for a `PONG` before it treats the tunnel as dead. */
export const PING_TIMEOUT_MS = 10_000;
/**
 * How long the relay lets a host go without pinging before it presumes the
 * host gone. Three intervals, so one lost ping is not a disconnect.
 */
export const HOST_SILENCE_MS = 3 * KEEP_ALIVE_INTERVAL_MS;

/** Credit each side starts with to send `DATA` on one stream. */
export const INITIAL_WINDOW = 256 * 1024;
/** The largest payload of one `DATA` frame. */
export const MAX_DATA_BYTES = 64 * 1024;
/** The largest relayed WebSocket message. */
export const MAX_MESSAGE_BYTES = 1024 * 1024;
/**
 * The largest frame, and so the WebSocket `maxPayload` at both ends. A
 * message plus the frame header, with room to spare.
 */
export const MAX_FRAME_BYTES = MAX_MESSAGE_BYTES + 64;
/** The longest close reason a WebSocket close frame can carry. */
export const MAX_CLOSE_REASON_BYTES = 123;
/**
 * The longest request target, in characters. The relay's URL parser
 * percent-encodes, so a public URL under the edge's own limit can still
 * come out longer than this.
 */
export const MAX_TARGET_LENGTH = 16 * 1024;
/** How many streams may be open to one host at once. */
export const MAX_CONCURRENT_STREAMS = 256;

/**
 * Close codes the relay sends on the host socket. hostd redials after each;
 * they exist so that a log says why.
 */
export const CLOSE_REPLACED = 4001;
export const CLOSE_REVOKED = 4003;
export const CLOSE_LEASE_EXPIRED = 4008;
export const CLOSE_SILENT = 4009;

const FRAME_TYPE = {
  open: 1,
  response: 2,
  data: 3,
  end: 4,
  reset: 5,
  window: 6,
  text: 7,
  binary: 8,
  close: 9,
} as const;

const HEADER_BYTES = 5;

/** One header line. A list of these keeps repeats and order. */
export type HeaderPair = [name: string, value: string];

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// RFC 9110 field-value characters: tab, visible ASCII, space, and obs-text,
// one character per byte. This is exactly what Node's HTTP client will
// write; anything else (a control character, a code point above Latin-1)
// makes it throw `ERR_INVALID_CHAR` while building the request.
const FIELD_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

const headerPairs = z.array(
  z.tuple([z.string().regex(TOKEN), z.string().regex(FIELD_VALUE)]),
);

const requestHeadSchema = z.object({
  method: z.string().regex(TOKEN),
  /** Origin-form. The relay has already refused anything else. */
  target: z.string().startsWith("/").max(MAX_TARGET_LENGTH),
  headers: headerPairs,
  /** A WebSocket upgrade. The host answers `101` and the stream relays messages. */
  upgrade: z.boolean(),
});

const responseHeadSchema = z.object({
  status: z.number().int().min(100).max(599),
  statusText: z.string().regex(FIELD_VALUE).max(1024),
  headers: headerPairs,
});

export type RequestHead = z.infer<typeof requestHeadSchema>;
export type ResponseHead = z.infer<typeof responseHeadSchema>;

export type Frame =
  | { type: "open"; streamId: number; head: RequestHead }
  | { type: "response"; streamId: number; head: ResponseHead }
  | { type: "data"; streamId: number; bytes: Uint8Array }
  | { type: "end"; streamId: number }
  | { type: "reset"; streamId: number; reason: string }
  | { type: "window"; streamId: number; credit: number }
  /** One WebSocket message: a string for text, bytes for binary. */
  | { type: "message"; streamId: number; data: string | Uint8Array }
  | { type: "close"; streamId: number; code: number; reason: string };

/** A frame that cannot be read. The peer is not speaking this protocol. */
export class ProtocolError extends Error {
  override name = "ProtocolError";
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * A frame whose header reads fine but whose head JSON breaks the schema: a
 * target too long, a header value Node would refuse. The stream it names is
 * known, so a receiver can refuse that stream alone rather than the whole
 * connection. A head that is not JSON at all stays a plain `ProtocolError`.
 */
export class MalformedHeadError extends ProtocolError {
  override name = "MalformedHeadError";

  constructor(
    readonly frameType: "open" | "response",
    readonly streamId: number,
    message: string,
  ) {
    super(message);
  }
}

/** One frame as the bytes of one binary WebSocket message. */
export function encodeFrame(frame: Frame): Uint8Array {
  switch (frame.type) {
    case "open":
      return withHeader(FRAME_TYPE.open, frame.streamId, json(frame.head));
    case "response":
      return withHeader(FRAME_TYPE.response, frame.streamId, json(frame.head));
    case "data":
      if (frame.bytes.byteLength > MAX_DATA_BYTES) {
        throw new RangeError(`DATA payload over ${MAX_DATA_BYTES} bytes`);
      }
      return withHeader(FRAME_TYPE.data, frame.streamId, frame.bytes);
    case "end":
      return withHeader(FRAME_TYPE.end, frame.streamId, new Uint8Array(0));
    case "reset":
      return withHeader(
        FRAME_TYPE.reset,
        frame.streamId,
        encoder.encode(frame.reason.slice(0, 1024)),
      );
    case "window": {
      const payload = new Uint8Array(4);
      new DataView(payload.buffer).setUint32(0, frame.credit);
      return withHeader(FRAME_TYPE.window, frame.streamId, payload);
    }
    case "message": {
      const payload =
        typeof frame.data === "string"
          ? encoder.encode(frame.data)
          : frame.data;
      // A larger frame would exceed the far end's `maxPayload`, and the
      // WebSocket library closes the whole tunnel on that. A sender checks
      // the size first and closes only its stream (1009).
      if (payload.byteLength > MAX_MESSAGE_BYTES) {
        throw new RangeError(`message over ${MAX_MESSAGE_BYTES} bytes`);
      }
      return withHeader(
        typeof frame.data === "string" ? FRAME_TYPE.text : FRAME_TYPE.binary,
        frame.streamId,
        payload,
      );
    }
    case "close": {
      const reason = encoder.encode(closeReason(frame.reason));
      const payload = new Uint8Array(2 + reason.byteLength);
      new DataView(payload.buffer).setUint16(0, frame.code);
      payload.set(reason, 2);
      return withHeader(FRAME_TYPE.close, frame.streamId, payload);
    }
    default:
      return assertNever(frame);
  }
}

/** Read one binary WebSocket message as a frame, or throw `ProtocolError`. */
export function decodeFrame(bytes: Uint8Array): Frame {
  if (bytes.byteLength < HEADER_BYTES) {
    throw new ProtocolError("frame shorter than its header");
  }
  if (bytes.byteLength > MAX_FRAME_BYTES) {
    throw new ProtocolError(`frame over ${MAX_FRAME_BYTES} bytes`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = view.getUint8(0);
  const streamId = view.getUint32(1);
  if (streamId === 0) throw new ProtocolError("stream id 0");
  const payload = bytes.subarray(HEADER_BYTES);

  switch (type) {
    case FRAME_TYPE.open:
      return {
        type: "open",
        streamId,
        head: parse(requestHeadSchema, payload, "open", streamId),
      };
    case FRAME_TYPE.response:
      return {
        type: "response",
        streamId,
        head: parse(responseHeadSchema, payload, "response", streamId),
      };
    case FRAME_TYPE.data:
      if (payload.byteLength > MAX_DATA_BYTES) {
        throw new ProtocolError(`DATA payload over ${MAX_DATA_BYTES} bytes`);
      }
      return { type: "data", streamId, bytes: payload };
    case FRAME_TYPE.end:
      return { type: "end", streamId };
    case FRAME_TYPE.reset:
      return { type: "reset", streamId, reason: text(payload) };
    case FRAME_TYPE.window: {
      if (payload.byteLength !== 4) {
        throw new ProtocolError("WINDOW payload is not 4 bytes");
      }
      const credit = view.getUint32(HEADER_BYTES);
      if (credit === 0) throw new ProtocolError("WINDOW of zero");
      return { type: "window", streamId, credit };
    }
    case FRAME_TYPE.text:
    case FRAME_TYPE.binary:
      if (payload.byteLength > MAX_MESSAGE_BYTES) {
        throw new ProtocolError(`message over ${MAX_MESSAGE_BYTES} bytes`);
      }
      return {
        type: "message",
        streamId,
        data: type === FRAME_TYPE.text ? text(payload) : payload,
      };
    case FRAME_TYPE.close: {
      if (payload.byteLength < 2) {
        throw new ProtocolError("CLOSE payload shorter than its code");
      }
      // A reason has to fit the close frame it will be sent in. `encodeFrame`
      // never writes a longer one, so a peer that does is not this protocol.
      if (payload.byteLength - 2 > MAX_CLOSE_REASON_BYTES) {
        throw new ProtocolError("CLOSE reason over 123 bytes");
      }
      return {
        type: "close",
        streamId,
        code: view.getUint16(HEADER_BYTES),
        reason: text(payload.subarray(2)),
      };
    }
    default:
      throw new ProtocolError(`unknown frame type ${type}`);
  }
}

/**
 * A close code one end may send on its own WebSocket, for one the other end
 * reported.
 *
 * 1005, 1006 and 1015 are reported but never sent: they mean "no code", "no
 * close frame" and "TLS failed". The first is a clean close, the other two
 * are failures. Any other code outside the sendable ranges is a failure.
 */
export function sendableCloseCode(code: number): number {
  if (code === 1005) return 1000;
  // 1004 is reserved and never sent either; `ws` throws on it.
  if (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1006) {
    return code;
  }
  if (code >= 3000 && code <= 4999) return code;
  return 1011;
}

/**
 * Whether a request head can cross the tunnel. A head built from a public
 * request can hold what this protocol does not, such as a percent-encoded
 * target past `MAX_TARGET_LENGTH`. The relay checks first and answers that
 * caller itself, rather than send an `OPEN` the host must refuse.
 */
export function isSendableRequestHead(head: RequestHead): boolean {
  return requestHeadSchema.safeParse(head).success;
}

/**
 * Whether a response head can cross the tunnel. A head read from a service
 * can hold what Node's HTTP parser accepts and this protocol does not, such
 * as a status of 600 or a long reason phrase. `decodeFrame` refuses such a
 * frame as malformed and fails the whole tunnel, so a sender checks first
 * and fails only the one stream.
 */
export function isSendableResponseHead(head: ResponseHead): boolean {
  return responseHeadSchema.safeParse(head).success;
}

/** A close reason that fits a close frame: at most 123 bytes of UTF-8. */
export function closeReason(reason: string): string {
  // One encode and one cut, so a long reason costs linear time. The cut
  // backs up past UTF-8 continuation bytes so it never splits a character.
  const bytes = encoder.encode(reason);
  if (bytes.byteLength <= MAX_CLOSE_REASON_BYTES) return reason;
  let end = MAX_CLOSE_REASON_BYTES;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return decoder.decode(bytes.subarray(0, end));
}

function withHeader(
  type: number,
  streamId: number,
  payload: Uint8Array,
): Uint8Array {
  if (!Number.isInteger(streamId) || streamId < 1 || streamId > 0xffffffff) {
    throw new RangeError(`stream id out of range: ${streamId}`);
  }
  const frame = new Uint8Array(HEADER_BYTES + payload.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint8(0, type);
  view.setUint32(1, streamId);
  frame.set(payload, HEADER_BYTES);
  return frame;
}

function json(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function parse<T>(
  schema: z.ZodType<T>,
  payload: Uint8Array,
  frameType: "open" | "response",
  streamId: number,
): T {
  let value: unknown;
  try {
    value = JSON.parse(text(payload));
  } catch {
    throw new ProtocolError("head is not JSON");
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new MalformedHeadError(
      frameType,
      streamId,
      `head is malformed: ${result.error.message}`,
    );
  }
  return result.data;
}

function text(payload: Uint8Array): string {
  try {
    return decoder.decode(payload);
  } catch {
    throw new ProtocolError("text is not UTF-8");
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled frame: ${JSON.stringify(value)}`);
}
