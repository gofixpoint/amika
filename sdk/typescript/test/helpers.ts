import { vi } from "vitest";

export interface MockResponseSpec {
  status?: number;
  body?: unknown;
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export interface MockFetchHandle {
  fetch: typeof fetch;
  calls: RecordedCall[];
}

/**
 * Build a `fetch` mock that returns the given responses in order. Each call
 * is recorded so tests can assert URL, method, headers, and body.
 */
export function mockFetch(responses: MockResponseSpec[]): MockFetchHandle {
  const queue = [...responses];
  const calls: RecordedCall[] = [];

  const fetchImpl = vi.fn(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const spec = queue.shift();
      if (!spec) throw new Error("mockFetch: no more queued responses");

      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = init?.method ?? "GET";
      const headers: Record<string, string> = {};
      const initHeaders = init?.headers;
      if (initHeaders) {
        if (initHeaders instanceof Headers) {
          initHeaders.forEach((v, k) => {
            headers[k] = v;
          });
        } else if (Array.isArray(initHeaders)) {
          for (const [k, v] of initHeaders) headers[k] = v;
        } else {
          Object.assign(headers, initHeaders);
        }
      }
      const body = typeof init?.body === "string" ? init.body : undefined;
      calls.push({ url, method, headers, body });

      const status = spec.status ?? 200;
      const rawBody =
        spec.body === undefined
          ? ""
          : typeof spec.body === "string"
            ? spec.body
            : JSON.stringify(spec.body);
      // Per the Fetch spec, Response constructors with status 204/205/304 must
      // have a null body. Map an empty string body to null for those statuses.
      const nullBodyStatus = status === 204 || status === 205 || status === 304;
      const responseBody = nullBodyStatus && rawBody === "" ? null : rawBody;
      return new Response(responseBody, { status });
    },
  ) as unknown as typeof fetch;

  return { fetch: fetchImpl, calls };
}
