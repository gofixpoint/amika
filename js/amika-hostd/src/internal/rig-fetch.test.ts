/**
 * `createRigFetch` against real services on loopback: what `proxyService`
 * takes from it, as it took from `fetch`. `app.test.ts` covers the service
 * routes over it, read slowly.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRigFetch } from "./rig-fetch.js";

const rigFetch = createRigFetch();
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

describe("createRigFetch", () => {
  it("forwards the method, target, headers and a streamed body, and returns the answer", async () => {
    let seen: { method?: string; url?: string; header?: string; body: string };
    const port = await serve((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => (body += chunk));
      request.on("end", () => {
        seen = {
          method: request.method,
          url: request.url,
          header: request.headers["x-guest"] as string,
          body,
        };
        response.writeHead(201, "Made", [
          ["set-cookie", "a=1"],
          ["set-cookie", "b=2"],
          ["x-answer", "yes"],
        ]);
        response.end("created");
      });
    });
    const parts = ["pay", "load"];
    const response = await rigFetch(`http://127.0.0.1:${port}/items?limit=2`, {
      method: "POST",
      headers: { "x-guest": "1", "content-type": "text/plain" },
      body: new ReadableStream({
        pull(controller) {
          const part = parts.shift();
          if (part) controller.enqueue(new TextEncoder().encode(part));
          else controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    expect(response.status).toBe(201);
    expect(response.statusText).toBe("Made");
    expect(response.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
    expect(response.headers.get("x-answer")).toBe("yes");
    expect(await response.text()).toBe("created");
    expect(seen!).toEqual({
      method: "POST",
      url: "/items?limit=2",
      header: "1",
      body: "payload",
    });
  });

  it("follows no redirect", async () => {
    const port = await serve((_request, response) => {
      response.writeHead(302, { location: "/elsewhere" }).end();
    });
    const response = await rigFetch(`http://127.0.0.1:${port}/`);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/elsewhere");
  });

  it("rejects an unsolicited upgrade instead of leaving the request pending", async () => {
    const port = await serve((_request, response) => {
      response
        .writeHead(101, {
          connection: "Upgrade",
          upgrade: "websocket",
        })
        .end();
    });
    await expect(
      settlesWithin(rigFetch(`http://127.0.0.1:${port}/`), 2_000),
    ).rejects.toThrow(/closed before sending a response/);
  });

  it("gives no body for HEAD or a 204", async () => {
    const port = await serve((request, response) => {
      response.writeHead(request.method === "HEAD" ? 200 : 204).end();
    });
    const head = await rigFetch(`http://127.0.0.1:${port}/`, {
      method: "HEAD",
    });
    expect(head.body).toBeNull();
    const empty = await rigFetch(`http://127.0.0.1:${port}/`);
    expect(empty.status).toBe(204);
    expect(empty.body).toBeNull();
  });

  it.each([
    ["gzip", zlib.gzipSync],
    ["x-gzip", zlib.gzipSync],
    ["deflate", zlib.deflateSync],
    ["deflate", zlib.deflateRawSync],
    ["br", zlib.brotliCompressSync],
    [
      "gzip, br",
      (bytes: Buffer) => zlib.brotliCompressSync(zlib.gzipSync(bytes)),
    ],
  ])("decodes %s as fetch does", async (coding, encode) => {
    const text = "a body worth compressing ".repeat(100);
    const port = await serve((_request, response) => {
      response.writeHead(200, { "content-encoding": coding });
      response.end(encode(Buffer.from(text)));
    });
    const response = await rigFetch(`http://127.0.0.1:${port}/`);
    expect(await response.text()).toBe(text);
  });

  it.each([zlib.deflateSync, zlib.deflateRawSync])(
    "bounds decoded deflate buffering while a reader is paused and resumes without losing bytes",
    async (encode) => {
      const bytes = Buffer.alloc(16 * 1024 * 1024, 7);
      const encoded = encode(bytes);
      const port = await serve((_request, response) => {
        response.writeHead(200, { "content-encoding": "deflate" });
        response.end(encoded);
      });
      // Observe the real decoder queue without replacing the stream adapter.
      const webAdapter = vi.spyOn(Readable, "toWeb");
      let decoded: Readable | undefined;
      try {
        const response = await rigFetch(`http://127.0.0.1:${port}/`);
        decoded = webAdapter.mock.calls[0][0];
        await sleep(250);
        expect(decoded.readableLength).toBeLessThanOrEqual(
          decoded.readableHighWaterMark * 2,
        );
        expect(
          Buffer.from(await settlesWithin(response.arrayBuffer(), 2_000)),
        ).toEqual(bytes);
      } finally {
        decoded?.destroy();
        webAdapter.mockRestore();
      }
    },
  );

  it("destroys a paused deflate decoder when the caller cancels", async () => {
    const encoded = zlib.deflateSync(Buffer.alloc(16 * 1024 * 1024, 7));
    let serviceClosed!: Promise<void>;
    const port = await serve((request, response) => {
      serviceClosed = closeOf(request);
      response.writeHead(200, { "content-encoding": "deflate" });
      response.write(encoded);
    });
    // Observe the real inflater without replacing its implementation.
    const produced = vi.spyOn(zlib.Inflate.prototype, "push");
    let response: Response | undefined;
    try {
      response = await rigFetch(`http://127.0.0.1:${port}/`);
      await vi.waitFor(() =>
        expect(produced.mock.contexts.length).toBeGreaterThan(0),
      );
      const inflater = produced.mock.contexts[0] as zlib.Inflate;
      await vi.waitFor(() => expect(inflater.isPaused()).toBe(true));
      await response.body!.cancel();
      await vi.waitFor(() => expect(inflater.destroyed).toBe(true));
      await settlesWithin(serviceClosed, 2_000);
    } finally {
      await response?.body?.cancel();
      produced.mockRestore();
    }
  });

  it("leaves a body in a coding fetch does not know as it came", async () => {
    const port = await serve((_request, response) => {
      response.writeHead(200, { "content-encoding": "compress" });
      response.end("as sent");
    });
    const response = await rigFetch(`http://127.0.0.1:${port}/`);
    expect(await response.text()).toBe("as sent");
  });

  it("rejects when nothing listens", async () => {
    const port = await serve(() => {});
    await closers.pop()!();
    await expect(rigFetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it("stops a response under way when its signal aborts, and the service sees the connection close", async () => {
    let serviceClosed!: Promise<void>;
    const port = await serve((request, response) => {
      serviceClosed = new Promise((resolve) =>
        request.socket.once("close", () => resolve()),
      );
      response.writeHead(200, { "content-length": "1000000" });
      response.write("first part");
    });
    const abort = new AbortController();
    const response = await rigFetch(`http://127.0.0.1:${port}/`, {
      signal: abort.signal,
    });
    const reader = response.body!.getReader();
    await reader.read();
    abort.abort();
    await expect(reader.read()).rejects.toThrow();
    await serviceClosed;
  });

  it("rejects at once for a signal already aborted", async () => {
    const port = await serve((_request, response) => response.end("ok"));
    await expect(
      rigFetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.abort() }),
    ).rejects.toThrow();
  });
});

describe("createRigFetch timeouts", () => {
  const SHORT_MS = 150;
  const timed = createRigFetch({
    headersTimeoutMs: SHORT_MS,
    bodyTimeoutMs: SHORT_MS,
  });

  it("rejects a request whose service sends no response head in time", async () => {
    let serviceClosed!: Promise<void>;
    const port = await serve((request) => {
      serviceClosed = closeOf(request);
    });
    const started = Date.now();
    await expect(
      settlesWithin(timed(`http://127.0.0.1:${port}/`), 2_000),
    ).rejects.toThrow(/no response head/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(SHORT_MS - 10);
    await serviceClosed;
  });

  it("allows an upload that progresses longer than the response head timeout", async () => {
    let received = 0;
    const port = await serve((request, response) => {
      request.on("data", (chunk: Buffer) => {
        received += chunk.length;
      });
      request.on("end", () => response.end(String(received)));
    });
    let chunks = 6;
    const response = await settlesWithin(
      timed(`http://127.0.0.1:${port}/`, {
        method: "POST",
        body: new ReadableStream({
          async pull(controller) {
            if (chunks-- === 0) {
              controller.close();
              return;
            }
            await sleep(SHORT_MS / 3);
            controller.enqueue(new Uint8Array(1024));
          },
        }),
        duplex: "half",
      } as RequestInit),
      2_000,
    );
    expect(await response.text()).toBe(String(6 * 1024));
  });

  it("fails a body whose service sends no data in time", async () => {
    let serviceClosed!: Promise<void>;
    const port = await serve((request, response) => {
      serviceClosed = closeOf(request);
      response.writeHead(200, { "content-length": "100" });
      response.write("first");
    });
    const response = await timed(`http://127.0.0.1:${port}/`);
    await expect(settlesWithin(response.text(), 2_000)).rejects.toThrow(
      /no body data/,
    );
    await serviceClosed;
  });

  it("does not count the time a slow reader keeps the body paused", async () => {
    // A burst that fills the buffers, then chunks that come slowly but
    // each within the timeout. The reader stops for longer than the
    // timeout after its first chunk.
    const burst = Buffer.alloc(1024 * 1024, 7);
    const port = await serve(async (_request, response) => {
      response.writeHead(200);
      response.write(burst);
      for (let i = 0; i < 4; i += 1) {
        await sleep(SHORT_MS / 3);
        response.write("x".repeat(1024));
      }
      response.end();
    });
    const response = await timed(`http://127.0.0.1:${port}/`);
    const reader = response.body!.getReader();
    let bytes = 0;
    let pause = SHORT_MS * 3;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      await sleep(pause);
      pause = 0;
    }
    expect(bytes).toBe(burst.length + 4 * 1024);
  });
});

/** The promise, or a rejection if it does not settle within `ms`. */
function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    sleep(ms).then(() => {
      throw new Error(`did not settle within ${ms} ms`);
    }),
  ]);
}

/** Resolves when the service's end of the connection closes. */
function closeOf(request: IncomingMessage): Promise<void> {
  return new Promise((resolve) =>
    request.socket.once("close", () => resolve()),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A real HTTP server on a free loopback port, closed after the test. */
async function serve(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<number> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(() => resolve()));
  });
  return (server.address() as AddressInfo).port;
}
