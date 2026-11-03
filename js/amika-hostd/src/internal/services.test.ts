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
import { signServiceToken, signSession } from "@amika/service-auth/credentials";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryServiceRegistry } from "./service-registry.js";
import { createUpgradeHandler, resolveHostPort } from "./services.js";
import type { MachineRuntime } from "./machine-runtime.js";

const SECRET = "0123456789abcdef0123456789abcdef";

/** A runtime that reports host ports through `hostPort`; nothing else is called. */
function runtimeWith(hostPort: MachineRuntime["hostPort"]): MachineRuntime {
  const unexpected = async () => {
    throw new Error("unexpected runtime call");
  };
  return {
    list: unexpected,
    get: unexpected,
    create: unexpected,
    start: unexpected,
    stop: unexpected,
    remove: unexpected,
    exec: unexpected,
    readFile: unexpected,
    writeFile: unexpected,
    publishServices: unexpected,
    hostPort,
  };
}

/** A loopback port nothing listens on: bound, then released. */
function closedLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

describe("resolveHostPort", () => {
  const route = { machine: "demo", service: "web" };
  function registry() {
    const registry = memoryServiceRegistry();
    registry.set("demo", { web: 3000 });
    return registry;
  }

  it("asks the runtime for the registered guest port's host port", async () => {
    const hostPort = vi.fn(
      async (_name: string, _guestPort: number): Promise<number | null> =>
        41001,
    );
    expect(
      await resolveHostPort(runtimeWith(hostPort), registry(), route),
    ).toBe(41001);
    expect(hostPort).toHaveBeenCalledWith("demo", 3000);
  });

  it("passes on the runtime's null for a port it cannot reach", async () => {
    const runtime = runtimeWith(async () => null);
    expect(await resolveHostPort(runtime, registry(), route)).toBeNull();
  });

  it("asks the runtime nothing for an unregistered service", async () => {
    const hostPort = vi.fn(async () => 41001);
    expect(
      await resolveHostPort(runtimeWith(hostPort), registry(), {
        ...route,
        service: "nope",
      }),
    ).toBeNull();
    expect(hostPort).not.toHaveBeenCalled();
  });

  it("lets an unexpected error through", async () => {
    const runtime = runtimeWith(async () => {
      throw new TypeError("bug");
    });
    await expect(resolveHostPort(runtime, registry(), route)).rejects.toThrow(
      "bug",
    );
  });
});

describe("createUpgradeHandler", () => {
  const closers: (() => void)[] = [];
  afterEach(() => {
    for (const close of closers.splice(0)) close();
  });

  /** A guest that records the handshake, accepts it, then echoes. */
  async function guest(answer = "HTTP/1.1 101 Switching Protocols\r\n\r\n") {
    let handshake = "";
    const server = createServer((socket) => {
      socket.once("data", (chunk) => {
        handshake = chunk.toString();
        socket.write(answer);
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
      previews = false,
    } = {},
  ) {
    // As the real runtime does: a host port only for a running machine's
    // published guest port. Every registered port is published here.
    const published = new Set(Object.values(services));
    const runtime = runtimeWith(async (_name, guestPort) =>
      state === "running" && published.has(guestPort) ? hostPort : null,
    );
    const tunnels = new Set<Duplex>();
    const server = createHttpServer();
    server.on(
      "upgrade",
      createUpgradeHandler(
        SECRET,
        runtime,
        registry(services),
        tunnels,
        undefined,
        previews ? { amikaUrl: "https://app.amika.test" } : {},
      ),
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
      cookie = "",
      fetchSite = "same-origin",
      token = "",
      origin = "",
    } = {},
  ): Promise<Socket> {
    const socket = connect(port, "127.0.0.1");
    closers.push(() => socket.destroy());
    await once(socket, "connect");
    const keyLine =
      (key ? `X-Amika-Hostd-Key: ${key}\r\n` : "") +
      (token ? `X-Amika-Authorization: Bearer ${token}\r\n` : "");
    const cookieLine =
      (cookie ? `Cookie: ${cookie}\r\nSec-Fetch-Site: ${fetchSite}\r\n` : "") +
      (origin ? `Origin: ${origin}\r\n` : "");
    socket.write(
      `${method} ${path} HTTP/1.1\r\nHost: hostd.example\r\nConnection: Upgrade\r\nUpgrade: ${upgrade}\r\n${keyLine}${cookieLine}Authorization: ${authorization}\r\n\r\n`,
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

  it("keeps the guest's answer from setting the gateway's cookies", async () => {
    const target = await guest(
      "HTTP/1.1 101 Switching Protocols\r\nSet-Cookie: theme=dark\r\n" +
        "Set-Cookie: __Host-amika-session=forged; Path=/\r\n\r\nfirst frame",
    );
    const { port } = await hostd(target.port);
    const socket = await open(port, validPath());
    let answer = "";
    socket.on("data", (chunk) => (answer += chunk));
    await vi.waitFor(() =>
      expect(answer).toBe(
        "HTTP/1.1 101 Switching Protocols\r\nSet-Cookie: theme=dark\r\n\r\nfirst frame",
      ),
    );
    socket.write("more bytes");
    await vi.waitFor(() => expect(answer).toMatch(/more bytes$/));
  });

  it.each([
    ["never finishes", ""],
    ["finishes too late", "\r\n\r\n"],
  ])("ends a tunnel whose guest's answer %s", async (_label, end) => {
    const target = await guest(
      `HTTP/1.1 101 Switching Protocols\r\nX-Pad: ${"a".repeat(70_000)}${end}`,
    );
    const { port } = await hostd(target.port);
    const socket = await open(port, validPath());
    let answer = "";
    socket.on("data", (chunk) => (answer += chunk));
    await once(socket, "close");
    expect(answer).toBe("");
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

  it.each([
    [
      "a retired service link",
      "/v0beta1/rigs/demo/service-links/web/1.sig/hmr",
      "",
    ],
    [
      "a retired link cookie",
      "/_next/webpack-hmr",
      "__Host-amika-service-link=demo/web/1.sig",
    ],
  ])("refuses %s without reaching the guest", async (_label, path, cookie) => {
    const target = await guest();
    const { port } = await hostd(target.port, { services: { web: 5173 } });
    const socket = await open(port, path, { key: "", cookie });
    expect(await read(socket)).toMatch(/^HTTP\/1\.1 401 /);
    expect(target.handshake()).toBe("");
  });

  describe("with a service token", () => {
    const tokenFor = (service: string) =>
      signServiceToken(SECRET, { rig: "demo", service });

    it("tunnels it with no key, keeping the token off the guest", async () => {
      const target = await guest();
      const { port } = await hostd(target.port, { services: { web: 5173 } });
      const socket = await open(port, "/v0beta1/rigs/demo/services/web/hmr", {
        key: "",
        token: await tokenFor("web"),
      });
      expect(await read(socket)).toBe(
        "HTTP/1.1 101 Switching Protocols\r\n\r\n",
      );
      expect(target.handshake()).toMatch(/^GET \/hmr HTTP\/1\.1\r\n/);
      expect(target.handshake()).not.toMatch(/x-amika-authorization/i);
    });

    it.each([
      ["another service's token", "web", "api"],
      ["a token for amikad", "amikad", "amikad"],
    ])(
      "refuses %s without reaching the guest",
      async (_label, service, signedFor) => {
        const target = await guest();
        const { port } = await hostd(target.port, {
          services: { web: 5173, api: 8080, amikad: 60999 },
        });
        const socket = await open(
          port,
          `/v0beta1/rigs/demo/services/${service}/v1/other`,
          { key: "", token: await tokenFor(signedFor) },
        );
        expect(await read(socket)).toMatch(/^HTTP\/1\.1 401 /);
        expect(target.handshake()).toBe("");
      },
    );
  });

  describe("through a preview", () => {
    // `open` reaches hostd as `hostd.example`.
    const ORIGIN = "https://hostd.example";
    const session = async (origin = ORIGIN) =>
      `__Host-amika-session=${await signSession(SECRET, { origin, user: "u" })}`;

    it("tunnels it with a session, without hostd's cookies", async () => {
      const target = await guest();
      const { port } = await hostd(target.port, {
        services: { web: 5173 },
        previews: true,
      });
      const socket = await open(port, "/v0beta1/rigs/demo/previews/web/hmr", {
        key: "",
        cookie: `${await session()}; theme=dark`,
        origin: ORIGIN,
      });
      expect(await read(socket)).toBe(
        "HTTP/1.1 101 Switching Protocols\r\n\r\n",
      );
      expect(target.handshake()).toMatch(/^GET \/hmr HTTP\/1\.1\r\n/);
      expect(target.handshake()).toMatch(/\r\nCookie: theme=dark\r\n/);
      expect(target.handshake()).not.toMatch(/__Host-amika/);
    });

    it("tunnels a root-relative upgrade to the page's preview", async () => {
      const target = await guest();
      const { port } = await hostd(target.port, {
        services: { web: 5173 },
        previews: true,
      });
      const socket = await open(port, "/?token=hmr", {
        key: "",
        cookie: `${await session()}; __Host-amika-preview=demo/web`,
        origin: ORIGIN,
      });
      expect(await read(socket)).toBe(
        "HTTP/1.1 101 Switching Protocols\r\n\r\n",
      );
      expect(target.handshake()).toMatch(/^GET \/\?token=hmr HTTP\/1\.1\r\n/);
    });

    it.each([
      ["no session", async () => ""],
      ["another origin's session", () => session("https://other.example")],
    ])("refuses %s without reaching the guest", async (_label, cookie) => {
      const target = await guest();
      const { port } = await hostd(target.port, {
        services: { web: 5173 },
        previews: true,
      });
      const socket = await open(port, "/v0beta1/rigs/demo/previews/web/hmr", {
        key: "",
        cookie: await cookie(),
      });
      expect(await read(socket)).toMatch(/^HTTP\/1\.1 401 /);
      expect(target.handshake()).toBe("");
    });

    // No CORS covers a WebSocket, so a sibling subdomain's page could
    // otherwise open one with the session and read it.
    it.each([
      ["another site's page", "https://evil.hostd.example"],
      ["no page at all", ""],
    ])("refuses an upgrade from %s", async (_label, origin) => {
      const target = await guest();
      const { port } = await hostd(target.port, {
        services: { web: 5173 },
        previews: true,
      });
      const socket = await open(port, "/v0beta1/rigs/demo/previews/web/hmr", {
        key: "",
        cookie: await session(),
        origin,
      });
      expect(await read(socket)).toMatch(/^HTTP\/1\.1 403 /);
      expect(target.handshake()).toBe("");
    });

    it("serves no previews where hostd serves none", async () => {
      const target = await guest();
      const { port } = await hostd(target.port, { services: { web: 5173 } });
      const socket = await open(port, "/v0beta1/rigs/demo/previews/web/hmr", {
        key: "",
        cookie: await session(),
      });
      expect(await read(socket)).toMatch(/^HTTP\/1\.1 (401|404) /);
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
    // Signals once the handler has the port, so the dial assertion below
    // runs only after the handler could have dialed.
    const runtime = runtimeWith(async () => {
      await lookup;
      resolved();
      return 1;
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

  it("answers 502 when the runtime lookup fails unexpectedly", async () => {
    const server = createHttpServer();
    const runtime = runtimeWith(async () => {
      throw new TypeError("bug");
    });
    server.on("upgrade", createUpgradeHandler(SECRET, runtime, registry()));
    const socket = await open(await listen(server), validPath());
    expect(await read(socket)).toMatch(/^HTTP\/1\.1 502 /);
  });

  it("answers 502 when the guest port is closed", async () => {
    const closed = await closedLoopbackPort();
    const { port } = await hostd(closed);
    const socket = await open(port, validPath());
    expect(await read(socket)).toMatch(/^HTTP\/1\.1 502 /);
  });
});
