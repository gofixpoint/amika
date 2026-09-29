/** Cover guest forwarding against a real HTTP server on loopback. */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { forwardToGuest } from "./forward.js";
import { freeLoopbackPort } from "./services.js";

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

interface Seen {
  method?: string;
  url?: string;
  host?: string;
  headers?: IncomingMessage["headers"];
  body: string;
}

/** A guest that records each request and answers with `respond`. */
async function guest(respond: (res: ServerResponse) => void) {
  const seen: Seen = { body: "" };
  const server = createServer((req, res) => {
    seen.method = req.method;
    seen.url = req.url;
    seen.host = req.headers.host;
    seen.headers = req.headers;
    req.on("data", (chunk) => (seen.body += chunk));
    req.on("end", () => respond(res));
  });
  closers.push(() => {
    server.closeAllConnections();
    server.close();
  });
  const port = await new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as AddressInfo).port),
    ),
  );
  return { port, seen };
}

describe("forwardToGuest", () => {
  it("sends the caller's Host, method, path and streamed body", async () => {
    const { port, seen } = await guest((res) => res.end("ok"));
    const response = await forwardToGuest(port, {
      method: "POST",
      path: "/v1/items?limit=2",
      headers: new Headers({
        host: "hostd.example",
        authorization: "Bearer guest-token",
        "content-type": "text/plain",
      }),
      body: new Response("payload").body,
    });
    expect(await response.text()).toBe("ok");
    expect(seen).toMatchObject({
      method: "POST",
      url: "/v1/items?limit=2",
      host: "hostd.example",
      body: "payload",
    });
    expect(seen.headers?.authorization).toBe("Bearer guest-token");
  });

  it("passes a compressed body through undecoded", async () => {
    const gzipped = gzipSync("hello");
    const { port } = await guest((res) => {
      res.writeHead(200, {
        "Content-Encoding": "gzip",
        "Content-Length": gzipped.length,
      });
      res.end(gzipped);
    });
    const response = await forwardToGuest(port, {
      method: "GET",
      path: "/",
      headers: new Headers({ host: "hostd.example" }),
      body: null,
    });
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.get("content-length")).toBe(String(gzipped.length));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(gzipped);
  });

  it("keeps every Set-Cookie and the status text", async () => {
    const { port } = await guest((res) => {
      res.statusMessage = "Made It";
      res.writeHead(201, { "Set-Cookie": ["a=1; Path=/", "b=2; Path=/"] });
      res.end();
    });
    const response = await forwardToGuest(port, {
      method: "GET",
      path: "/",
      headers: new Headers({ host: "hostd.example" }),
      body: null,
    });
    expect(response.status).toBe(201);
    expect(response.statusText).toBe("Made It");
    expect(response.headers.getSetCookie()).toEqual([
      "a=1; Path=/",
      "b=2; Path=/",
    ]);
  });

  it.each([
    ["HEAD", 200],
    ["GET", 204],
    ["GET", 304],
  ])("answers %s with %i without a body", async (method, status) => {
    const { port } = await guest((res) => {
      res.writeHead(status);
      res.end();
    });
    const response = await forwardToGuest(port, {
      method,
      path: "/",
      headers: new Headers({ host: "hostd.example" }),
      body: null,
    });
    expect(response.status).toBe(status);
    expect(response.body).toBeNull();
  });

  it("rejects when nothing listens on the port", async () => {
    const closed = await freeLoopbackPort();
    await expect(
      forwardToGuest(closed, {
        method: "GET",
        path: "/",
        headers: new Headers({ host: "hostd.example" }),
        body: null,
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it("aborts the guest request when the caller goes away", async () => {
    let closed = false;
    const { port } = await guest(() => {});
    const controller = new AbortController();
    const pending = forwardToGuest(port, {
      method: "GET",
      path: "/slow",
      headers: new Headers({ host: "hostd.example" }),
      body: null,
      signal: controller.signal,
    }).catch((error: Error) => {
      closed = true;
      return error;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    expect(await pending).toMatchObject({ name: "AbortError" });
    expect(closed).toBe(true);
  });
});
