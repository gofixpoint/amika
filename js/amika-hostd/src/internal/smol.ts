/** Transport to the separately managed, local smolvm serve process. */
import { z } from "zod";

export interface SmolRuntimeConfig {
  apiUrl?: string;
  requestTimeoutMs?: number;
}

export class SmolRuntime {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    config: SmolRuntimeConfig,
    private readonly fetcher = fetch,
  ) {
    const url = new URL(config.apiUrl ?? "http://127.0.0.1:8080");
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error(
        "SMOL_API_URL must be an HTTP(S) URL without credentials, query, or fragment",
      );
    }
    this.baseUrl = url.toString().replace(/\/$/, "");
    this.timeoutMs = z
      .number()
      .int()
      .positive()
      .parse(config.requestTimeoutMs ?? 300_000);
  }

  async request(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<Response> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      const binary = body instanceof Uint8Array;
      const response = await this.fetcher(
        `${this.baseUrl}/api/v1/machines${path}`,
        {
          method,
          headers:
            body === undefined
              ? undefined
              : {
                  "Content-Type": binary
                    ? "application/octet-stream"
                    : "application/json",
                },
          body:
            body === undefined
              ? undefined
              : binary
                ? Buffer.from(body)
                : JSON.stringify(body),
          signal,
          redirect: "error",
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        return Response.json(
          { error: "Smol runtime request failed" },
          { status: response.status },
        );
      }
      // Forward only content type, not upstream cookies or other host headers.
      const headers = new Headers();
      const contentType = response.headers.get("content-type");
      if (contentType) headers.set("content-type", contentType);
      return new Response(response.body, { status: response.status, headers });
    } catch {
      return Response.json(
        {
          error: signal.aborted
            ? "Smol runtime request timed out"
            : "Smol runtime unavailable",
        },
        { status: signal.aborted ? 504 : 502 },
      );
    }
  }
}
