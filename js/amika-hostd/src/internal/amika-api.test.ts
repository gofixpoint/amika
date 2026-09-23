/** Cover the registration request and how its failures are reported. */
import { describe, expect, it, vi } from "vitest";
import { AmikaApiError, registerHost } from "./amika-api.js";

const API = { apiUrl: "https://app.amika.dev", apiKey: "api-key" };
const INPUT = { hostname: "builder", secretKey: "host-secret" };
const HOST = {
  id: "host_1",
  hostname: "builder",
  url: null,
  org_id: "org_1",
  created_at: "2026-09-23T00:00:00Z",
  updated_at: "2026-09-23T00:00:00Z",
};

function responding(response: Response) {
  return vi.fn<typeof fetch>().mockResolvedValue(response);
}

function apiErrorBody(status: number, code: string, message: string) {
  return Response.json(
    { type: "error", error_code: code, message },
    { status },
  );
}

describe("registerHost", () => {
  it("posts only the hostname and secret with the API key", async () => {
    const fetcher = responding(Response.json(HOST, { status: 201 }));
    await registerHost(API, INPUT, fetcher);
    expect(fetcher).toHaveBeenCalledWith(
      "https://app.amika.dev/api/v0beta1/hosts",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer api-key",
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ hostname: "builder", secret: "host-secret" }),
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it.each([
    [201, true],
    [200, false],
  ])("treats HTTP %i as created=%s", async (status, created) => {
    const fetcher = responding(Response.json(HOST, { status }));
    expect(await registerHost(API, INPUT, fetcher)).toEqual({
      host: { id: "host_1", hostname: "builder", url: null },
      created,
    });
  });

  it.each([
    [
      401,
      "Amika rejected the API key while trying to register the host (unauthorized: details)",
    ],
    [
      403,
      "the API key is not allowed to register the host (forbidden: details)",
    ],
    [409, "failed to register the host (host_hostname_conflict: details)"],
  ])("explains HTTP %i", async (status, message) => {
    const code = {
      401: "unauthorized",
      403: "forbidden",
      409: "host_hostname_conflict",
    }[status] as string;
    const fetcher = responding(apiErrorBody(status, code, "details"));
    await expect(registerHost(API, INPUT, fetcher)).rejects.toThrow(
      new AmikaApiError(message),
    );
  });

  it("falls back to the status when the error body is not an API error", async () => {
    const fetcher = responding(
      new Response("<html>bad gateway", { status: 502 }),
    );
    await expect(registerHost(API, INPUT, fetcher)).rejects.toThrow(
      "failed to register the host (HTTP 502)",
    );
  });

  it("names the network failure", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }),
      }),
    );
    const failure = registerHost(API, INPUT, fetcher);
    await expect(failure).rejects.toThrow(
      "cannot reach Amika at https://app.amika.dev: ECONNREFUSED",
    );
  });

  it("reports a timeout", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    await expect(registerHost(API, INPUT, fetcher)).rejects.toThrow(
      "cannot reach Amika at https://app.amika.dev: no response within 30s",
    );
  });

  it("rejects a success response that is not a host", async () => {
    const fetcher = responding(Response.json({ ok: true }, { status: 201 }));
    await expect(registerHost(API, INPUT, fetcher)).rejects.toThrow(
      "Amika returned an unexpected host response",
    );
  });

  it("never includes the API key or secret in an error", async () => {
    for (const response of [
      apiErrorBody(500, "internal_error", "Failed to save host"),
      new Response("host-secret api-key", { status: 500 }),
    ]) {
      const error = await registerHost(API, INPUT, responding(response)).catch(
        (caught: unknown) => caught as Error,
      );
      expect(String(error)).not.toMatch(/host-secret|api-key/);
    }
  });
});
