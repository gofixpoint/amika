/**
 * Forward one HTTP request to a guest port published on the host's loopback.
 *
 * This uses `node:http` rather than `fetch` because `fetch` always sends its
 * own `Host` (`127.0.0.1:<port>`) and decodes compressed bodies. Here the
 * guest sees the caller's `Host`, as it does on the upgrade path, and bytes
 * pass through unchanged in both directions.
 */
import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

export interface GuestRequest {
  method: string;
  /** Guest path and query, starting with `/`. */
  path: string;
  /** Sent as given, `Host` included; the caller strips hop-by-hop headers. */
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  signal?: AbortSignal;
}

export type GuestForwarder = (
  hostPort: number,
  request: GuestRequest,
) => Promise<Response>;

/**
 * Resolve with the guest's response once its head arrives, streaming the
 * body after; reject if the guest cannot be reached or fails before
 * answering.
 */
export const forwardToGuest: GuestForwarder = (
  hostPort,
  { method, path, headers, body, signal },
) =>
  new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port: hostPort,
        method,
        path,
        headers: Object.fromEntries(headers),
        signal,
      },
      (incoming) => {
        const responseHeaders = new Headers();
        for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
          responseHeaders.append(
            incoming.rawHeaders[i],
            incoming.rawHeaders[i + 1],
          );
        }
        const status = incoming.statusCode ?? 502;
        const bodyless = method === "HEAD" || NULL_BODY_STATUSES.has(status);
        if (bodyless) incoming.resume();
        resolve(
          new Response(
            bodyless
              ? null
              : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>),
            {
              status,
              statusText: incoming.statusMessage,
              headers: responseHeaders,
            },
          ),
        );
      },
    );
    outgoing.on("error", reject);
    if (body) {
      Readable.fromWeb(body as NodeReadableStream<Uint8Array>)
        .on("error", (error) => outgoing.destroy(error))
        .pipe(outgoing);
    } else {
      outgoing.end();
    }
  });

/** Statuses a `Response` may not carry a body for. */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);
