/** Cover service-route auth, parsing, and the upgrade tunnel over real sockets. */
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
import { memoryServiceRegistry } from "./service-registry.js";
import {
  authorizeServiceRequest,
  createUpgradeHandler,
  freeLoopbackPort,
  parseServicePath,
} from "./services.js";
import { SmolRuntime } from "./smol.js";

const SECRET = "0123456789abcdef0123456789abcdef";

describe("parseServicePath", () => {
  it("splits the route and keeps the encoded guest path", () => {
    expect(
      parseServicePath("/v0beta1/rigs/demo-1/services/pi_web/v1/a%2Fb"),
    ).toEqual({
      machine: "demo-1",
      service: "pi_web",
      path: "/v1/a%2Fb",
    });
    expect(parseServicePath("/v0beta1/rigs/demo/services/web")?.path).toBe("/");
    // Amika service names are free text, carried percent-encoded.
    expect(
      parseServicePath("/v0beta1/rigs/demo/services/Coding%20Agent%2Fv2/x"),
    ).toEqual({ machine: "demo", service: "Coding Agent/v2", path: "/x" });
    expect(parseServicePath("/v0beta1/rigs/demo/services/web/")?.path).toBe(
      "/",
    );
  });

  it.each([
    "/api/v1/machines/demo",
    "/v0beta1/rigs/demo",
    "/v0beta1/rigs/demo/services",
    "/v0beta1/rigs/demo/services/",
    "/v0beta1/rigs/-demo/services/web",
    "/v0beta1/rigs/de.mo/services/web",
    "/v0beta1/rigs/demo/services/%E0%A4%A",
    "/v0beta1/rigs/demo/other/web",
  ])("rejects %s", (path) => {
    expect(parseServicePath(path)).toBeNull();
  });
});

describe("authorizeServiceRequest", () => {
  it("accepts the key in its header, trimmed, and leaves Authorization to the guest", () => {
    expect(authorizeServiceRequest(SECRET, { key: SECRET })).toBeNull();
    expect(authorizeServiceRequest(SECRET, { key: ` ${SECRET} ` })).toBeNull();
    expect(
      authorizeServiceRequest(SECRET, {
        key: SECRET,
        authorization: "Bearer connect-token",
      }),
    ).toBeNull();
  });

  it.each([
    ["no key", {}],
    ["an empty key", { key: "" }],
    ["a prefix of the key", { key: SECRET.slice(0, -1) }],
    ["the key repeated", { key: [SECRET, SECRET] }],
    ["the key only in Authorization", { authorization: `Bearer ${SECRET}` }],
  ])("refuses %s with 401", (_label, headers) => {
    expect(authorizeServiceRequest(SECRET, headers)).toBe(401);
  });

  it.each([`Bearer ${SECRET}`, `bearer  ${SECRET}`, SECRET])(
    "refuses to pass the key on as the guest's Authorization (%s)",
    (authorization) => {
      expect(
        authorizeServiceRequest(SECRET, { key: SECRET, authorization }),
      ).toBe(400);
    },
  );
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

  async function hostd(
    hostPort: number | null,
    {
      services = { amikad: 60999 } as Record<string, number>,
      state = "running",
    } = {},
  ) {
    const runtime = new SmolRuntime(
      { apiUrl: "http://runtime:8080" },
      vi.fn<typeof fetch>(async () =>
        Response.json({
          name: "demo",
          state,
          ports:
            hostPort === null
              ? []
              : Object.values(services).map((guest) => ({
                  host: hostPort,
                  guest,
                })),
        }),
      ),
    );
    const tunnels = new Set<Duplex>();
    const server = createHttpServer();
    server.on(
      "upgrade",
      createUpgradeHandler(SECRET, runtime, registry(services), tunnels),
    );
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

  function registry(services: Record<string, number> = { amikad: 60999 }) {
    const registry = memoryServiceRegistry();
    registry.set("demo", services);
    return registry;
  }

  async function open(
    port: number,
    path: string,
    {
      key = SECRET,
      authorization = "Bearer connect-token",
      method = "GET",
      upgrade = "websocket",
    } = {},
  ): Promise<Socket> {
    const socket = connect(port, "127.0.0.1");
    closers.push(() => socket.destroy());
    await once(socket, "connect");
    const keyLine = key ? `X-Amika-Hostd-Key: ${key}\r\n` : "";
    socket.write(
      `${method} ${path} HTTP/1.1\r\nHost: hostd.example\r\nConnection: Upgrade\r\nUpgrade: ${upgrade}\r\n${keyLine}Authorization: ${authorization}\r\n\r\n`,
    );
    return socket;
  }

  function read(socket: Socket): Promise<string> {
    return once(socket, "data").then(([chunk]) => String(chunk));
  }

  const validPath = (suffix = "/v1/ssh-sessions?x=1") =>
    `/v0beta1/rigs/demo/services/amikad${suffix}`;

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

  it.each([
    ["no key", { key: "" }, 401],
    ["a wrong key", { key: `not-${SECRET}` }, 401],
    ["the key as Authorization", { authorization: `Bearer ${SECRET}` }, 400],
  ])(
    "refuses %s without reaching the guest",
    async (_label, headers, status) => {
      const target = await guest();
      const { port } = await hostd(target.port);
      const socket = await open(port, validPath(), headers);
      expect(await read(socket)).toMatch(new RegExp(`^HTTP/1\\.1 ${status} `));
      expect(target.handshake()).toBe("");
    },
  );

  describe("amikad's SSH upgrade without the key", () => {
    const sshPath = validPath("/v1/ssh-sessions");

    it("tunnels it with the caller's connect token", async () => {
      const target = await guest();
      const { port } = await hostd(target.port);
      const socket = await open(port, sshPath, { key: "" });
      expect(await read(socket)).toBe(
        "HTTP/1.1 101 Switching Protocols\r\n\r\n",
      );
      expect(target.handshake()).toBe(
        "GET /v1/ssh-sessions HTTP/1.1\r\nHost: hostd.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nAuthorization: Bearer connect-token\r\n\r\n",
      );
    });

    it.each([
      ["a query", validPath("/v1/ssh-sessions?x=1"), {}],
      ["another amikad path", validPath("/v1/status"), {}],
      ["a trailing slash", validPath("/v1/ssh-sessions/"), {}],
      ["an encoded path", validPath("/v1/ssh%2Dsessions"), {}],
      [
        "an encoded service name",
        "/v0beta1/rigs/demo/services/amik%61d/v1/ssh-sessions",
        {},
      ],
      [
        "another service",
        "/v0beta1/rigs/demo/services/web/v1/ssh-sessions",
        {},
      ],
      ["another method", sshPath, { method: "POST" }],
      ["another protocol", sshPath, { upgrade: "h2c" }],
    ])("still requires the key with %s", async (_label, path, headers) => {
      const target = await guest();
      const { port } = await hostd(target.port, {
        services: { amikad: 60999, web: 8080 },
      });
      const socket = await open(port, path, { key: "", ...headers });
      expect(await read(socket)).toMatch(/^HTTP\/1\.1 401 /);
      expect(target.handshake()).toBe("");
    });

    it("refuses the key passed on as Authorization", async () => {
      const target = await guest();
      const { port } = await hostd(target.port);
      const socket = await open(port, sshPath, {
        key: "",
        authorization: `Bearer ${SECRET}`,
      });
      expect(await read(socket)).toMatch(/^HTTP\/1\.1 400 /);
      expect(target.handshake()).toBe("");
    });

    it.each([
      ["amikad registered on another port", { services: { amikad: 2222 } }],
      ["a stopped rig", { state: "stopped" }],
    ])("refuses %s", async (_label, options) => {
      const target = await guest();
      const { port } = await hostd(target.port, options);
      const socket = await open(port, sshPath, { key: "" });
      expect(await read(socket)).toMatch(/^HTTP\/1\.1 404 /);
      expect(target.handshake()).toBe("");
    });
  });

  it("routes a keyed SSH upgrade to amikad on any registered port", async () => {
    // The port check constrains only the keyless exception.
    const target = await guest();
    const { port } = await hostd(target.port, {
      services: { amikad: 2222 },
    });
    const socket = await open(port, validPath("/v1/ssh-sessions"));
    expect(await read(socket)).toBe("HTTP/1.1 101 Switching Protocols\r\n\r\n");
  });

  it("refuses an unknown service without reaching the guest", async () => {
    const target = await guest();
    const { port } = await hostd(target.port);
    const socket = await open(port, "/v0beta1/rigs/demo/services/web/");
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
    server.on(
      "upgrade",
      createUpgradeHandler(SECRET, runtime, registry(), tunnels, dial),
    );
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
