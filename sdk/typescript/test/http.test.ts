import { describe, it, expect } from "vitest";

import { AmikaHTTPError } from "@/errors";
import { HTTPClient } from "@/http";
import { StaticTokenSource } from "@/token";
import { mockFetch } from "./helpers.js";

function makeClient(fetchImpl: typeof fetch, timeoutMs?: number): HTTPClient {
  return new HTTPClient({
    baseUrl: "https://api.example.com/",
    tokenSource: new StaticTokenSource("tok-123"),
    fetch: fetchImpl,
    timeoutMs,
  });
}

describe("HTTPClient", () => {
  it("trims trailing slashes on the base URL", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: {} }]);
    const client = makeClient(fetch);
    await client.doJSON("GET", "/foo");
    expect(calls[0]?.url).toBe("https://api.example.com/foo");
  });

  it("attaches Authorization: Bearer <token>", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: {} }]);
    const client = makeClient(fetch);
    await client.doJSON("GET", "/foo");
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer tok-123");
  });

  it("serializes the body as JSON and sets Content-Type", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: {} }]);
    const client = makeClient(fetch);
    await client.doJSON("POST", "/foo", { a: 1, b: "x" });
    const call = calls[0];
    expect(call?.method).toBe("POST");
    expect(call?.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(call?.body ?? "")).toEqual({ a: 1, b: "x" });
  });

  it("omits Content-Type when there is no body", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: {} }]);
    const client = makeClient(fetch);
    await client.doJSON("DELETE", "/foo");
    expect(calls[0]?.headers["Content-Type"]).toBeUndefined();
    expect(calls[0]?.body).toBeUndefined();
  });

  it("throws AmikaHTTPError on non-2xx with the raw body", async () => {
    const { fetch } = mockFetch([
      { status: 404, body: { message: "not found" } },
    ]);
    const client = makeClient(fetch);
    const err = await client.doJSON("GET", "/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmikaHTTPError);
    expect(err).toMatchObject({
      statusCode: 404,
      body: JSON.stringify({ message: "not found" }),
    });
  });

  it("parses and returns 2xx JSON responses", async () => {
    const { fetch } = mockFetch([{ status: 200, body: { hello: "world" } }]);
    const client = makeClient(fetch);
    const data = await client.doJSON<{ hello: string }>("GET", "/x");
    expect(data).toEqual({ hello: "world" });
  });

  it("returns null for empty 2xx responses", async () => {
    const { fetch } = mockFetch([{ status: 204, body: "" }]);
    const client = makeClient(fetch);
    const data = await client.doJSON("DELETE", "/x");
    expect(data).toBeNull();
  });
});
