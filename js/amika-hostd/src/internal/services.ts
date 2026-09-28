/**
 * Public, signed routes to a machine's published guest ports.
 *
 * A machine created with `ports` gets each guest port published by smolvm on
 * a host loopback port. `/services/<machine>/<port>/<token>/<path>` forwards
 * HTTP requests and WebSocket upgrades to it, with `<path>` as the guest path.
 * This is how Amika reaches `amikad` for no-relay SSH: its bridge
 * authenticates the SSH client itself, from the `Authorization` header this
 * route forwards unchanged.
 *
 * These routes skip the daemon's secret key, since their callers (the Amika
 * CLI, the web terminal) never hold it. The token stands in for it: the
 * `@amika/sandbox` provider signs `<machine>`, `<port>` and an expiry with the
 * secret key (`signHostdServiceToken`, mirrored here by `signServiceToken`),
 * so a URL opens only the one port it names, and only until it expires.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { connect, createServer, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { z } from "zod";
import type { SmolRuntime } from "./smol.js";

export const SERVICES_PREFIX = "/services/";

/**
 * Handle Node's `upgrade` event: pipe a WebSocket (or any other upgrade)
 * handshake and everything after it to the guest port the route names. The
 * guest answers the handshake itself; hostd only moves bytes. Tunnels are
 * tracked so shutdown can end them, since `server.close` does not.
 */
export function createUpgradeHandler(
  secretKey: string,
  runtime: SmolRuntime,
  tunnels = new Set<Duplex>(),
  dial: (port: number) => Socket = (port) => connect(port, "127.0.0.1"),
) {
  return (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    // Tracked from the start, not once connected, so a shutdown that begins
    // while the route is still being resolved ends this upgrade too.
    tunnels.add(socket);
    socket.on("close", () => tunnels.delete(socket));
    socket.on("error", () => socket.destroy());
    void upgrade(request, socket, head).catch(() => refuse(socket, 502));
  };

  async function upgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://hostd");
    const route = parseServicePath(url.pathname);
    if (!route || !verifyServiceToken(secretKey, route)) {
      return refuse(socket, 404);
    }
    const hostPort = await resolveHostPort(runtime, route.machine, route.port);
    if (hostPort === null) return refuse(socket, 404);
    if (socket.destroyed) return;

    const upstream = dial(hostPort);
    let connected = false;
    upstream.once("connect", () => {
      connected = true;
      upstream.write(requestHead(request, `${route.path}${url.search}`));
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => {
      if (connected) socket.destroy();
      else refuse(socket, 502);
    });
    upstream.on("close", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
  }
}

/**
 * The handshake as the guest should see it: the guest path in place of the
 * service route, and every header exactly as the caller sent it, including
 * `Host`, `Origin`, and the `Authorization` the guest authenticates. Only
 * `Proxy-Authorization` is dropped: it was meant for a proxy in front of
 * hostd, never for the guest.
 */
function requestHead(request: IncomingMessage, path: string): string {
  const lines = [`${request.method} ${path} HTTP/${request.httpVersion}`];
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i];
    if (name.toLowerCase() === "proxy-authorization") continue;
    lines.push(`${name}: ${request.rawHeaders[i + 1]}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

const REFUSAL_REASONS = { 404: "Not Found", 502: "Bad Gateway" } as const;

function refuse(socket: Duplex, status: keyof typeof REFUSAL_REASONS): void {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${REFUSAL_REASONS[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

/** A parsed, not yet verified, service route. */
export interface ServiceRoute {
  machine: string;
  port: number;
  token: string;
  /** The guest-side path, always starting with `/`. */
  path: string;
}

/**
 * Split a request path into its route parts, or null if it is not a service
 * route. The rest of the path is kept encoded, exactly as the caller sent it.
 */
export function parseServicePath(pathname: string): ServiceRoute | null {
  if (!pathname.startsWith(SERVICES_PREFIX)) return null;
  const match =
    /^\/services\/([a-zA-Z0-9][a-zA-Z0-9_-]*)\/([1-9][0-9]{0,4})\/([^/]+)(\/.*)?$/.exec(
      pathname,
    );
  if (!match) return null;
  const port = Number(match[2]);
  if (port > 65_535) return null;
  return { machine: match[1], port, token: match[3], path: match[4] ?? "/" };
}

/**
 * The token for one machine port, valid until `expiresAt` (Unix seconds):
 * `<expiresAt>.<base64url HMAC-SHA256>`. Mirrors `signHostdServiceToken` in
 * `@amika/sandbox`'s `amika-hostd` provider; the two must stay identical.
 */
export function signServiceToken(
  secretKey: string,
  machine: string,
  port: number,
  expiresAt: number,
): string {
  return `${expiresAt}.${serviceMac(secretKey, machine, port, expiresAt)}`;
}

/** Whether `token` was signed for this machine port and has not expired. */
export function verifyServiceToken(
  secretKey: string,
  route: Pick<ServiceRoute, "machine" | "port" | "token">,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const match = /^([1-9][0-9]{0,11})\.([A-Za-z0-9_-]{43})$/.exec(route.token);
  if (!match) return false;
  const expiresAt = Number(match[1]);
  const expected = Buffer.from(
    serviceMac(secretKey, route.machine, route.port, expiresAt),
  );
  const provided = Buffer.from(match[2]);
  return timingSafeEqual(expected, provided) && nowSeconds < expiresAt;
}

function serviceMac(
  secretKey: string,
  machine: string,
  port: number,
  expiresAt: number,
): string {
  return createHmac("sha256", secretKey)
    .update(`amika-hostd-service:v1\n${machine}\n${port}\n${expiresAt}`)
    .digest("base64url");
}

const machinePortsSchema = z.object({
  state: z.string(),
  ports: z.array(z.object({ host: z.number().int(), guest: z.number().int() })),
});

/**
 * The host loopback port smolvm published `guestPort` on, or null when the
 * machine does not exist, is not running, or did not publish it. A stopped
 * machine's VM no longer holds its host port, so another machine or process
 * may have bound it since; only a running machine's mapping is its own.
 */
export async function resolveHostPort(
  runtime: SmolRuntime,
  machine: string,
  guestPort: number,
): Promise<number | null> {
  const response = await runtime.request(`/${machine}`);
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  const parsed = machinePortsSchema.safeParse(
    await response.json().catch(() => undefined),
  );
  if (!parsed.success || parsed.data.state !== "running") return null;
  return parsed.data.ports.find((p) => p.guest === guestPort)?.host ?? null;
}

/**
 * A free port on the host's loopback interface for smolvm to publish a guest
 * port on. The port is released before smolvm binds it, so another process
 * can take it first, and smolvm then fails to start the machine.
 */
export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("could not allocate a loopback port"));
      });
    });
  });
}

/**
 * Hop-by-hop headers (RFC 9110 §7.6.1) that describe one connection and must
 * not be forwarded across the proxy.
 */
export const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];
