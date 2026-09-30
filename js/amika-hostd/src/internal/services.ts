/**
 * Routes from the control plane to a machine's named services.
 *
 * A machine created with `services` gets each guest port published by smolvm
 * on a host loopback port, and hostd records which name maps to which port
 * (`./service-registry.ts`). `/rigs/<machine>/services/<name>/<path>`
 * forwards HTTP requests and WebSocket upgrades there, with `<path>` as the
 * guest path.
 *
 * Only the control plane calls these routes, and it proves itself with the
 * host's secret key, as on every other route. Here the key travels in
 * `X-Amika-Hostd-Key` rather than `Authorization`, because `Authorization`
 * belongs to the guest: `amikad`, for one, authenticates SSH clients with it.
 * hostd removes the key header before forwarding, and refuses a request that
 * puts the key in `Authorization`, so the key never reaches a guest.
 */
import type { IncomingMessage } from "node:http";
import { connect, createServer, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { z } from "zod";
import { secretMatches } from "./auth.js";
import type { ServiceRegistry } from "./service-registry.js";
import type { SmolRuntime } from "./smol.js";

export const RIGS_PREFIX = "/rigs/";

/** Carries the host's secret key on service routes; never forwarded. */
export const SERVICE_KEY_HEADER = "x-amika-hostd-key";

/**
 * Handle Node's `upgrade` event: pipe a WebSocket (or any other upgrade)
 * handshake and everything after it to the guest port the route names. The
 * guest answers the handshake itself; hostd only moves bytes. Tunnels are
 * tracked so shutdown can end them, since `server.close` does not.
 */
export function createUpgradeHandler(
  secretKey: string,
  runtime: SmolRuntime,
  registry: ServiceRegistry,
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
    const refusal = authorizeServiceRequest(secretKey, {
      key: request.headers[SERVICE_KEY_HEADER],
      authorization: request.headers.authorization,
    });
    if (refusal) return refuse(socket, refusal);
    const url = new URL(request.url ?? "/", "http://hostd");
    const route = parseServicePath(url.pathname);
    if (!route) return refuse(socket, 404);
    const hostPort = await resolveHostPort(runtime, registry, route);
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
 * hostd's own key and `Proxy-Authorization` are dropped: both were meant for
 * hostd or a proxy in front of it, never for the guest.
 */
function requestHead(request: IncomingMessage, path: string): string {
  const lines = [`${request.method} ${path} HTTP/${request.httpVersion}`];
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i];
    const lower = name.toLowerCase();
    if (lower === "proxy-authorization" || lower === SERVICE_KEY_HEADER) {
      continue;
    }
    lines.push(`${name}: ${request.rawHeaders[i + 1]}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

const REFUSAL_REASONS = {
  400: "Bad Request",
  401: "Unauthorized",
  404: "Not Found",
  502: "Bad Gateway",
} as const;

function refuse(socket: Duplex, status: keyof typeof REFUSAL_REASONS): void {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${REFUSAL_REASONS[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

/**
 * Why a service request is refused, or null to let it through: 401 without
 * the right key in `X-Amika-Hostd-Key`, 400 when the key is also sent as the
 * `Authorization` the guest would receive.
 */
export function authorizeServiceRequest(
  secretKey: string,
  headers: {
    key?: string | string[] | null;
    authorization?: string | string[] | null;
  },
): 400 | 401 | null {
  const key = typeof headers.key === "string" ? headers.key.trim() : "";
  if (!secretMatches(key, secretKey)) return 401;
  const authorization =
    typeof headers.authorization === "string"
      ? headers.authorization.replace(/^Bearer\s+/i, "").trim()
      : "";
  return authorization && secretMatches(authorization, secretKey) ? 400 : null;
}

/** A parsed service route. */
export interface ServiceRoute {
  machine: string;
  service: string;
  /** The guest-side path, always starting with `/`. */
  path: string;
}

/**
 * Split a request path into its route parts, or null if it is not a service
 * route. The service name is one percent-encoded path segment, decoded here;
 * the rest of the path is kept encoded, exactly as the caller sent it.
 */
export function parseServicePath(pathname: string): ServiceRoute | null {
  const match =
    /^\/rigs\/([a-zA-Z0-9][a-zA-Z0-9_-]*)\/services\/([^/]+)(\/.*)?$/.exec(
      pathname,
    );
  if (!match) return null;
  let service: string;
  try {
    service = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  return { machine: match[1], service, path: match[3] ?? "/" };
}

const machinePortsSchema = z.object({
  state: z.string(),
  ports: z.array(z.object({ host: z.number().int(), guest: z.number().int() })),
});

/**
 * The host loopback port behind a route, or null when the machine has no
 * such service, does not exist, is not running, or did not publish the
 * service's port. A stopped machine's VM no longer holds its host port, so
 * another machine or process may have bound it since; only a running
 * machine's mapping is its own.
 */
export async function resolveHostPort(
  runtime: SmolRuntime,
  registry: ServiceRegistry,
  { machine, service }: Pick<ServiceRoute, "machine" | "service">,
): Promise<number | null> {
  const guestPort = registry.port(machine, service);
  if (guestPort === undefined) return null;
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
 * Remove the hop-by-hop headers from `headers` in place: the fixed set below
 * and any header the `Connection` header nominates (RFC 9110 §7.6.1), such as
 * `X-Hop` in `Connection: X-Hop`.
 */
export function stripHopByHopHeaders(headers: Headers): void {
  const nominated = (headers.get("connection") ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  for (const name of [...HOP_BY_HOP_HEADERS, ...nominated]) {
    headers.delete(name);
  }
}

/**
 * Hop-by-hop headers (RFC 9110 §7.6.1) that describe one connection and must
 * not be forwarded across the proxy.
 */
const HOP_BY_HOP_HEADERS = [
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
