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
export const CREDENTIAL_HEADER = "x-amika-host-credential";
export const CONNECTION_ID_HEADER = "x-amika-connection-id";

/**
 * The keep-alive. The host sends `PING` as a text message and the relay's
 * runtime answers `PONG` without waking the relay. These are the only text
 * messages on a tunnel.
 */
export const PING = "ping";
export const PONG = "pong";

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
  target: z
    .string()
    .startsWith("/")
    .max(16 * 1024),
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
    case "message":
      return typeof frame.data === "string"
        ? withHeader(
            FRAME_TYPE.text,
            frame.streamId,
            encoder.encode(frame.data),
          )
        : withHeader(FRAME_TYPE.binary, frame.streamId, frame.data);
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
        head: parse(requestHeadSchema, payload),
      };
    case FRAME_TYPE.response:
      return {
        type: "response",
        streamId,
        head: parse(responseHeadSchema, payload),
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
      return { type: "message", streamId, data: text(payload) };
    case FRAME_TYPE.binary:
      return { type: "message", streamId, data: payload };
    case FRAME_TYPE.close: {
      if (payload.byteLength < 2) {
        throw new ProtocolError("CLOSE payload shorter than its code");
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

/** A close reason that fits a close frame: at most 123 bytes of UTF-8. */
export function closeReason(reason: string): string {
  let cut = reason;
  while (encoder.encode(cut).byteLength > 123) cut = cut.slice(0, -1);
  return cut;
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

function parse<T>(schema: z.ZodType<T>, payload: Uint8Array): T {
  let value: unknown;
  try {
    value = JSON.parse(text(payload));
  } catch {
    throw new ProtocolError("head is not JSON");
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ProtocolError(`head is malformed: ${result.error.message}`);
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
