import { AmikaError, AmikaHTTPError } from "@/errors";
import type { TokenSource } from "@/token";

export interface HTTPClientOptions {
  baseUrl: string;
  tokenSource: TokenSource;
  /** Per-request timeout in milliseconds. Defaults to 30_000 (matches Go). */
  timeoutMs?: number;
  /** Override `fetch` for testing or runtime polyfills. Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
}

export interface RequestOptions {
  /** Override the default timeout for a single request. */
  timeoutMs?: number;
}

/**
 * A streaming response body plus the cleanup its caller owes. `release` clears
 * the request's timeout, so it must be called once the body is fully consumed
 * (or abandoned) — until then the timeout still applies to the whole stream,
 * not just the response headers.
 */
export interface StreamHandle {
  body: ReadableStream<Uint8Array>;
  release: () => void;
}

/**
 * Low-level HTTP transport. Mirrors Go's `apiclient.Client.doJSON`:
 * attaches a bearer token from `TokenSource`, sends JSON when there is a
 * body, throws `AmikaHTTPError` on non-2xx, and parses JSON on 2xx.
 */
export class HTTPClient {
  readonly baseUrl: string;
  readonly tokenSource: TokenSource;
  readonly defaultTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HTTPClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.tokenSource = options.tokenSource;
    this.defaultTimeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") {
      throw new Error(
        "HTTPClient requires a fetch implementation (globalThis.fetch or options.fetch)",
      );
    }
  }

  async doJSON<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    requestOptions?: RequestOptions,
  ): Promise<T | null> {
    const { response, release } = await this.send(
      method,
      path,
      body,
      undefined,
      requestOptions,
    );

    let text: string;
    try {
      text = await response.text();
    } finally {
      release();
    }

    if (response.status < 200 || response.status >= 300) {
      throw new AmikaHTTPError(response.status, text);
    }

    if (text.length === 0) return null;
    return JSON.parse(text) as T;
  }

  /**
   * Open a Server-Sent Events response and hand back its body unread. A
   * rejection (auth, validation) arrives as a normal JSON error before the
   * stream opens and is surfaced as `AmikaHTTPError`, exactly as it would be
   * on the buffered path.
   */
  async openStream(
    method: string,
    path: string,
    body?: unknown,
    requestOptions?: RequestOptions,
  ): Promise<StreamHandle> {
    const { response, release } = await this.send(
      method,
      path,
      body,
      "text/event-stream",
      requestOptions,
    );

    if (response.status < 200 || response.status >= 300) {
      let text: string;
      try {
        text = await response.text();
      } finally {
        release();
      }
      throw new AmikaHTTPError(response.status, text);
    }

    if (!response.body) {
      release();
      throw new AmikaError("stream response has no body");
    }
    return { body: response.body, release };
  }

  /**
   * Issue one authenticated request and return the response with the timeout
   * still armed. The caller must invoke `release` once it is done with the
   * body; nothing else here clears the timer.
   */
  private async send(
    method: string,
    path: string,
    body: unknown,
    accept: string | undefined,
    requestOptions: RequestOptions | undefined,
  ): Promise<{ response: Response; release: () => void }> {
    const headers: Record<string, string> = {};
    const token = await this.tokenSource.token();
    headers["Authorization"] = `Bearer ${token}`;
    if (accept) headers["Accept"] = accept;

    let serialized: string | undefined;
    if (body !== undefined && body !== null) {
      serialized = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
    }

    const timeoutMs = requestOptions?.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const release = () => clearTimeout(timer);

    let response: Response;
    try {
      response = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers,
        body: serialized,
        signal: controller.signal,
      });
    } catch (err) {
      release();
      throw err;
    }
    return { response, release };
  }
}
