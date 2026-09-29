/**
 * Forward one HTTP request to a guest port published on the host's loopback.
 *
 * This uses undici's `request` rather than `fetch` because `fetch` always
 * sends its own `Host` (`127.0.0.1:<port>`) and decodes compressed bodies.
 * Here the guest sees the caller's `Host`, as it does on the upgrade path, and
 * bytes pass through unchanged in both directions. undici, the client `fetch`
 * is built on, owns the HTTP/1.1 framing to the guest: it sets
 * `Content-Length` or chunking to match the body it sends, checks a body
 * against its declared length, and refuses a response whose framing
 * conflicts, so a guest cannot desynchronize a pooled connection.
 */
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { Agent, request } from "undici";

export interface GuestRequest {
  method: string;
  /** Guest path and query, starting with `/`. */
  path: string;
  /** Sent as given, `Host` included; the caller strips hop-by-hop headers. */
  headers: Headers;
  /** Null when the caller sent no body, so none is forwarded. */
  body: ReadableStream<Uint8Array> | null;
  signal?: AbortSignal;
}

export type GuestForwarder = (
  hostPort: number,
  request: GuestRequest,
) => Promise<Response>;

/**
 * Resolve with the guest's response once its head arrives, streaming the
 * body after; reject if the guest cannot be reached, fails before answering,
 * or answers with something a `Response` cannot carry.
 */
export const forwardToGuest: GuestForwarder = async (
  hostPort,
  { method, path, headers, body, signal },
) => {
  const outgoing = Object.fromEntries(headers);
  // Node's server has already answered `Expect: 100-continue` itself, and
  // undici refuses to send the header.
  delete outgoing.expect;
  const upstream = await request(`http://127.0.0.1:${hostPort}${path}`, {
    method,
    headers: outgoing,
    body: body && Readable.fromWeb(body as NodeReadableStream<Uint8Array>),
    signal,
    dispatcher: guests,
  });
  const status = upstream.statusCode;
  const bodyless = method === "HEAD" || NULL_BODY_STATUSES.has(status);
  try {
    // `Response` refuses statuses outside 200-599, which a guest can send.
    if (status < 200 || status > 599) {
      throw new Error(`guest answered with status ${status}`);
    }
    const responseHeaders = new Headers();
    for (const [name, value] of Object.entries(upstream.headers)) {
      for (const item of [value ?? []].flat()) {
        responseHeaders.append(name, item);
      }
    }
    // A `204` or `205` goes out with no body, so a length the guest sent with
    // one would leave the caller waiting for bytes that never come. HEAD and
    // `304` keep theirs: it describes the resource.
    if (status === 204) responseHeaders.delete("content-length");
    if (status === 205) responseHeaders.set("content-length", "0");
    const response = new Response(
      bodyless ? null : (Readable.toWeb(upstream.body) as ReadableStream),
      { status, statusText: upstream.statusText, headers: responseHeaders },
    );
    if (bodyless) discard(upstream.body);
    return response;
  } catch (error) {
    discard(upstream.body);
    throw error;
  }
};

/**
 * Drop a guest body hostd will not send on. Destroying undici's body emits an
 * `error` (an `AbortError`), and with no listener that is an uncaught
 * exception that would take the daemon down, so listen first.
 */
function discard(body: Readable): void {
  body.on("error", () => {});
  body.destroy();
}

/**
 * Keep-alive connections to guest ports, pooled per port. A guest gets five
 * minutes to start answering, as `fetch` allowed, but a body in progress is
 * never timed out, since event streams and long polls can idle indefinitely.
 */
const guests = new Agent({ headersTimeout: 300_000, bodyTimeout: 0 });

/** Statuses a `Response` may not carry a body for. */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);
