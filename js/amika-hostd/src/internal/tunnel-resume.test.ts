/**
 * `amika.tunnel.v3` at hostd's end: a session that outlives its socket.
 *
 * The client, the session and the daemon's own HTTP server are real. The
 * network is a `FaultPipe`, which a test cuts or silences at any frame, and
 * the relay is `SimRelay`, which counts, acknowledges and resumes the way
 * the relay does. The relay's own code meets this end in amika-mono's
 * integration test.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import {
  CLOSE_SESSION_ENDED,
  decodeFrame,
  decodeFrameV3,
  encodeAck,
  encodeFrame,
  MAX_DATA_BYTES,
  PING,
  PONG,
  TUNNEL_SUBPROTOCOL,
  TUNNEL_SUBPROTOCOL_V3,
  type Frame,
  type HeaderPair,
} from "@amika/tunnel-protocol";
import { AckSchedule, ReplayLog } from "@amika/tunnel-protocol/resume";
import { ReceiveWindow, SendWindow } from "@amika/tunnel-protocol/window";
import { DEFAULT_BACKOFF, type BackoffOptions } from "./tunnel-backoff.js";
import {
  DEFAULT_RESUME,
  TunnelClient,
  type ResumeSettings,
  type TunnelEvent,
} from "./tunnel-client.js";
import {
  TunnelUnavailable,
  type DialedTunnel,
  type DialOptions,
} from "./tunnel-dial.js";
import { FaultPipe } from "./tunnel-fault-pipe.js";
import { virtualServer } from "./tunnel-serving.js";

const FAST_RESUME: ResumeSettings = {
  keepAliveIntervalMs: 40,
  pingTimeoutMs: 30,
  maxMissedPings: 1,
  graceMs: 1_000,
  maxReplayBytes: 32 * 1024 * 1024,
  pauseReplayBytes: 16 * 1024 * 1024,
  ackBytes: 64 * 1024,
  ackDelayMs: 5,
};

/**
 * The relay's end, simulated: it opens streams, sends bodies under credit,
 * answers pings, and in v3 counts, acknowledges and resumes. It records
 * every frame it processes, by stream, so a test can check that each one
 * arrived exactly once.
 */
class SimRelay {
  /** Select v3 when it is offered. Off is `GATEWAY_TUNNEL_RESUME=off`. */
  resumeOn = true;
  /** Answer the next resume with a fresh session instead. */
  refuseNextResume = false;
  /** Send this as the received count on the next resumed `101`. */
  lieAboutReceived?: number;
  /** Fail every dial, as a network that is down does. */
  unreachable = false;
  /** Stop acknowledging, as a relay that is slow or hostile does. */
  acknowledge = true;
  answerPings = true;
  /** Limit each new socket to this many bytes a second each way. */
  bytesPerSecond?: number;

  readonly dials: DialOptions[] = [];
  readonly frames = new Map<number, Frame[]>();
  readonly closes: number[] = [];
  pipe?: FaultPipe;
  private connections = 0;
  private session?: {
    id: string;
    version: 2 | 3;
    log: ReplayLog;
    acks: AckSchedule;
    ackTimer?: NodeJS.Timeout;
  };
  private nextStreamId = 1;
  private readonly sendWindows = new Map<number, SendWindow>();
  private readonly receiveWindows = new Map<number, ReceiveWindow>();
  private readonly waiters = new Set<() => void>();

  /** hostd dials: decide the protocol and whether to resume. */
  dial(options: DialOptions): DialedTunnel {
    this.dials.push(options);
    if (this.unreachable) throw new TunnelUnavailable("unreachable");
    const v3 =
      this.resumeOn && options.protocols?.includes(TUNNEL_SUBPROTOCOL_V3);
    const pipe = new FaultPipe(v3 ? TUNNEL_SUBPROTOCOL_V3 : TUNNEL_SUBPROTOCOL);
    pipe.bytesPerSecond = this.bytesPerSecond;
    const previous = this.pipe;
    this.pipe = pipe;
    // The old socket is released: whatever it still carries is ignored.
    previous?.cut();
    const asked = options.resume;
    const session = this.session;
    if (
      v3 &&
      asked &&
      session?.version === 3 &&
      asked.connectionId === session.id &&
      !this.refuseNextResume &&
      session.log.refusal(asked.received) === undefined
    ) {
      const resend = session.log.resume(asked.received);
      const received = this.lieAboutReceived ?? session.acks.acknowledgeAll();
      this.lieAboutReceived = undefined;
      pipe.attach(this.endFor(pipe));
      for (const bytes of resend) pipe.toHost(bytes);
      return {
        ws: pipe.hostSocket,
        protocol: TUNNEL_SUBPROTOCOL_V3,
        connectionId: session.id,
        received: String(received),
      };
    }
    this.refuseNextResume = false;
    clearTimeout(session?.ackTimer);
    this.connections += 1;
    this.session = {
      id: `conn-${this.connections}`,
      version: v3 ? 3 : 2,
      log: new ReplayLog(64 * 1024 * 1024),
      acks: new AckSchedule(FAST_RESUME.ackBytes),
    };
    this.nextStreamId = 1;
    pipe.attach(this.endFor(pipe));
    return {
      ws: pipe.hostSocket,
      protocol: v3 ? TUNNEL_SUBPROTOCOL_V3 : TUNNEL_SUBPROTOCOL,
      connectionId: this.session.id,
    };
  }

  get connectionId(): string | undefined {
    return this.session?.id;
  }

  send(frame: Frame): void {
    const bytes = encodeFrame(frame);
    if (this.session?.version === 3) this.session.log.append(bytes);
    this.pipe?.toHost(bytes);
  }

  /** Send raw bytes, uncounted, as a hostile relay would. */
  sendRaw(bytes: Uint8Array): void {
    this.pipe?.toHost(bytes);
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
    this.send({
      type: "open",
      streamId,
      head: {
        method: options.method ?? "GET",
        target,
        headers: [
          ["host", "web--rig.r.org.o.amika.test"],
          ...(options.headers ?? []),
        ],
        upgrade: options.upgrade ?? false,
      },
    });
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

  /** Wait until `predicate` holds over the frames of `streamId`. */
  until(
    streamId: number,
    predicate: (frames: Frame[]) => boolean,
    timeoutMs = 10_000,
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

  /** The body of a plain response, once it ended. */
  async responseBody(streamId: number): Promise<Buffer> {
    const frames = await this.until(streamId, (list) =>
      list.some((f) => f.type === "end" || f.type === "reset"),
    );
    const reset = frames.find((f) => f.type === "reset");
    if (reset?.type === "reset") throw new Error(reset.reason);
    return Buffer.concat(
      frames.flatMap((f) => (f.type === "data" ? [Buffer.from(f.bytes)] : [])),
    );
  }

  /** The relay's end of `pipe`. A replaced pipe's messages are ignored. */
  private endFor(pipe: FaultPipe) {
    return {
      message: (data: Uint8Array | string) => {
        if (pipe !== this.pipe) return;
        if (typeof data === "string") {
          if (data === PING && this.answerPings) pipe.toHost(PONG);
          return;
        }
        this.fromHost(data);
      },
      // Every pipe's close is recorded: hostd can close a refused socket
      // after its next dial has already replaced it.
      closed: (code: number) => {
        this.closes.push(code);
        if (pipe === this.pipe) this.pipe = undefined;
      },
    };
  }

  private fromHost(bytes: Uint8Array): void {
    const session = this.session!;
    if (session.version === 2) {
      this.record(decodeFrame(bytes));
      return;
    }
    const frame = decodeFrameV3(bytes);
    if (frame.type === "ack") {
      session.log.acknowledge(frame.count);
      return;
    }
    this.record(frame);
    const due = session.acks.processed(bytes.byteLength);
    if (!this.acknowledge) return;
    if (due === "now") this.sendAck();
    else if (due === "arm") {
      session.ackTimer = setTimeout(() => this.sendAck(), 5);
    }
  }

  private sendAck(): void {
    const session = this.session!;
    clearTimeout(session.ackTimer);
    const count = session.acks.take();
    if (count !== undefined) this.pipe?.toHost(encodeAck(count));
  }

  private record(frame: Frame): void {
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
      window?.release(frame.bytes.byteLength);
      this.send({
        type: "window",
        streamId: frame.streamId,
        credit: frame.bytes.byteLength,
      });
    }
    for (const waiter of this.waiters) waiter();
  }
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

/** The daemon's side: its own server, a client, and the simulated relay. */
async function attach(
  options: {
    resume?: ResumeSettings | false;
    relay?: SimRelay;
    backoff?: BackoffOptions;
  } = {},
): Promise<{
  relay: SimRelay;
  client: TunnelClient;
  events: TunnelEvent[];
  upstreams: Set<Duplex>;
}> {
  const relay = options.relay ?? new SimRelay();
  const events: TunnelEvent[] = [];
  const upstreams = new Set<Duplex>();
  const wss = new WebSocketServer({ noServer: true });
  cleanups.push(() => wss.close());
  const server = virtualServer({
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/echo") {
        return new Response(await request.arrayBuffer());
      }
      if (url.pathname === "/bytes") {
        return new Response(pattern(Number(url.searchParams.get("n"))));
      }
      return new Response("not found", { status: 404 });
    },
    upgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      upstreams.add(socket);
      socket.on("close", () => upstreams.delete(socket));
      wss.handleUpgrade(request, socket, head, (ws) => {
        ws.on("message", (data, isBinary) =>
          ws.send(data, { binary: isBinary }),
        );
      });
    },
  });
  const client = new TunnelClient({
    target: () => ({
      gatewayUrl: "ws://127.0.0.1:1/v2/host-tunnel",
      hostId: "host_1",
      credential: "credential",
      generation: 1,
    }),
    handshakeTimeoutMs: 1_000,
    userAgent: "test",
    keepAliveIntervalMs: 60_000,
    pingTimeoutMs: 1_000,
    maxMissedPings: 2,
    drainMs: 200,
    onConnection: (socket) => server.accept(socket),
    resume:
      options.resume === false ? undefined : (options.resume ?? FAST_RESUME),
    backoff: options.backoff ?? {
      minDelayMs: 1,
      initialDelayMs: 5,
      maxDelayMs: 20,
      multiplier: 2,
      resetAfterMs: 60_000,
    },
    dial: async (_target, dialOptions) => relay.dial(dialOptions),
    onEvent: (event) => events.push(event),
  });
  cleanups.push(() => client.stop());
  client.start();
  await client.whenAttached(5_000);
  return { relay, client, events, upstreams };
}

/** A body whose every byte depends on its position, so a gap shows. */
function pattern(size: number, seed = 0): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = (index * 31 + seed + (index >> 8)) & 0xff;
  }
  return bytes;
}

function messagesOf(frames: Frame[]): string[] {
  return frames.flatMap((f) =>
    f.type === "message" && typeof f.data === "string" ? [f.data] : [],
  );
}

function ofType<T extends TunnelEvent["type"]>(
  events: TunnelEvent[],
  type: T,
): Array<Extract<TunnelEvent, { type: T }>> {
  return events.filter(
    (event): event is Extract<TunnelEvent, { type: T }> => event.type === type,
  );
}

async function upgraded(relay: SimRelay): Promise<number> {
  const id = relay.open("/ws", { upgrade: true });
  await relay.until(id, (list) => list.some((f) => f.type === "response"));
  return id;
}

describe("a v3 session across a dropped socket", () => {
  it("negotiates v3 and names the session", async () => {
    const { relay } = await attach();
    expect(relay.dials[0]?.protocols).toEqual([
      TUNNEL_SUBPROTOCOL_V3,
      TUNNEL_SUBPROTOCOL,
    ]);
    expect(relay.dials[0]?.resume).toBeUndefined();
  });

  it("carries a request and its response across a cut at every frame", async () => {
    const body = pattern(300 * 1024, 7);
    // A cut after the nth binary message, for n through a whole exchange.
    for (let cutAt = 1; cutAt <= 24; cutAt += 1) {
      const { relay, events } = await attach();
      const id = relay.open("/echo", {
        method: "POST",
        headers: [["content-length", String(body.byteLength)]],
      });
      relay.pipe!.cutAfter = cutAt;
      void relay.body(id, body);
      const echoed = await relay.responseBody(id);
      expect(echoed.equals(Buffer.from(body)), `cut at ${cutAt}`).toBe(true);
      expect(ofType(events, "tunnel_session_ended")).toEqual([]);
      await cleanups.pop()!();
    }
  });

  it("resumes on the session's id, with its received count", async () => {
    const { relay, events } = await attach();
    const id = relay.open("/bytes?n=10");
    relay.send({ type: "end", streamId: id });
    await relay.responseBody(id);
    const connectionId = relay.connectionId;
    relay.pipe!.cut();
    await expect.poll(() => ofType(events, "tunnel_resumed").length).toBe(1);
    const redial = relay.dials[1]!;
    expect(redial.resume?.connectionId).toBe(connectionId);
    // OPEN, END and the WINDOWs for a 10-byte response.
    expect(redial.resume?.received).toBeGreaterThanOrEqual(2);
    expect(ofType(events, "tunnel_detached")[0]).toMatchObject({
      connectionId,
      reason: "closed 1006",
    });
  });

  it("relays every WebSocket message both ways, once and in order, across many cuts", async () => {
    const { relay, events } = await attach();
    const id = await upgraded(relay);
    const sent: string[] = [];
    for (let index = 0; index < 300; index += 1) {
      const message = `m${index}:${"x".repeat(index % 50)}`;
      sent.push(message);
      relay.send({ type: "message", streamId: id, data: message });
      if (index % 37 === 0 && relay.pipe) relay.pipe.cutAfter = 1 + (index % 5);
      if (index % 10 === 0) await new Promise((r) => setTimeout(r, 2));
    }
    const frames = await relay.until(
      id,
      (list) => messagesOf(list).length >= sent.length,
    );
    expect(messagesOf(frames)).toEqual(sent);
    expect(ofType(events, "tunnel_resumed").length).toBeGreaterThan(0);
    expect(ofType(events, "tunnel_session_ended")).toEqual([]);
  });

  it("finds a silent socket by its ping, and resumes", async () => {
    const { relay, events } = await attach();
    const id = await upgraded(relay);
    relay.pipe!.silent = true;
    relay.send({ type: "message", streamId: id, data: "lost in the break" });
    await expect.poll(() => ofType(events, "tunnel_resumed").length).toBe(1);
    expect(ofType(events, "tunnel_detached")[0]?.reason).toBe("missed ping");
    const frames = await relay.until(id, (list) => messagesOf(list).length > 0);
    expect(messagesOf(frames)).toEqual(["lost in the break"]);
  });

  it("pauses producers while detached, and lets them go on a resume", async () => {
    const { relay, client } = await attach();
    relay.unreachable = true;
    relay.pipe!.cut();
    const session = (client as unknown as { session: TunnelSessionView })
      .session;
    await expect.poll(() => session.isDetached).toBe(true);
    expect(session.congested()).toBe(true);
    let writable = false;
    void session.writable().then(() => (writable = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(writable).toBe(false);
    relay.unreachable = false;
    await expect.poll(() => writable).toBe(true);
    expect(session.congested()).toBe(false);
  });
});

interface TunnelSessionView {
  isDetached: boolean;
  congested(): boolean;
  writable(): Promise<void>;
}

describe("a busy session on a slow link", () => {
  /**
   * The production limits, with times scaled down. The ping timeout must
   * be well above the time one whole frame takes to cross: 64 KiB at
   * 2 MiB/s is 32 ms. In production it is 5 s.
   */
  const SLOW_LINK: ResumeSettings = {
    ...DEFAULT_RESUME,
    keepAliveIntervalMs: 120,
    pingTimeoutMs: 100,
    graceMs: 1_000,
    ackDelayMs: 5,
  };

  /** An upload echoed back and a download, at the same time. */
  async function bulk(relay: SimRelay, size: number): Promise<void> {
    const body = pattern(size, 3);
    const echo = relay.open("/echo", {
      method: "POST",
      headers: [["content-length", String(size)]],
    });
    void relay.body(echo, body);
    const download = relay.open(`/bytes?n=${size}`);
    relay.send({ type: "end", streamId: download });
    const [echoed, downloaded] = await Promise.all([
      relay.responseBody(echo),
      relay.responseBody(download),
    ]);
    expect(echoed.equals(Buffer.from(body))).toBe(true);
    expect(downloaded.equals(Buffer.from(pattern(size)))).toBe(true);
  }

  it("keeps its socket while pings wait behind data", async () => {
    const relay = new SimRelay();
    relay.bytesPerSecond = 2 * 1024 * 1024;
    const { events } = await attach({ relay, resume: SLOW_LINK });
    await bulk(relay, 3 * 1024 * 1024);
    expect(ofType(events, "tunnel_detached")).toEqual([]);
    expect(relay.dials).toHaveLength(1);
  });

  it("resumes once after a cut, and the resumed socket sticks", async () => {
    const relay = new SimRelay();
    relay.bytesPerSecond = 2 * 1024 * 1024;
    const { events } = await attach({ relay, resume: SLOW_LINK });
    const transfer = bulk(relay, 3 * 1024 * 1024);
    await new Promise((resolve) => setTimeout(resolve, 200));
    relay.pipe!.cut();
    await transfer;
    expect(ofType(events, "tunnel_detached")).toHaveLength(1);
    expect(ofType(events, "tunnel_resumed")).toHaveLength(1);
    expect(ofType(events, "tunnel_session_ended")).toEqual([]);
  });
});

describe("a real socket", () => {
  it("serves a frame that arrives in the same read as the 101", async () => {
    // A relay that resumes, or wakes a waiting request, sends frames just
    // before its `101`, and the network can deliver both in one read.
    const sockets = new Set<Duplex>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("data", (request) => {
        const key = /sec-websocket-key: (.*)\r\n/i.exec(
          request.toString(),
        )![1]!;
        const accept = createHash("sha1")
          .update(`${key.trim()}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest("base64");
        const open = Buffer.from(
          encodeFrame({
            type: "open",
            streamId: 1,
            head: {
              method: "GET",
              target: "/",
              headers: [["host", "rig.test"]],
              upgrade: false,
            },
          }),
        );
        socket.write(
          Buffer.concat([
            Buffer.from(
              "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
                `Sec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ${TUNNEL_SUBPROTOCOL_V3}\r\n` +
                "x-amika-connection-id: conn-1\r\n\r\n",
            ),
            Buffer.from([0x82, 126, open.length >> 8, open.length & 0xff]),
            open,
          ]),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    let served = 0;
    const client = new TunnelClient({
      target: () => ({
        gatewayUrl: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v2/host-tunnel`,
        hostId: "host_1",
        credential: "credential",
        generation: 1,
      }),
      handshakeTimeoutMs: 2_000,
      userAgent: "test",
      keepAliveIntervalMs: 60_000,
      pingTimeoutMs: 60_000,
      maxMissedPings: 2,
      drainMs: 10,
      onConnection: (socket) => {
        served += 1;
        socket.destroy();
      },
      resume: {
        ...FAST_RESUME,
        keepAliveIntervalMs: 60_000,
        pingTimeoutMs: 60_000,
      },
    });
    client.start();
    cleanups.push(() => client.stop());
    // First, so the stop does not wait out a close nobody answers.
    cleanups.push(() => {
      for (const socket of sockets) socket.destroy();
    });
    await expect.poll(() => served).toBe(1);
  });
});

describe("when the session cannot go on", () => {
  it("starts fresh and resets every stream when the relay does not resume", async () => {
    const { relay, events, upstreams } = await attach();
    await upgraded(relay);
    expect(upstreams.size).toBe(1);
    relay.refuseNextResume = true;
    relay.pipe!.cut();
    await expect.poll(() => upstreams.size).toBe(0);
    expect(ofType(events, "tunnel_resume_refused")[0]?.reason).toBe(
      "refused_by_relay",
    );
    expect(ofType(events, "tunnel_session_ended")[0]?.reason).toBe(
      "fresh_attach",
    );
    // The fresh session serves.
    const id = relay.open("/bytes?n=5");
    relay.send({ type: "end", streamId: id });
    expect((await relay.responseBody(id)).byteLength).toBe(5);
  });

  it("resets every stream when the grace ends with no resume", async () => {
    const { relay, events, upstreams } = await attach({
      resume: { ...FAST_RESUME, graceMs: 100 },
    });
    await upgraded(relay);
    relay.unreachable = true;
    relay.pipe!.cut();
    await expect.poll(() => upstreams.size).toBe(0);
    expect(ofType(events, "tunnel_session_ended")[0]?.reason).toBe("grace");
    // The next attach is fresh: there is no session left to offer.
    relay.unreachable = false;
    await expect.poll(() => relay.pipe !== undefined).toBe(true);
    expect(relay.dials.at(-1)?.resume).toBeUndefined();
  });

  it("keeps each wait while detached well inside the grace", async () => {
    // The production schedule: windows of 2 s, 4 s, 8 s and more.
    const graceMs = 3_000;
    const { relay, events } = await attach({
      resume: { ...FAST_RESUME, graceMs },
      backoff: { ...DEFAULT_BACKOFF, random: () => 1 },
    });
    relay.unreachable = true;
    relay.pipe!.cut();
    await expect
      .poll(() => ofType(events, "waiting").length, { timeout: 5_000 })
      .toBeGreaterThan(3);
    for (const wait of ofType(events, "waiting")) {
      expect(wait.delayMs).toBe(graceMs / 6);
    }
    relay.unreachable = false;
  });

  it("ends the session on an ACK of a frame it never sent", async () => {
    const { relay, events } = await attach();
    relay.sendRaw(encodeAck(1_000_000));
    await expect
      .poll(() => ofType(events, "tunnel_session_ended")[0]?.reason)
      .toBe("protocol_error");
    await expect.poll(() => relay.closes).toContain(1002);
  });

  it("closes 1002 and dials fresh when the relay's count is above what it sent", async () => {
    const { relay, events } = await attach();
    await upgraded(relay);
    relay.lieAboutReceived = 10_000;
    relay.pipe!.cut();
    await expect
      .poll(() => ofType(events, "tunnel_resume_refused")[0]?.reason)
      .toBe("count_mismatch");
    await expect.poll(() => relay.closes).toContain(1002);
    // A fresh dial follows, with no resume headers.
    await expect
      .poll(() => relay.dials.filter((dial) => !dial.resume).length)
      .toBe(2);
  });

  it("refuses to resume from a frame its log dropped past its limit", async () => {
    const { relay, events } = await attach({
      resume: { ...FAST_RESUME, maxReplayBytes: 64 * 1024 },
    });
    relay.acknowledge = false;
    const id = relay.open("/bytes?n=300000");
    relay.send({ type: "end", streamId: id });
    await relay.responseBody(id);
    // The relay never acknowledged; it tells the truth about what it got,
    // and that is before the frames hostd has dropped.
    relay.lieAboutReceived = 0;
    relay.pipe!.cut();
    await expect
      .poll(() => ofType(events, "tunnel_resume_refused")[0]?.reason)
      .toBe("log_truncated");
  });

  it("ends the session at once when hostd shuts down", async () => {
    const { relay, client, events } = await attach();
    await client.stop();
    expect(relay.closes).toEqual([CLOSE_SESSION_ENDED]);
    expect(ofType(events, "tunnel_session_ended")[0]?.reason).toBe("stopped");
  });
});

describe("with resume off, or a relay that does not resume", () => {
  it("offers v2 alone and sends no resume headers", async () => {
    const { relay, upstreams } = await attach({ resume: false });
    expect(relay.dials[0]?.protocols).toEqual([TUNNEL_SUBPROTOCOL]);
    await upgraded(relay);
    relay.pipe!.cut();
    // v2: a dropped socket ends every stream, as before.
    await expect.poll(() => upstreams.size).toBe(0);
    await expect.poll(() => relay.dials.length).toBe(2);
    expect(relay.dials[1]?.resume).toBeUndefined();
  });

  it("speaks v2 to a relay that selects it", async () => {
    const relay = new SimRelay();
    relay.resumeOn = false;
    const { events, upstreams } = await attach({ relay });
    const id = relay.open("/bytes?n=1000");
    relay.send({ type: "end", streamId: id });
    expect((await relay.responseBody(id)).byteLength).toBe(1000);
    await upgraded(relay);
    relay.pipe!.cut();
    await expect.poll(() => upstreams.size).toBe(0);
    await expect.poll(() => relay.dials.length).toBe(2);
    expect(relay.dials[1]?.resume).toBeUndefined();
    expect(ofType(events, "tunnel_detached")).toEqual([]);
  });
});
