/**
 * The tunnel against a real peer.
 *
 * Every test here runs a WebSocket server that speaks `amika.tunnel.v2` the
 * way the relay does, dials it with `dialTunnel`, and serves the streams it
 * opens through a real `virtualServer`. Nothing is mocked below the
 * handshake, because the parts that break are the ones between the
 * libraries: credit, half-closes, what a `101` turns into, and what happens
 * when a peer stops answering.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import {
  decodeFrame,
  encodeFrame,
  INITIAL_WINDOW,
  MAX_DATA_BYTES,
  PING,
  PONG,
  TUNNEL_SUBPROTOCOL,
  type Frame,
  type HeaderPair,
  type RequestHead,
} from "@amika/tunnel-protocol";
import { ReceiveWindow, SendWindow } from "@amika/tunnel-protocol/window";
import { dialTunnel } from "./tunnel-dial.js";
import { TunnelSession, type TunnelSessionOptions } from "./tunnel-session.js";
import { virtualServer } from "./tunnel-serving.js";
import { namedRoute } from "./tunnel-rig-route.js";

/** The relay's end: it opens streams, answers pings, and reads frames. */
class RelayPeer {
  readonly frames = new Map<number, Frame[]>();
  readonly resets: Frame[] = [];
  answerPings = true;
  pings = 0;
  private nextStreamId = 1;
  private readonly sendWindows = new Map<number, SendWindow>();
  private readonly receiveWindows = new Map<number, ReceiveWindow>();
  private readonly waiters = new Set<() => void>();
  /** Grant credit back as soon as `DATA` arrives. Off to test a stall. */
  autoGrant = true;

  constructor(readonly ws: ServerSocket) {
    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        if (data.toString() === PING) {
          this.pings += 1;
          if (this.answerPings) ws.send(PONG);
        }
        return;
      }
      const frame = decodeFrame(data as Buffer);
      const list = this.frames.get(frame.streamId) ?? [];
      list.push(frame);
      this.frames.set(frame.streamId, list);
      if (frame.type === "window") {
        this.sendWindows.get(frame.streamId)?.grant(frame.credit);
      }
      if (frame.type === "data") {
        const window = this.receiveWindows.get(frame.streamId);
        if (window && !window.receive(frame.bytes.byteLength)) {
          throw new Error("hostd sent DATA beyond its credit");
        }
        if (this.autoGrant) this.grant(frame.streamId, frame.bytes.byteLength);
      }
      for (const waiter of this.waiters) waiter();
    });
  }

  send(frame: Frame): void {
    this.ws.send(encodeFrame(frame));
  }

  open(
    target: string,
    options: {
      method?: string;
      headers?: HeaderPair[];
      upgrade?: boolean;
    } = {},
  ): number {
    const streamId = this.nextStreamId++;
    this.sendWindows.set(streamId, new SendWindow());
    this.receiveWindows.set(streamId, new ReceiveWindow());
    const head: RequestHead = {
      method: options.method ?? "GET",
      target,
      headers: [
        ["host", "web--rig.r.org.o.amika.test"],
        ...(options.headers ?? []),
      ],
      upgrade: options.upgrade ?? false,
    };
    this.send({ type: "open", streamId, head });
    return streamId;
  }

  /** Send a whole body under credit, then `END`. */
  async body(streamId: number, bytes: Uint8Array): Promise<void> {
    const window = this.sendWindows.get(streamId)!;
    let offset = 0;
    while (offset < bytes.byteLength) {
      const size = await window.take(
        Math.min(MAX_DATA_BYTES, bytes.byteLength - offset),
      );
      this.send({
        type: "data",
        streamId,
        bytes: bytes.subarray(offset, offset + size),
      });
      offset += size;
    }
    this.send({ type: "end", streamId });
  }

  grant(streamId: number, credit: number): void {
    this.receiveWindows.get(streamId)?.release(credit);
    this.send({ type: "window", streamId, credit });
  }

  /** Wait until `predicate` holds over the frames of `streamId`. */
  until(
    streamId: number,
    predicate: (frames: Frame[]) => boolean,
    timeoutMs = 5_000,
  ): Promise<Frame[]> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const frames = this.frames.get(streamId) ?? [];
        if (!predicate(frames)) return;
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve(frames);
      };
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(
          new Error(
            `timed out; stream ${streamId} saw ${JSON.stringify((this.frames.get(streamId) ?? []).map((f) => f.type))}`,
          ),
        );
      }, timeoutMs);
      this.waiters.add(check);
      check();
    });
  }

  /** A whole plain response: the head, the body as text, and how it ended. */
  async response(streamId: number): Promise<{
    status: number;
    headers: HeaderPair[];
    body: string;
  }> {
    const frames = await this.until(streamId, (list) =>
      list.some((f) => f.type === "end" || f.type === "reset"),
    );
    const reset = frames.find((f) => f.type === "reset");
    if (reset && reset.type === "reset") throw new Error(reset.reason);
    const head = frames.find((f) => f.type === "response");
    if (!head || head.type !== "response") throw new Error("no RESPONSE");
    const body = Buffer.concat(
      frames.flatMap((f) => (f.type === "data" ? [Buffer.from(f.bytes)] : [])),
    ).toString("utf8");
    return { status: head.head.status, headers: head.head.headers, body };
  }
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

/** The daemon's side: an app, an upgrade handler, and a session serving them. */
async function attach(
  options: Partial<TunnelSessionOptions> & {
    fetch?: (request: Request, env: unknown) => Response | Promise<Response>;
    upgrade?: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
  } = {},
): Promise<{ relay: RelayPeer; session: TunnelSession }> {
  const wss = new WebSocketServer({
    port: 0,
    host: "127.0.0.1",
    handleProtocols: () => TUNNEL_SUBPROTOCOL,
  });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  cleanups.push(
    () => new Promise<void>((resolve) => wss.close(() => resolve())),
  );
  const accepted = new Promise<ServerSocket>((resolve) =>
    wss.once("connection", resolve),
  );
  const { port } = wss.address() as AddressInfo;
  const dialed = await dialTunnel(
    {
      gatewayUrl: `ws://127.0.0.1:${port}/v2/host-tunnel`,
      hostId: "host_1",
      credential: "cred",
      generation: 1,
    },
    { handshakeTimeoutMs: 5_000, userAgent: "test" },
  );
  const relay = new RelayPeer(await accepted);
  const server = virtualServer({
    fetch:
      options.fetch ??
      ((request: Request) =>
        new Response(`hello ${new URL(request.url).href}`)),
    upgrade: options.upgrade,
  });
  const session = new TunnelSession(dialed.ws, {
    keepAliveIntervalMs: options.keepAliveIntervalMs ?? 30_000,
    pingTimeoutMs: options.pingTimeoutMs ?? 2_000,
    drainMs: options.drainMs ?? 2_000,
    onConnection: (socket) => server.accept(socket),
  });
  cleanups.push(() => session.abort(new Error("test over")));
  return { relay, session };
}

/** An upgrade handler that echoes, the way a rig's WebSocket service would. */
function echoUpgrade(tunnels: Set<Duplex> = new Set()) {
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => [...protocols][0] ?? false,
  });
  cleanups.push(() => wss.close());
  const closes: Array<{ code: number; reason: string }> = [];
  const handler = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    tunnels.add(socket);
    socket.on("close", () => tunnels.delete(socket));
    if (request.url === "/odd-status") {
      // Node's parser takes any three digits; the tunnel takes 100 to 599.
      socket.end(
        "HTTP/1.1 600 Odd\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
      return;
    }
    if (request.url === "/refuse") {
      socket.end(
        "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: 4\r\nConnection: close\r\n\r\nnope",
      );
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      // A service that accepts the connection and then stops reading.
      if (request.url === "/stall") {
        socket.pause();
        return;
      }
      ws.on("message", (data, isBinary) => {
        if (!isBinary && data.toString() === "close-me") {
          ws.close(4321, "asked to");
          return;
        }
        ws.send(data, { binary: isBinary });
      });
      ws.on("close", (code, reason) =>
        closes.push({ code, reason: reason.toString() }),
      );
    });
  };
  return { handler, closes, tunnels };
}

describe("a plain request", () => {
  it("is answered through the daemon's own server", async () => {
    const { relay, session } = await attach();
    expect(await session.acknowledge()).toBeGreaterThanOrEqual(0);
    const id = relay.open("/hello?x=1");
    relay.send({ type: "end", streamId: id });
    const response = await relay.response(id);
    expect(response.status).toBe(200);
    // https, because the public request reached the gateway over TLS, and
    // the authority is the one the relay presented as `Host`.
    expect(response.body).toBe(
      "hello https://web--rig.r.org.o.amika.test/hello?x=1",
    );
    expect(session.servedConnections).toBe(1);
  });

  it("carries a request body larger than one window, under credit", async () => {
    const { relay } = await attach({
      fetch: async (request) =>
        new Response(String((await request.arrayBuffer()).byteLength)),
    });
    const size = INITIAL_WINDOW * 2 + 12345;
    const id = relay.open("/upload", {
      method: "POST",
      headers: [["content-type", "application/octet-stream"]],
    });
    await relay.body(id, new Uint8Array(size).fill(7));
    expect((await relay.response(id)).body).toBe(String(size));
  });

  it("frames a body of unknown length so the server reads all of it", async () => {
    const { relay } = await attach({
      fetch: async (request) => new Response(await request.text()),
    });
    // How the relay sends a body it has no length for.
    const id = relay.open("/echo", {
      method: "DELETE",
      headers: [["transfer-encoding", "chunked"]],
    });
    await relay.body(id, new TextEncoder().encode("abc"));
    expect((await relay.response(id)).body).toBe("abc");
  });

  it("refuses a body on a request whose head declared none", async () => {
    const { relay } = await attach();
    const id = relay.open("/get");
    relay.send({ type: "data", streamId: id, bytes: new Uint8Array([1]) });
    await relay.until(id, (list) => list.some((f) => f.type === "reset"));
  });

  it("streams a response no faster than the relay grants credit", async () => {
    const big = "x".repeat(INITIAL_WINDOW * 3);
    const { relay } = await attach({ fetch: () => new Response(big) });
    relay.autoGrant = false;
    const id = relay.open("/download");
    relay.send({ type: "end", streamId: id });
    const sent = (frames: Frame[]) =>
      frames.reduce(
        (n, f) => n + (f.type === "data" ? f.bytes.byteLength : 0),
        0,
      );
    await relay.until(id, (frames) => sent(frames) === INITIAL_WINDOW);
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Stalled at exactly one window, with nothing more on the wire.
    expect(sent(relay.frames.get(id)!)).toBe(INITIAL_WINDOW);
    relay.autoGrant = true;
    relay.grant(id, INITIAL_WINDOW);
    expect((await relay.response(id)).body.length).toBe(big.length);
  });

  it("delivers the whole of a chunked response the relay drains slowly", async () => {
    // A body of unknown length ends the connection when it ends, so the
    // server's end of the pair is gone while the tail still waits on credit.
    const size = 1024 * 1024;
    const { relay } = await attach({
      fetch: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (let sent = 0; sent < size; sent += 16 * 1024) {
                controller.enqueue(new Uint8Array(16 * 1024).fill(120));
              }
              controller.close();
            },
          }),
        ),
    });
    relay.autoGrant = false;
    const id = relay.open("/download");
    relay.send({ type: "end", streamId: id });
    const granting = setInterval(() => relay.grant(id, 32 * 1024), 20);
    try {
      expect((await relay.response(id)).body.length).toBe(size);
    } finally {
      clearInterval(granting);
    }
  });

  it("is reset when the relay sends DATA beyond its credit", async () => {
    const { relay } = await attach({
      // Never reads the body, so no credit is returned.
      fetch: () => new Promise<Response>(() => {}),
    });
    const id = relay.open("/upload", { method: "POST" });
    const chunk = new Uint8Array(MAX_DATA_BYTES);
    // Far past one window. The server never reads, so once its buffers
    // fill no credit comes back, and the relay is over.
    for (let sent = 0; sent <= 4 * INITIAL_WINDOW; sent += chunk.byteLength) {
      relay.send({ type: "data", streamId: id, bytes: chunk });
    }
    const frames = await relay.until(id, (list) =>
      list.some((f) => f.type === "reset"),
    );
    const reset = frames.find((f) => f.type === "reset");
    expect(reset?.type === "reset" && reset.reason).toContain("credit");
  });
});

describe("an upgrade", () => {
  it("relays messages both ways, text as text and binary as binary", async () => {
    const echo = echoUpgrade();
    const { relay } = await attach({ upgrade: echo.handler });
    const id = relay.open("/ws", {
      upgrade: true,
      headers: [["sec-websocket-protocol", "chat, other"]],
    });
    const opened = await relay.until(id, (list) =>
      list.some((f) => f.type === "response"),
    );
    const head = opened.find((f) => f.type === "response");
    expect(head?.type === "response" && head.head.status).toBe(101);
    expect(
      head?.type === "response" &&
        head.head.headers.find(
          ([name]) => name.toLowerCase() === "sec-websocket-protocol",
        )?.[1],
    ).toBe("chat");

    relay.send({ type: "message", streamId: id, data: "hi" });
    relay.send({ type: "message", streamId: id, data: new Uint8Array([1, 2]) });
    const messages = await relay.until(
      id,
      (list) => list.filter((f) => f.type === "message").length === 2,
    );
    const [text, binary] = messages.filter((f) => f.type === "message");
    expect(text?.type === "message" && text.data).toBe("hi");
    expect(
      binary?.type === "message" &&
        typeof binary.data !== "string" && [...binary.data],
    ).toEqual([1, 2]);
  });

  it("carries the relay's close code to the server", async () => {
    const echo = echoUpgrade();
    const { relay } = await attach({ upgrade: echo.handler });
    const id = relay.open("/ws", { upgrade: true });
    await relay.until(id, (list) => list.some((f) => f.type === "response"));
    relay.send({ type: "close", streamId: id, code: 4000, reason: "bye" });
    await expect
      .poll(() => echo.closes)
      .toEqual([{ code: 4000, reason: "bye" }]);
  });

  it("carries the server's close code to the relay", async () => {
    const echo = echoUpgrade();
    const { relay } = await attach({ upgrade: echo.handler });
    const id = relay.open("/ws", { upgrade: true });
    await relay.until(id, (list) => list.some((f) => f.type === "response"));
    relay.send({ type: "message", streamId: id, data: "close-me" });
    const frames = await relay.until(id, (list) =>
      list.some((f) => f.type === "close"),
    );
    const close = frames.find((f) => f.type === "close");
    expect(close?.type === "close" && [close.code, close.reason]).toEqual([
      4321,
      "asked to",
    ]);
  });

  it("closes the stream rather than queue without bound for a service that stops reading", async () => {
    const echo = echoUpgrade();
    const { relay } = await attach({ upgrade: echo.handler });
    const id = relay.open("/stall", { upgrade: true });
    await relay.until(id, (list) => list.some((f) => f.type === "response"));
    const megabyte = new Uint8Array(1024 * 1024);
    for (let sent = 0; sent < 12; sent += 1) {
      relay.send({ type: "message", streamId: id, data: megabyte });
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const frames = await relay.until(id, (list) =>
      list.some((f) => f.type === "close"),
    );
    const close = frames.find((f) => f.type === "close");
    expect(close?.type === "close" && close.code).toBe(1013);
  });

  it("answers a refused upgrade as a plain response", async () => {
    const echo = echoUpgrade();
    const { relay } = await attach({ upgrade: echo.handler });
    const id = relay.open("/refuse", { upgrade: true });
    const response = await relay.response(id);
    expect(response.status).toBe(403);
    expect(response.body).toBe("nope");
  });

  it("resets only its stream when a refusal's head cannot cross the tunnel", async () => {
    const echo = echoUpgrade();
    const { relay } = await attach({ upgrade: echo.handler });
    const odd = relay.open("/odd-status", { upgrade: true });
    await expect(relay.response(odd)).rejects.toThrow(/status 600/);
    expect(
      (relay.frames.get(odd) ?? []).some((f) => f.type === "response"),
    ).toBe(false);
    // The tunnel carries on for the next caller.
    const id = relay.open("/refuse", { upgrade: true });
    expect((await relay.response(id)).status).toBe(403);
  });

  it("ends at the relay when shutdown cuts the upgraded connection", async () => {
    const echo = echoUpgrade();
    const { relay } = await attach({ upgrade: echo.handler });
    const id = relay.open("/ws", { upgrade: true });
    await relay.until(id, (list) => list.some((f) => f.type === "response"));
    expect(echo.tunnels.size).toBe(1);
    for (const socket of echo.tunnels) socket.destroy();
    await relay.until(id, (list) => list.some((f) => f.type === "close"));
  });
});

describe("a request the relay names by rig and service", () => {
  /** A host that says which path, which service, and which headers it saw. */
  function echoing(request: Request, env: unknown): Response {
    const url = new URL(request.url);
    return Response.json({
      path: `${url.pathname}${url.search}`,
      host: request.headers.get("host"),
      named:
        namedRoute((env as { incoming: IncomingMessage }).incoming) ?? null,
      amika: [...request.headers.keys()].filter((name) =>
        name.startsWith("x-amika-"),
      ),
    });
  }

  it("reaches the app named for that service, with the path asked for", async () => {
    const { relay } = await attach({ fetch: echoing });
    const id = relay.open("/app/page?q=1", {
      headers: [
        ["x-amika-rig", "hacks"],
        ["x-amika-service", "web"],
      ],
    });
    relay.send({ type: "end", streamId: id });
    expect(JSON.parse((await relay.response(id)).body)).toEqual({
      path: "/app/page?q=1",
      host: "web--rig.r.org.o.amika.test",
      named: { machine: "hacks", service: "web" },
      // Read, then removed: the service does not see them.
      amika: [],
    });
  });

  it("leaves a request that names no rig for this daemon's own API", async () => {
    const { relay } = await attach({ fetch: echoing });
    const id = relay.open("/v0beta1/rigs?limit=2");
    relay.send({ type: "end", streamId: id });
    expect(JSON.parse((await relay.response(id)).body)).toMatchObject({
      path: "/v0beta1/rigs?limit=2",
      named: null,
    });
  });

  it("refuses half a name, and the app never sees it", async () => {
    let reached = false;
    const { relay } = await attach({
      fetch: () => {
        reached = true;
        return new Response("served");
      },
    });
    const id = relay.open("/app", { headers: [["x-amika-rig", "hacks"]] });
    relay.send({ type: "end", streamId: id });
    expect((await relay.response(id)).status).toBe(400);
    expect(reached).toBe(false);
  });

  it("names an upgrade before the upgrade handler sees it", async () => {
    let seen: { url?: string; named?: unknown; rig?: unknown } = {};
    const echo = echoUpgrade();
    const { relay } = await attach({
      upgrade: (request, socket, head) => {
        seen = {
          url: request.url,
          named: namedRoute(request),
          rig: request.headers["x-amika-rig"],
        };
        echo.handler(request, socket, head);
      },
    });
    const id = relay.open("/live", {
      upgrade: true,
      headers: [
        ["x-amika-rig", "hacks"],
        ["x-amika-service", "web"],
      ],
    });
    await relay.until(id, (list) => list.some((f) => f.type === "response"));
    expect(seen).toEqual({
      url: "/live",
      named: { machine: "hacks", service: "web" },
      rig: undefined,
    });
  });
});

describe("the session", () => {
  it("answers DATA for a stream it does not have with a reset", async () => {
    const { relay } = await attach();
    relay.send({ type: "data", streamId: 99, bytes: new Uint8Array([1]) });
    await relay.until(99, (list) => list.some((f) => f.type === "reset"));
  });

  it("ends when the relay stops answering pings", async () => {
    const { relay, session } = await attach({
      keepAliveIntervalMs: 50,
      pingTimeoutMs: 50,
    });
    await session.acknowledge();
    relay.answerPings = false;
    const ended = await new Promise<Error | undefined>((resolve) =>
      session.onEnded(resolve),
    );
    expect(ended?.message).toContain("did not answer a tunnel ping");
  });

  it("stays attached while the relay answers", async () => {
    const { relay, session } = await attach({
      keepAliveIntervalMs: 20,
      pingTimeoutMs: 200,
    });
    await session.acknowledge();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(relay.pings).toBeGreaterThan(2);
    expect(session.isEnded).toBe(false);
  });

  it("ends when the relay reuses the id of a stream that has finished", async () => {
    const { relay, session } = await attach();
    const id = relay.open("/hello");
    relay.send({ type: "end", streamId: id });
    await relay.response(id);
    await expect.poll(() => session.activeConnections).toBe(0);
    relay.send({
      type: "open",
      streamId: id,
      head: {
        method: "GET",
        target: "/hello",
        headers: [["host", "web--rig.r.org.o.amika.test"]],
        upgrade: false,
      },
    });
    const ended = await new Promise<Error | undefined>((resolve) =>
      session.onEnded(resolve),
    );
    expect(ended?.name).toBe("ProtocolError");
  });

  it("ends on a text message that is not a pong", async () => {
    const { relay, session } = await attach();
    relay.ws.send("hello");
    const ended = await new Promise<Error | undefined>((resolve) =>
      session.onEnded(resolve),
    );
    expect(ended?.name).toBe("ProtocolError");
  });

  it("lets a request in flight finish, then closes the WebSocket", async () => {
    const { relay, session } = await attach({
      fetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return new Response("late");
      },
    });
    const id = relay.open("/slow");
    relay.send({ type: "end", streamId: id });
    await expect.poll(() => session.activeConnections).toBe(1);
    const closed = new Promise<number>((resolve) =>
      relay.ws.once("close", (code) => resolve(code)),
    );
    const closing = session.close();
    // Opened after shutdown began: reset, not served.
    const late = relay.open("/late");
    expect((await relay.response(id)).body).toBe("late");
    await relay.until(late, (list) => list.some((f) => f.type === "reset"));
    await closing;
    expect(await closed).toBe(1001);
  });
});
