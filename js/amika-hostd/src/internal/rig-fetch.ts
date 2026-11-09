/**
 * `fetch` for the services a rig publishes, over `node:http`.
 *
 * Do not call a rig service with Node's `fetch`. Node's `fetch` uses the
 * undici library. undici fails when its reader reads a response slowly:
 *
 * - hostd reads a response from a service only as fast as the caller reads
 *   it. If the caller or the tunnel stops, hostd stops reading.
 * - When the body buffer is full, undici pauses its HTTP parser. The parser
 *   can pause after it receives the last bytes of the body. At that time,
 *   the response is not yet marked complete.
 * - The service can close the connection during the pause. For example,
 *   Node's HTTP server closes a connection when its keep-alive timeout
 *   ends.
 * - If the connection is a keep-alive connection, undici then fails the
 *   body with `TypeError: terminated`. undici discards the bytes in the
 *   body buffer, although hostd received them. The caller gets a short
 *   response.
 * - If the service sent `Connection: close`, undici fails an internal
 *   check (`assert(!this.paused)`) in a socket event handler. No code can
 *   catch this error, so the process stops. An HTTP/1.0 server, such as
 *   `python3 -m http.server`, also closes the connection after each
 *   response.
 *
 * Node 22 and 24 have both failures. Node 26 does not stop the process,
 * but it can still discard the end of the response. undici fixed the
 * crash in https://github.com/nodejs/undici/pull/5474 (issue #5360). The
 * backport to undici 7, which Node 24 uses, is not merged
 * (https://github.com/nodejs/undici/pull/5553).
 *
 * `node:http` parses all bytes that it received before it reports the end
 * of the connection. A slow reader does not change this. Thus service
 * routes use this function.
 *
 * This function does only what `proxyService` needs from `fetch`:
 *
 * - It sends the request body as a stream.
 * - It does not follow redirects.
 * - It decodes the same content codings as `fetch`.
 * - It stops the request when the request's `signal` aborts.
 * - It fails the body of a response that ends before it is complete. So
 *   hostd never sends an incomplete response as a complete one.
 *
 * It has the two timeouts of Node's `fetch`. Each is 300 s by default:
 *
 * - `headersTimeoutMs`: the time for the service to send the response
 *   head. When this time ends, the request fails and hostd closes the
 *   socket to the service. `proxyService` then answers 502.
 * - `bodyTimeoutMs`: the time between two chunks of the body. When this
 *   time ends, the body fails and hostd closes the socket to the service.
 *   The timer runs only while hostd waits for data from the service. It
 *   stops while the body is paused because the caller reads slowly. Thus
 *   a slow caller does not cause a timeout.
 */
import {
  Agent,
  request as httpRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
} from "node:http";
import {
  Readable,
  Transform,
  pipeline,
  type TransformCallback,
} from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import zlib from "node:zlib";

export interface RigFetchOptions {
  /** Keeps connections to the services open between requests. */
  agent?: Agent;
  /** The longest wait for the response head. */
  headersTimeoutMs?: number;
  /** The longest wait for the next chunk of the body. */
  bodyTimeoutMs?: number;
}

/** The timeouts of Node's `fetch`. */
export const DEFAULT_RIG_FETCH_TIMEOUT_MS = 300_000;

/** A `fetch` for rig services. */
export function createRigFetch({
  agent = new Agent({ keepAlive: true }),
  headersTimeoutMs = DEFAULT_RIG_FETCH_TIMEOUT_MS,
  bodyTimeoutMs = DEFAULT_RIG_FETCH_TIMEOUT_MS,
}: RigFetchOptions = {}): typeof fetch {
  const options = { agent, headersTimeoutMs, bodyTimeoutMs };
  return (input, init) => rigFetch(options, input, init);
}

function rigFetch(
  { agent, headersTimeoutMs, bodyTimeoutMs }: Required<RigFetchOptions>,
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (input instanceof Request) {
      throw new TypeError("rig fetch takes a URL, not a Request");
    }
    const url = new URL(input);
    if (url.protocol !== "http:") {
      throw new TypeError(`rig fetch speaks http only, not ${url.protocol}`);
    }
    const signal = init.signal ?? undefined;
    signal?.throwIfAborted();
    const method = (init.method ?? "GET").toUpperCase();

    const outgoing = httpRequest(url, {
      method,
      headers: outgoingHeaders(new Headers(init.headers)),
      agent,
    });
    const onAbort = () => {
      // Destroying the request destroys its socket, which errors a
      // response already under way as well.
      outgoing.destroy(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const forget = () => signal?.removeEventListener("abort", onAbort);
    // Destroying the request also destroys its socket to the service.
    const headersTimer = setTimeout(() => {
      outgoing.destroy(
        new Error(
          `the service sent no response head in ${headersTimeoutMs} ms`,
        ),
      );
    }, headersTimeoutMs).unref();

    // `on`, not `once`: a socket that fails after the response has begun
    // reports it here too, and the response's own reader hears it there.
    outgoing.on("error", (error) => {
      clearTimeout(headersTimer);
      forget();
      reject(error);
    });
    outgoing.once("response", (response) => {
      clearTimeout(headersTimer);
      response.once("close", forget);
      try {
        resolve(toResponse(method, response, bodyTimeoutMs));
      } catch (error) {
        response.destroy();
        reject(error);
      }
    });
    sendBody(outgoing, init.body);
  });
}

/** `Headers` as `node:http` takes them: one value per name. */
function outgoingHeaders(headers: Headers): OutgoingHttpHeaders {
  const outgoing: OutgoingHttpHeaders = {};
  for (const [name, value] of headers) outgoing[name] = value;
  return outgoing;
}

/** Stream the request body, with backpressure, or end a request with none. */
function sendBody(
  outgoing: ReturnType<typeof httpRequest>,
  body: RequestInit["body"],
): void {
  if (body === null || body === undefined) {
    outgoing.end();
  } else if (body instanceof ReadableStream) {
    pipeline(
      Readable.fromWeb(body as NodeReadableStream<Uint8Array>),
      outgoing,
      () => {
        // An error here destroys `outgoing`, which reports it.
      },
    );
  } else if (typeof body === "string" || body instanceof Uint8Array) {
    outgoing.end(body);
  } else {
    outgoing.destroy(new TypeError("rig fetch streams only bytes or text"));
  }
}

/** Statuses whose response carries no body. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/** As `fetch` limits them, against a response that stacks codings. */
const MAX_CONTENT_CODINGS = 5;

function toResponse(
  method: string,
  incoming: IncomingMessage,
  bodyTimeoutMs: number,
): Response {
  const headers = new Headers();
  const raw = incoming.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2)
    headers.append(raw[i], raw[i + 1]);
  const status = incoming.statusCode ?? 0;
  const init = { status, statusText: incoming.statusMessage ?? "", headers };
  if (method === "HEAD" || NULL_BODY_STATUSES.has(status)) {
    incoming.resume();
    return new Response(null, init);
  }
  const decoders = contentDecoders(headers.get("content-encoding"));
  const timed = new TimedBody(incoming, bodyTimeoutMs);
  if (decoders.length > 0) {
    pipeline([timed, ...decoders], () => {
      // An error here destroys the last decoder, whose reader sees it.
    });
  }
  const body: Readable = decoders.at(-1) ?? timed;
  return new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, init);
}

/**
 * The decoders `fetch` would put on a body with these codings, last coding
 * first. A coding `fetch` does not know leaves the body as it came.
 */
function contentDecoders(contentEncoding: string | null): Transform[] {
  const codings = contentEncoding
    ? contentEncoding.toLowerCase().split(",")
    : [];
  if (codings.length > MAX_CONTENT_CODINGS) {
    throw new TypeError(
      `too many content codings in the response: ${codings.length}`,
    );
  }
  const decoders: Transform[] = [];
  for (const coding of codings.map((value) => value.trim()).reverse()) {
    const decoder = decoderFor(coding);
    if (!decoder) return [];
    decoders.push(decoder);
  }
  return decoders;
}

function decoderFor(coding: string): Transform | undefined {
  // Lenient, as `fetch` and browsers are with a body cut short by a flush.
  const sync = {
    flush: zlib.constants.Z_SYNC_FLUSH,
    finishFlush: zlib.constants.Z_SYNC_FLUSH,
  };
  switch (coding) {
    case "gzip":
    case "x-gzip":
      return zlib.createGunzip(sync);
    case "deflate":
      return new InflateEither(sync);
    case "br":
      return zlib.createBrotliDecompress({
        flush: zlib.constants.BROTLI_OPERATION_FLUSH,
        finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH,
      });
    case "zstd":
      // Node 22 has it from 22.15; an older one leaves the body as it came.
      return typeof zlib.createZstdDecompress === "function"
        ? zlib.createZstdDecompress({
            flush: zlib.constants.ZSTD_e_continue,
            finishFlush: zlib.constants.ZSTD_e_end,
          })
        : undefined;
    default:
      return undefined;
  }
}

/**
 * A response body that fails when the service sends no data for
 * `timeoutMs` while its reader waits for data.
 *
 * The timer runs from each read request until the next chunk arrives.
 * When the reader's buffer is full, this pauses the response and stops the
 * timer. The next read request starts the timer again.
 */
class TimedBody extends Readable {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly source: IncomingMessage,
    private readonly timeoutMs: number,
  ) {
    super();
    source.on("data", (chunk: Buffer) => {
      this.stopTimer();
      if (this.push(chunk)) this.startTimer();
      else source.pause();
    });
    source.once("end", () => {
      this.stopTimer();
      this.push(null);
    });
    source.once("error", (error) => this.destroy(error));
    source.once("close", () => {
      if (!source.readableEnded) {
        this.destroy(new Error("the response ended before it was complete"));
      }
    });
    source.pause();
  }

  override _read(): void {
    this.startTimer();
    this.source.resume();
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.stopTimer();
    // Destroying a response that is not complete destroys its socket.
    this.source.destroy(error ?? undefined);
    callback(error);
  }

  private startTimer(): void {
    this.stopTimer();
    this.timer = setTimeout(() => {
      this.destroy(
        new Error(`the service sent no body data in ${this.timeoutMs} ms`),
      );
      this.source.socket?.destroy();
    }, this.timeoutMs).unref();
  }

  private stopTimer(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/**
 * `deflate` as servers send it: zlib-wrapped, as the coding names, or raw,
 * as some send it anyway. The first byte tells them apart.
 */
class InflateEither extends Transform {
  private inflate?: zlib.Inflate | zlib.InflateRaw;

  constructor(private readonly options: zlib.ZlibOptions) {
    super();
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    if (!this.inflate) {
      if (chunk.length === 0) {
        callback();
        return;
      }
      const inflate =
        (chunk[0] & 0x0f) === 0x08
          ? zlib.createInflate(this.options)
          : zlib.createInflateRaw(this.options);
      inflate.on("data", (data: Buffer) => this.push(data));
      inflate.on("error", (error) => this.destroy(error));
      this.inflate = inflate;
    }
    this.inflate.write(chunk, callback);
  }

  override _flush(callback: TransformCallback): void {
    const inflate = this.inflate;
    if (!inflate) {
      callback();
      return;
    }
    inflate.once("end", () => callback());
    inflate.end();
  }
}
