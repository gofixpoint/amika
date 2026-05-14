import { AmikaHTTPError } from "@/errors";
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
    const url = this.baseUrl + path;
    const headers: Record<string, string> = {};
    const token = await this.tokenSource.token();
    headers["Authorization"] = `Bearer ${token}`;

    let serialized: string | undefined;
    if (body !== undefined && body !== null) {
      serialized = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
    }

    const timeoutMs = requestOptions?.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: serialized,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();

    if (response.status < 200 || response.status >= 300) {
      throw new AmikaHTTPError(response.status, text);
    }

    if (text.length === 0) return null;
    return JSON.parse(text) as T;
  }
}
