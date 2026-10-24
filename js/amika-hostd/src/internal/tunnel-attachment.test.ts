/**
 * The tunnel against a real peer.
 *
 * Every test here runs a WebSocket server, a second `@libp2p/yamux`
 * multiplexer configured the way the gateway configures its own, and Node's
 * HTTP client writing into a yamux stream. Nothing is mocked below the
 * handshake, because the parts that break are the ones between the
 * libraries: stream-id parity, who may open a stream, what a half-close
 * means, and what happens when a peer stops answering.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Duplex as NodeDuplex, type Duplex } from "node:stream";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { yamux } from "@libp2p/yamux";
import type { StreamMuxer } from "@libp2p/interface";
import { getRequestListener } from "@hono/node-server";
import { TunnelByteStream } from "./tunnel-byte-stream.js";
import { TunnelSocket } from "./tunnel-socket.js";
import { TunnelAttachment, DEFAULT_LIMITS } from "./tunnel-attachment.js";
import { dialTunnel, TUNNEL_SUBPROTOCOL } from "./tunnel-dial.js";
import { virtualServer } from "./tunnel-serving.js";

const LIMITS = DEFAULT_LIMITS;

/** The gateway's end: it opens streams, and it accepts none. */
class GatewayPeer {
  readonly bytes: TunnelByteStream;
  readonly muxer: StreamMuxer;

  constructor(ws: ServerSocket) {
    this.bytes = new TunnelByteStream(ws, { ...LIMITS, direction: "inbound" });
    this.muxer = yamux({
      enableKeepAlive: false,
      keepAliveInterval: 30_000,
      maxInboundStreams: 0,
      maxOutboundStreams: LIMITS.maxConcurrentStreams,
      streamOptions: {
        initialStreamWindowSize: LIMITS.maxFrameBytes,
        maxStreamWindowSize: LIMITS.maxFrameBytes,
        maxWriteBufferLength: LIMITS.maxWriteBufferBytes,
      },
    })().createStreamMuxer(this.bytes);
  }

  /** One forwarded request, the way `forwardRequest` sends it. */
  async send(
    path: string,
    options: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    } = {},
  ): Promise<{ status: number; headers: string[]; body: string }> {
    const stream = await this.muxer.createStream();
    const socket = new TunnelSocket(stream);
    return new Promise((resolve, reject) => {
      const outbound = httpRequest({
        method: options.method ?? "GET",
        path,
        headers: { host: "h-test.hosts.amika.dev", ...options.headers },
        createConnection: () => socket,
        setHost: false,
      });
      outbound.once("response", (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.rawHeaders,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      });
      outbound.once("error", reject);
      outbound.end(options.body);
    });
  }

  /**
   * One upgrade handshake, written as raw bytes with the client's first
   * frame in the same write. That is what `forwardUpgrade` does, and it is
   * the case where a lost byte raises no error at either end.
   */
  async upgrade(
    path: string,
    early: string,
  ): Promise<{
    write(text: string): void;
    until(text: string): Promise<string>;
  }> {
    const stream = await this.muxer.createStream();
    const socket = new TunnelSocket(stream);
    // The channel is torn down when the test ends, which a raw socket
    // reports as an error with nowhere to go.
    socket.on("error", () => {});
    let seen = "";
    const waiters: Array<() => void> = [];
    socket.on("data", (chunk: Buffer) => {
      seen += chunk.toString("utf8");
      for (const wake of waiters.splice(0)) wake();
    });
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: h-test.hosts.amika.dev\r\n` +
        `Connection: Upgrade\r\nUpgrade: amika-ssh\r\n\r\n${early}`,
    );
    return {
      write: (text: string) => socket.write(text),
      until: (text: string) =>
        new Promise((resolve) => {
          const check = () => {
            if (seen.includes(text)) resolve(seen);
            else waiters.push(check);
          };
          check();
        }),
    };
  }
}

interface Harness {
  attachment: TunnelAttachment;
  gateway: GatewayPeer;
  closedWithCode: Promise<number>;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * A gateway, an attached host, and whatever `serve` answers with. The host
 * end goes through `dialTunnel`, so the subprotocol and the handshake
 * headers are exercised too.
 */
async function attach(
  serve: (request: Request) => Response | Promise<Response>,
  options: {
    keepAliveIntervalMs?: number;
    pingTimeoutMs?: number;
    limits?: typeof DEFAULT_LIMITS;
    upgrade?: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
  } = {},
): Promise<Harness> {
  const wss = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    perMessageDeflate: false,
    handleProtocols: (protocols) =>
      protocols.has(TUNNEL_SUBPROTOCOL) ? TUNNEL_SUBPROTOCOL : false,
  });
  wss.on("headers", (headers) => {
    headers.push("amika-connection-id: conn-1");
    headers.push("amika-host-url: https://h-test.hosts.amika.dev");
  });
  cleanups.push(() => new Promise<void>((done) => wss.close(() => done())));
  await new Promise<void>((ready) => wss.once("listening", ready));
  const { port } = wss.address() as AddressInfo;

  let resolveGateway: (peer: GatewayPeer) => void;
  let resolveCode: (code: number) => void;
  const gatewayReady = new Promise<GatewayPeer>((r) => (resolveGateway = r));
  const closedWithCode = new Promise<number>((r) => (resolveCode = r));
  wss.on("connection", (ws) => {
    ws.once("close", (code) => resolveCode(code));
    resolveGateway(new GatewayPeer(ws));
  });

  const dialed = await dialTunnel(
    {
      gatewayUrl: `ws://127.0.0.1:${port}/attach`,
      hostId: "host-1",
      credential: "cred-1",
      generation: 1,
    },
    { handshakeTimeoutMs: 2_000, userAgent: "amika-hostd/test" },
  );
  expect(dialed.connectionId).toBe("conn-1");
  expect(dialed.publicUrl).toBe("https://h-test.hosts.amika.dev");

  const server = virtualServer({ fetch: serve, upgrade: options.upgrade });
  const attachment = new TunnelAttachment(dialed.ws, {
    limits: options.limits,
    keepAliveIntervalMs: options.keepAliveIntervalMs ?? 30_000,
    pingTimeoutMs: options.pingTimeoutMs ?? 2_000,
    drainMs: 1_000,
    onConnection: (socket: Duplex) => server.accept(socket),
  });
  cleanups.push(() => {
    server.close();
    attachment.abort(new Error("test over"));
  });
  const gateway = await gatewayReady;
  await attachment.acknowledge();
  return { attachment, gateway, closedWithCode };
}

describe("the tunnel carries requests the gateway opens", () => {
  it("answers a forwarded request through the same routes a listener serves", async () => {
    const { gateway } = await attach((request) => {
      const url = new URL(request.url);
      return new Response(`served ${url.pathname}${url.search}`, {
        status: 201,
        headers: [
          ["set-cookie", "a=1"],
          ["set-cookie", "b=2"],
        ],
      });
    });

    const answer = await gateway.send("/v0beta1/rigs?limit=2");

    expect(answer.status).toBe(201);
    expect(answer.body).toBe("served /v0beta1/rigs?limit=2");
    // Repeated headers survive: a response with two `Set-Cookie` lines is
    // the ordinary case for hostd's browser login.
    const cookies = answer.headers.filter(
      (_value, index) =>
        index % 2 === 1 &&
        answer.headers[index - 1]!.toLowerCase() === "set-cookie",
    );
    expect(cookies).toEqual(["a=1", "b=2"]);
  });

  it("tells the app the request arrived over https", async () => {
    // The gateway terminates TLS and strips every `x-forwarded-*` header a
    // client sent, so the socket's own flag is the only thing that can
    // carry the scheme. hostd's `__Host-` cookies and its redirects depend
    // on it.
    const { gateway } = await attach(
      (request) => new Response(new URL(request.url).protocol),
    );

    expect((await gateway.send("/health")).body).toBe("https:");
  });

  it("streams a body without waiting for the end of it", async () => {
    const chunks = ["one", "two", "three"];
    const { gateway } = await attach(
      () =>
        new Response(
          new ReadableStream({
            async pull(controller) {
              const next = chunks.shift();
              if (next === undefined) {
                controller.close();
                return;
              }
              controller.enqueue(new TextEncoder().encode(next));
              await new Promise((done) => setTimeout(done, 5));
            },
          }),
        ),
    );

    expect((await gateway.send("/stream")).body).toBe("onetwothree");
  });

  it("carries a request body up to the host", async () => {
    const { gateway } = await attach(
      async (request) => new Response(`got ${await request.text()}`),
    );

    const answer = await gateway.send("/v0beta1/rigs", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "a rig, please",
    });

    expect(answer.body).toBe("got a rig, please");
  });

  it("bounds how many requests the gateway may have in flight", async () => {
    // The gateway bounds this from its side too. This bound is the one
    // that protects the operator's machine when the gateway's is wrong,
    // and the multiplexer enforces it below any code here: the extra
    // stream is reset on arrival, with no event to observe.
    let release: () => void;
    const started = new Promise<void>((resolve) => (release = resolve));
    const { gateway } = await attach(
      async () => {
        release();
        await new Promise((done) => setTimeout(done, 100));
        return new Response("ok");
      },
      { limits: { ...DEFAULT_LIMITS, maxConcurrentStreams: 1 } },
    );

    const held = gateway.send("/first");
    await started;

    await expect(gateway.send("/second")).rejects.toThrow();
    expect((await held).body).toBe("ok");
  });
});

describe("an upgrade stops being HTTP at the 101", () => {
  it("hands the stream over as an opaque channel in both directions", async () => {
    // SSH, the web terminal and a rig's service WebSockets all take this
    // path, and all of them lose data silently if a head byte goes
    // missing. The gateway's forwarder writes the client's early bytes
    // after the host agrees; this checks the host end of that exchange.
    const { gateway } = await attach(() => new Response("not here"), {
      upgrade: (_request, socket, head) => {
        socket.on("error", () => {});
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: amika-ssh\r\nConnection: Upgrade\r\n\r\n",
        );
        // The bytes the gateway sent in the same packet as the handshake.
        socket.write(`head:${head.toString("utf8")};`);
        socket.on("data", (chunk: Buffer) =>
          socket.write(`echo:${chunk.toString("utf8")};`),
        );
      },
    });

    const channel = await gateway.upgrade("/v0beta1/rigs/a/ssh", "first-frame");
    const handshake = await channel.until("head:first-frame;");
    expect(handshake).toContain("HTTP/1.1 101 Switching Protocols");

    channel.write("ping");

    expect(await channel.until("echo:ping;")).toContain("echo:ping;");
  });
});

describe("liveness", () => {
  it("ends the attachment when the gateway stops answering pings", async () => {
    // The failure a laptop lid produces: the socket stays in ESTABLISHED,
    // bytes are still accepted by the kernel, and nothing at the far end
    // reads them. Pausing the gateway's read side reproduces exactly that,
    // and no WebSocket or TCP event reports it.
    const { attachment, gateway } = await attach(() => new Response("ok"), {
      keepAliveIntervalMs: 50,
      pingTimeoutMs: 100,
    });
    const ended = new Promise<Error | undefined>((resolve) =>
      attachment.onEnded(resolve),
    );

    gateway.bytes.sendPause();

    const error = await ended;
    expect(error?.message).toMatch(/did not answer a tunnel ping/);
    expect(attachment.isEnded).toBe(true);
  }, 10_000);

  it("stays attached while the gateway answers", async () => {
    const { attachment } = await attach(() => new Response("ok"), {
      keepAliveIntervalMs: 20,
      pingTimeoutMs: 100,
    });

    await new Promise((done) => setTimeout(done, 150));

    expect(attachment.isEnded).toBe(false);
  });
});

describe("shutdown", () => {
  it("closes the WebSocket so the gateway gives up the route", async () => {
    const { attachment, closedWithCode } = await attach(
      () => new Response("ok"),
    );

    await attachment.close();

    // 1001 "going away". A dropped TCP connection would leave the gateway
    // routing into a socket nobody reads until its own check noticed.
    expect(await closedWithCode).toBe(1001);
  });

  it("lets a request in flight finish before it closes", async () => {
    let release: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { attachment, gateway } = await attach(async () => {
      release();
      await new Promise((done) => setTimeout(done, 60));
      return new Response("finished");
    });

    const answer = gateway.send("/slow");
    await held;
    await attachment.close();

    expect((await answer).body).toBe("finished");
  });

  it("refuses a stream the gateway opens after shutdown started", async () => {
    const { attachment, gateway } = await attach(() => new Response("ok"));
    const closing = attachment.close();

    await expect(gateway.send("/late")).rejects.toThrow();
    await closing;
  });
});

describe("the virtual server", () => {
  it("serves an injected connection the same way a listener would", async () => {
    // A direct check of the technique the tunnel rests on: an `http.Server`
    // that never listened, fed a Duplex through its `connection` event.
    const server = createServer(
      getRequestListener(() => new Response("from a socket with no listener")),
    );
    const toServer = new NodeDuplex({
      read() {},
      write(chunk, _encoding, callback) {
        received.push(chunk as Buffer);
        callback();
      },
    }) as Duplex & { encrypted?: boolean };
    const received: Buffer[] = [];
    server.emit("connection", toServer);
    toServer.push("GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");

    await new Promise((done) => setTimeout(done, 50));

    expect(Buffer.concat(received).toString("utf8")).toContain(
      "from a socket with no listener",
    );
  });
});
