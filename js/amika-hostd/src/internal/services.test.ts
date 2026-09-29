/** Cover service-route tokens and the upgrade tunnel over real sockets. */
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import {
  connect,
  createServer,
  type AddressInfo,
  type Server,
  type Socket,
} from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createUpgradeHandler,
  freeLoopbackPort,
  parseServicePath,
  signServiceToken,
  verifyServiceToken,
} from "./services.js";
import { SmolRuntime } from "./smol.js";

const SECRET = "0123456789abcdef0123456789abcdef";
const NOW = 1_800_000_000;

describe("parseServicePath", () => {
  it("splits the route and keeps the encoded guest path", () => {
    expect(parseServicePath("/services/demo-1/60999/tok/v1/a%2Fb")).toEqual({
      machine: "demo-1",
      port: 60999,
      token: "tok",
      path: "/v1/a%2Fb",
    });
    expect(parseServicePath("/services/demo/80/tok")?.path).toBe("/");
    expect(parseServicePath("/services/demo/80/tok/")?.path).toBe("/");
  });

  it.each([
    "/api/v1/machines/demo",
    "/services/demo/80",
    "/services/demo/80/",
    "/services/-demo/80/tok",
    "/services/de.mo/80/tok",
    "/services/demo/0/tok",
    "/services/demo/080/tok",
    "/services/demo/65536/tok",
  ])("rejects %s", (path) => {
    expect(parseServicePath(path)).toBeNull();
  });
});

describe("service tokens", () => {
  const CREATED_AT = NOW - 3600;
  const token = signServiceToken(SECRET, {
    machine: "demo",
    createdAt: CREATED_AT,
    port: 60999,
    expiresAt: NOW + 60,
  });
  const route = { machine: "demo", port: 60999, token };

  it("verifies only the machine port it was signed for, until expiry", () => {
    expect(verifyServiceToken(SECRET, route, NOW)).toEqual({
      createdAt: CREATED_AT,
    });
    expect(verifyServiceToken(SECRET, route, NOW + 60)).toBeNull();
    expect(verifyServiceToken(SECRET, { ...route, port: 22 }, NOW)).toBeNull();
    expect(
      verifyServiceToken(SECRET, { ...route, machine: "x" }, NOW),
    ).toBeNull();
    expect(verifyServiceToken(`${SECRET}x`, route, NOW)).toBeNull();
  });

  it.each([
    [
      "expiry",
      (exp: string, created: string) => `${Number(exp) + 6000}.${created}`,
    ],
    [
      "incarnation",
      (exp: string, created: string) => `${exp}.${Number(created) + 1}`,
    ],
  ])("rejects an %s edited after signing", (_label, edit) => {
    const [exp, created, mac] = token.split(".");
    const edited = { ...route, token: `${edit(exp, created)}.${mac}` };
    expect(verifyServiceToken(SECRET, edited, NOW)).toBeNull();
  });

  it("rejects a v1-shaped token", () => {
    const [exp, , mac] = token.split(".");
    expect(
      verifyServiceToken(SECRET, { ...route, token: `${exp}.${mac}` }, NOW),
    ).toBeNull();
  });

  it.each([
    "",
    "abc",
    `${NOW}.${CREATED_AT}.`,
    `0.${CREATED_AT}.${"a".repeat(43)}`,
    `${NOW}.0.${"a".repeat(43)}`,
    `${NOW}.${CREATED_AT}.${"a".repeat(44)}`,
  ])("rejects malformed token %j", (bad) => {
    expect(
      verifyServiceToken(SECRET, { ...route, token: bad }, NOW),
    ).toBeNull();
  });
});

describe("freeLoopbackPort", () => {
  it("returns a port that can be bound on loopback", async () => {
    const port = await freeLoopbackPort();
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(port, "127.0.0.1", resolve),
    );
    await new Promise((resolve) => server.close(resolve));
  });
});

describe("createUpgradeHandler", () => {
  const closers: (() => void)[] = [];
  afterEach(() => {
    for (const close of closers.splice(0)) close();
  });

  /** A guest that records the handshake, accepts it, then echoes. */
  async function guest() {
    let handshake = "";
    const server = createServer((socket) => {
      socket.once("data", (chunk) => {
        handshake = chunk.toString();
        socket.write("HTTP/1.1 101 Switching Protocols\r\n\r\n");
        socket.pipe(socket);
      });
    });
    return {
      port: await listen(server),
      handshake: () => handshake,
    };
  }

  async function hostd(hostPort: number | null) {
    const runtime = new SmolRuntime(
      { apiUrl: "http://runtime:8080" },
      vi.fn<typeof fetch>(async () =>
        Response.json({
          name: "demo",
          state: "running",
          createdAt: 1_790_000_000,
          ports: hostPort === null ? [] : [{ host: hostPort, guest: 60999 }],
        }),
      ),
    );
    const tunnels = new Set<Duplex>();
    const server = createHttpServer();
    server.on("upgrade", createUpgradeHandler(SECRET, runtime, tunnels));
    return { port: await listen(server), tunnels };
  }

  function listen(server: Server | ReturnType<typeof createHttpServer>) {
    closers.push(() => {
      if ("closeAllConnections" in server) server.closeAllConnections();
      server.close();
    });
    return new Promise<number>((resolve) =>
      server.listen(0, "127.0.0.1", () =>
        resolve((server.address() as AddressInfo).port),
      ),
    );
  }

  async function open(port: number, path: string): Promise<Socket> {
    const socket = connect(port, "127.0.0.1");
    closers.push(() => socket.destroy());
    await once(socket, "connect");
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: hostd.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nAuthorization: Bearer connect-token\r\n\r\n`,
    );
    return socket;
  }

  function read(socket: Socket): Promise<string> {
    return once(socket, "data").then(([chunk]) => String(chunk));
  }

  const validPath = (suffix = "/v1/ssh-sessions?x=1") =>
    `/services/demo/60999/${signServiceToken(SECRET, { machine: "demo", createdAt: 1_790_000_000, port: 60999, expiresAt: Math.floor(Date.now() / 1000) + 60 })}${suffix}`;

  it("tunnels the handshake and bytes to the guest port", async () => {
    const target = await guest();
    const { port, tunnels } = await hostd(target.port);
    const socket = await open(port, validPath());
    expect(await read(socket)).toBe("HTTP/1.1 101 Switching Protocols\r\n\r\n");
    expect(target.handshake()).toBe(
      "GET /v1/ssh-sessions?x=1 HTTP/1.1\r\nHost: hostd.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nAuthorization: Bearer connect-token\r\n\r\n",
    );
    expect(tunnels.size).toBe(1);
    socket.write("ssh bytes");
    expect(await read(socket)).toBe("ssh bytes");
    socket.destroy();
    await vi.waitFor(() => expect(tunnels.size).toBe(0));
  });

  it("refuses a bad token without reaching the guest", async () => {
    const target = await guest();
    const { port } = await hostd(target.port);
    const socket = await open(port, validPath().replace("/60999/", "/3000/"));
    expect(await read(socket)).toMatch(/^HTTP\/1\.1 404 /);
    expect(target.handshake()).toBe("");
  });

  it("refuses a port the machine did not publish", async () => {
    const { port } = await hostd(null);
    const socket = await open(port, validPath());
    expect(await read(socket)).toMatch(/^HTTP\/1\.1 404 /);
  });

  it("ends an upgrade that shutdown catches before it connects", async () => {
    let release = () => {};
    const lookup = new Promise<void>((resolve) => (release = resolve));
    let resolved = () => {};
    const lookupDone = new Promise<void>((resolve) => (resolved = resolve));
    const runtime = new SmolRuntime({ apiUrl: "http://runtime:8080" });
    // Signals once the handler has the port, so the dial assertion below
    // runs only after the handler could have dialed.
    vi.spyOn(runtime, "request").mockImplementation(async () => {
      await lookup;
      const machine = {
        name: "demo",
        state: "running",
        ports: [{ host: 1, guest: 60999 }],
      };
      return {
        ok: true,
        json: async () => {
          resolved();
          return machine;
        },
      } as unknown as Response;
    });
    const tunnels = new Set<Duplex>();
    const dial = vi.fn<(port: number) => Socket>();
    const server = createHttpServer();
    server.on("upgrade", createUpgradeHandler(SECRET, runtime, tunnels, dial));
    const socket = await open(await listen(server), validPath());
    await vi.waitFor(() => expect(tunnels.size).toBe(1));
    for (const tunnel of tunnels) tunnel.destroy();
    release();
    await once(socket, "close");
    await vi.waitFor(() => expect(tunnels.size).toBe(0));
    await lookupDone;
    await new Promise((resolve) => setImmediate(resolve));
    expect(dial).not.toHaveBeenCalled();
  });

  it("answers 502 when the guest port is closed", async () => {
    const closed = await freeLoopbackPort();
    const { port } = await hostd(closed);
    const socket = await open(port, validPath());
    expect(await read(socket)).toMatch(/^HTTP\/1\.1 502 /);
  });
});
