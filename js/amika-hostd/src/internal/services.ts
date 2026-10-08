/**
 * Routes from the control plane to a machine's named services.
 *
 * A machine created with `services` gets each guest port published on a host
 * loopback port (by the `smolvm-sdk` provider), and hostd records which name maps to which port
 * (`./service-registry.ts`). `/v0beta1/rigs/<machine>/services/<name>/<path>`
 * forwards HTTP requests and WebSocket upgrades there, with `<path>` as the
 * guest path.
 *
 * Only the control plane calls these routes, and it proves itself with the
 * host's secret key, as on every other route. Here the key travels in
 * `X-Amika-Hostd-Key` rather than `Authorization`, because `Authorization`
 * belongs to the guest: `amikad`, for one, authenticates SSH clients with it.
 * hostd removes the key header before forwarding, and refuses a request that
 * puts the key in `Authorization`, so the key never reaches a guest.
 *
 * The one exception is amikad's SSH WebSocket (`isAmikadSshUpgrade`), which
 * the user's CLI opens directly with a connect token amikad verifies.
 *
 * Browsers reach a service through a signed service link instead,
 * `/v0beta1/rigs/<machine>/service-links/<name>/<expiry>.<signature>/<path>`,
 * which the control plane mints from the same secret key and hostd verifies
 * without calling it (`@amika/sandbox/hostd-service-links`). A link grants one
 * service of one machine until its expiry, and forwards exactly as the keyed
 * route does.
 */
import type { IncomingMessage } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { verifyServiceLink } from "@amika/sandbox/hostd-service-links";
import { secretMatches } from "./auth.js";
import type { ServiceRegistry } from "./service-registry.js";
import type { MachineRuntime } from "./machine-runtime.js";

/** Carries the host's secret key on service routes; never forwarded. */
export const SERVICE_KEY_HEADER = "x-amika-hostd-key";

/** amikad's service name and guest port, as Amika registers them. */
export const AMIKAD_SERVICE = "amikad";
export const AMIKAD_PORT = 60999;

/**
 * Handle Node's `upgrade` event: pipe a WebSocket (or any other upgrade)
 * handshake and everything after it to the guest port the route names. The
 * guest answers the handshake itself; hostd only moves bytes. Tunnels are
 * tracked so shutdown can end them, since `server.close` does not.
 */
export function createUpgradeHandler(
  secretKey: string,
  runtime: MachineRuntime,
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
    const url = new URL(request.url ?? "/", "http://hostd");
    const link = parseServiceLinkPath(url.pathname);
    const route = link ?? parseServicePath(url.pathname);
    const headers = {
      key: request.headers[SERVICE_KEY_HEADER],
      authorization: request.headers.authorization,
    };
    // amikad's SSH upgrade may skip the key; a keyed request is the control
    // plane's and routes like any other.
    const keyless =
      !link &&
      route !== null &&
      isAmikadSshUpgrade(request, url) &&
      authorizeServiceRequest(secretKey, headers) === 401;
    const refusal = link
      ? await authorizeServiceLinkRequest(secretKey, link, headers)
      : authorizeServiceRequest(secretKey, headers, { requireKey: !keyless });
    if (refusal) return refuse(socket, refusal);
    if (!route) return refuse(socket, 404);
    // Only the rig's own amikad, on the port Amika registers it at, answers
    // a request that skipped the key.
    if (
      keyless &&
      registry.port(route.machine, AMIKAD_SERVICE) !== AMIKAD_PORT
    ) {
      return refuse(socket, 404);
    }
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
 * Whether this upgrade is the one service request that needs no host key:
 * the SSH WebSocket a user's `amika sandbox ssh` opens to the rig's amikad,
 * exactly `GET /v0beta1/rigs/<rig>/services/amikad/v1/ssh-sessions`, no query,
 * as a WebSocket upgrade. The control plane hands the CLI that URL and the
 * rig's connect token, never the host key; amikad verifies the token before
 * it accepts the WebSocket, and sshd then checks the user's SSH key. Every
 * other path, method, service and plain HTTP request still needs the key.
 */
export function isAmikadSshUpgrade(
  request: IncomingMessage,
  url: URL,
): boolean {
  const route = parseServicePath(url.pathname);
  if (
    request.method !== "GET" ||
    url.search !== "" ||
    route === null ||
    // The literal path, not just its decoding, so no encoded variant counts.
    url.pathname !==
      `/v0beta1/rigs/${route.machine}/services/${AMIKAD_SERVICE}/v1/ssh-sessions`
  ) {
    return false;
  }
  const upgrade = request.headers.upgrade?.trim().toLowerCase();
  const connection = (request.headers.connection ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase());
  return upgrade === "websocket" && connection.includes("upgrade");
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
 * the right key in `X-Amika-Hostd-Key` (unless `requireKey` is false, for
 * amikad's SSH upgrade), 400 when the key is also sent as the
 * `Authorization` the guest would receive.
 */
export function authorizeServiceRequest(
  secretKey: string,
  headers: {
    key?: string | string[] | null;
    authorization?: string | string[] | null;
  },
  { requireKey = true }: { requireKey?: boolean } = {},
): 400 | 401 | null {
  const key = typeof headers.key === "string" ? headers.key.trim() : "";
  if (requireKey && !secretMatches(key, secretKey)) return 401;
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
    /^\/v0beta1\/rigs\/([a-zA-Z0-9][a-zA-Z0-9_-]*)\/services\/([^/]+)(\/.*)?$/.exec(
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

/** A parsed service-link route: a service route plus its signed token. */
export interface ServiceLinkRoute extends ServiceRoute {
  /** `<expiry>.<signature>`, as the control plane minted it. */
  token: string;
}

/**
 * Split a service-link path into its route parts and token, or null if it is
 * not one. As in `parseServicePath`, the service name is decoded and the
 * guest path is kept encoded.
 */
export function parseServiceLinkPath(
  pathname: string,
): ServiceLinkRoute | null {
  const match =
    /^\/v0beta1\/rigs\/([a-zA-Z0-9][a-zA-Z0-9_-]*)\/service-links\/([^/]+)\/([^/]+)(\/.*)?$/.exec(
      pathname,
    );
  if (!match) return null;
  let service: string;
  try {
    service = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  return {
    machine: match[1],
    service,
    token: match[3],
    path: match[4] ?? "/",
  };
}

/**
 * Why a service-link request is refused, or null to let it through: 401
 * unless the link's token is a signature over its machine and service that
 * has not expired, 400 when the host key is sent as the `Authorization` the
 * guest would receive. The host key header is not needed, nor checked.
 */
export async function authorizeServiceLinkRequest(
  secretKey: string,
  link: ServiceLinkRoute,
  headers: { authorization?: string | string[] | null },
  nowS = Math.floor(Date.now() / 1000),
): Promise<400 | 401 | null> {
  const problem = await verifyServiceLink(
    secretKey,
    { rig: link.machine, service: link.service, token: link.token },
    nowS,
  );
  if (problem) return 401;
  return authorizeServiceRequest(secretKey, headers, { requireKey: false });
}

/**
 * The host loopback port behind a route, or null when the machine has no
 * such service, does not exist, is not running, or did not publish the
 * service's port.
 */
export async function resolveHostPort(
  runtime: MachineRuntime,
  registry: ServiceRegistry,
  { machine, service }: Pick<ServiceRoute, "machine" | "service">,
): Promise<number | null> {
  const guestPort = registry.port(machine, service);
  if (guestPort === undefined) return null;
  return runtime.hostPort(machine, guestPort);
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
