/**
 * A rig's service reached at its own hostname, through the tunnel's server,
 * the real app and the real gateway: the browser login end to end.
 *
 * Sockets are fed to `virtualServer` exactly as the tunnel feeds it, with
 * the two headers the gateway writes, so what is under test is the path a
 * browser at `s-web--demo--acme.amika.test` takes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type Server as HttpServer,
} from "node:http";
import { getRequestListener } from "@hono/node-server";
import { connect, createServer, type AddressInfo, type Server } from "node:net";
import type { Duplex } from "node:stream";
import { signLoginPass, signSession } from "@amika/service-auth/credentials";
import { createApp } from "./app.js";
import type { MachineRuntime } from "./internal/machine-runtime.js";
import { memoryServiceRegistry } from "./internal/service-registry.js";
import { AMIKAD_PORT, createUpgradeHandler } from "./internal/services.js";
import { virtualServer } from "./internal/tunnel-serving.js";

const SECRET = "test-secret";
const AMIKA = "https://app.amika.test";
const NAME = "s-web--demo--acme.amika.test";
const ORIGIN = `https://${NAME}`;
const NAMED = { "x-amika-rig": "demo", "x-amika-service": "web" };
const NAVIGATE = { "sec-fetch-mode": "navigate", "sec-fetch-site": "none" };

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise((done) => s.close(done))),
  );
});

/** A host whose `demo` rig serves `web`, reached as the tunnel reaches it. */
async function tunnelledHost() {
  const runtime = {
    hostPort: vi.fn(async () => 41001),
    list: vi.fn(async () => []),
  } as unknown as MachineRuntime;
  const registry = memoryServiceRegistry();
  registry.set("demo", { web: 3000, amikad: AMIKAD_PORT });
  // Another rig on the same host, for a request that must never reach it.
  registry.set("other", { admin: 4000 });
  const guest = vi.fn<typeof fetch>(
    async (url) => new Response(`guest ${url}`),
  );
  const app = createApp({ secretKey: SECRET, amikaUrl: AMIKA }, runtime, {
    registry,
    fetch: guest,
  });
  // A guest WebSocket server that records the handshake it is sent.
  let handshake = "";
  const guestPort = await listen(
    createServer((socket) => {
      socket.once("data", (chunk) => {
        handshake = chunk.toString();
        socket.end("HTTP/1.1 101 Switching Protocols\r\n\r\n");
      });
    }),
  );
  const upgrade = createUpgradeHandler(
    SECRET,
    runtime,
    registry,
    new Set<Duplex>(),
    () => connect(guestPort, "127.0.0.1"),
    { amikaUrl: AMIKA },
  );
  const tunnel = virtualServer({ fetch: app.fetch, upgrade });
  const port = await listen(createServer((socket) => tunnel.accept(socket)));
  // The same app on an ordinary listening socket, as listen mode serves it.
  const listenerPort = await listen(
    createHttpServer(getRequestListener(app.fetch)),
  );

  /** One request down the "tunnel", with the gateway's headers. */
  const send = (
    path: string,
    headers: Record<string, string> = {},
    options: { method?: string; body?: string } = {},
  ) => sendTo(port, path, headers, options);
  /** The same request to the listener, carrying the same headers. */
  const sendToListener = (path: string, headers: Record<string, string> = {}) =>
    sendTo(listenerPort, path, headers);
  /** A WebSocket handshake down the "tunnel"; resolves with what the guest got. */
  const upgradeTo = async (path: string, headers: Record<string, string>) => {
    const socket = connect(port, "127.0.0.1");
    await new Promise((ready) => socket.once("connect", ready));
    const lines = Object.entries({
      host: NAME,
      ...NAMED,
      connection: "Upgrade",
      upgrade: "websocket",
      ...headers,
    }).map(([name, value]) => `${name}: ${value}`);
    socket.write(`GET ${path} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
    await new Promise((done) => socket.once("data", done));
    socket.destroy();
    return handshake;
  };
  return { guest, send, sendToListener, upgradeTo };
}

/** Start `server` on a free loopback port, closed after the test. */
async function listen(server: Server | HttpServer): Promise<number> {
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return (server.address() as AddressInfo).port;
}

/** One request to `port`, with the gateway's headers and `headers`. */
function sendTo(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  { method = "GET", body }: { method?: string; body?: string } = {},
) {
  return new Promise<{
    status: number;
    location?: string;
    cookies: string[];
    body: string;
  }>((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: { host: NAME, ...NAMED, ...headers },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => (text += chunk.toString()));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            location: res.headers.location,
            cookies: res.headers["set-cookie"] ?? [],
            body: text,
          }),
        );
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** `name=value` of the cookie `name` in `cookies`. */
function cookie(cookies: string[], name: string): string {
  const found = cookies.find((c) => c.startsWith(`${name}=`));
  if (!found) throw new Error(`no ${name} cookie`);
  return found.split(";")[0]!;
}

describe("a rig's service at its own hostname", () => {
  it("logs a browser in at that origin and serves the page it asked for", async () => {
    const { guest, send } = await tunnelledHost();

    // 1. The page, with no session: off to log in, coming back here.
    const page = await send("/app?q=1", NAVIGATE);
    expect(page.status).toBe(302);
    expect(page.location).toBe(
      `/__amika/login?${new URLSearchParams({ return: "/app?q=1" })}`,
    );

    // 2. The login, on the same origin: to Amika, naming this origin.
    const start = await send(page.location!, NAVIGATE);
    expect(start.status).toBe(302);
    const authorize = new URL(start.location!);
    expect(`${authorize.origin}${authorize.pathname}`).toBe(
      `${AMIKA}/hosts/authorize`,
    );
    expect(authorize.searchParams.get("origin")).toBe(ORIGIN);
    const state = authorize.searchParams.get("state")!;

    // 3. Amika's pass, posted back to this origin's callback.
    const pass = await signLoginPass(SECRET, {
      origin: ORIGIN,
      state,
      user: "user_1",
    });
    const callback = await send(
      "/__amika/callback",
      {
        cookie: cookie(start.cookies, "__Host-amika-login"),
        "content-type": "application/x-www-form-urlencoded",
      },
      { method: "POST", body: new URLSearchParams({ pass }).toString() },
    );
    expect(callback.status).toBe(303);
    expect(callback.location).toBe("/app?q=1");
    const session = cookie(callback.cookies, "__Host-amika-session");

    // 4. The page again, now with a session: the guest's, path untouched.
    const served = await send("/app?q=1", { ...NAVIGATE, cookie: session });
    expect(served.status).toBe(200);
    expect(served.body).toBe("guest http://127.0.0.1:41001/app?q=1");
    // The session is the gateway's, never the guest's.
    const [, init] = guest.mock.calls.at(-1)!;
    expect(new Headers(init?.headers).get("cookie")).toBeNull();
  });

  it("gives the service every path, this daemon's API paths included", async () => {
    const { guest, send } = await tunnelledHost();

    // No session and no key: refused, and never the machine list.
    const api = await send("/v0beta1/rigs", {
      authorization: `Bearer ${SECRET}`,
    });
    expect(api.status).toBe(401);
    expect(guest).not.toHaveBeenCalled();
  });

  it("tells the service its public address, and nothing the caller claimed", async () => {
    // `Host` stays local, so a dev server that only accepts localhost still
    // answers; frameworks build URLs and check `Origin` from these. A caller
    // who could set them could have the app mail a link to their own site.
    const { guest, send } = await tunnelledHost();
    const session = `__Host-amika-session=${await signSession(SECRET, { origin: ORIGIN, user: "u" })}`;

    await send("/app", {
      ...NAVIGATE,
      cookie: session,
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "http",
      forwarded: "host=evil.example",
    });

    const [, init] = guest.mock.calls.at(-1)!;
    const headers = new Headers(init?.headers);
    expect(headers.get("x-forwarded-host")).toBe(NAME);
    expect(headers.get("x-forwarded-proto")).toBe("https");
    expect(headers.get("forwarded")).toBeNull();
    expect(headers.get("host")).toBeNull();
  });

  it("tells a WebSocket the same, and keeps its Host for its Origin check", async () => {
    const { upgradeTo } = await tunnelledHost();
    const session = `__Host-amika-session=${await signSession(SECRET, { origin: ORIGIN, user: "u" })}`;

    const handshake = await upgradeTo("/live", {
      origin: ORIGIN,
      cookie: session,
      "x-forwarded-host": "evil.example",
    });

    expect(handshake).toContain(`X-Forwarded-Host: ${NAME}`);
    expect(handshake).toContain("X-Forwarded-Proto: https");
    expect(handshake).not.toContain("evil.example");
    expect(handshake).toContain(`host: ${NAME}`);
  });

  it.each([
    ["POST", "/__amika/login"],
    ["PUT", "/__amika/login"],
    ["GET", "/__amika/callback"],
  ])(
    "never routes %s %s by a cookie the page set itself",
    async (method, path) => {
      // A page can write `__Host-amika-preview` on its own origin. Were a
      // login path with the wrong method to fall through to the catch-all,
      // that cookie would route it to another rig, readable by the page.
      const { guest, send } = await tunnelledHost();
      const session = `__Host-amika-session=${await signSession(SECRET, { origin: ORIGIN, user: "u" })}`;

      const answer = await send(
        path,
        {
          cookie: `${session}; __Host-amika-preview=other/admin`,
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "cors",
          "content-type": "application/x-www-form-urlencoded",
        },
        { method, body: method === "GET" ? undefined : "x=1" },
      );

      expect(answer.status).toBe(404);
      expect(guest).not.toHaveBeenCalled();
    },
  );

  it("lets amikad's SSH upgrade through at its name, and nothing else of amikad's", async () => {
    // A tunnel host's rig has no other address an SSH client can dial.
    // amikad checks the connect token itself, so it reaches amikad as
    // the caller sent it.
    const { send, upgradeTo } = await tunnelledHost();
    const amikad = {
      host: "s-amikad--demo--acme.amika.test",
      "x-amika-service": "amikad",
    };

    const handshake = await upgradeTo("/v1/ssh-sessions", {
      ...amikad,
      authorization: "Bearer connect-token",
    });
    expect(handshake).toMatch(/^GET \/v1\/ssh-sessions HTTP\/1\.1\r\n/);
    expect(handshake).toContain("authorization: Bearer connect-token");

    // A fresh host, so a refused upgrade reaches no guest at all.
    const other = await tunnelledHost();
    expect(await other.upgradeTo("/v1/exec", amikad)).toBe("");
    expect((await send("/v1/status", amikad)).status).toBe(404);
  });

  it("takes no host key at the service's name, as none could arrive", async () => {
    // The proxy and the gateway drop a caller's `x-amika-` headers, so a
    // key sent to a name never reaches hostd. One that did must not open
    // the rig, let alone hostd's own API under the service's path.
    const { guest, send } = await tunnelledHost();

    const answer = await send("/v0beta1/rigs", {
      "x-amika-hostd-key": SECRET,
    });

    expect(answer.status).toBe(401);
    expect(guest).not.toHaveBeenCalled();
  });

  it("does not name a request that reached a listener with the same headers", async () => {
    // On a listening socket the headers are anybody's. The app must treat
    // the request as one for its own API, and want the key for it.
    const { guest, sendToListener } = await tunnelledHost();

    const answer = await sendToListener("/app", NAVIGATE);

    expect(answer.status).toBe(401);
    expect(guest).not.toHaveBeenCalled();
  });
});
