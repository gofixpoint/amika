/**
 * Routes from the control plane, curl and browsers to a machine's named
 * services.
 *
 * A machine created with `services` gets each guest port published on a host
 * loopback port (by the `smolvm-sdk` provider), and hostd records which name
 * maps to which port (`./service-registry.ts`). A service route,
 * `/v0beta1/rigs/<machine>/services/<name>/<path>`, a preview of one, or a
 * page the preview opened forwards HTTP requests and WebSocket upgrades
 * there, with `<path>` as the guest path.
 *
 * Who may reach which service is the gateway's to decide
 * (`@amika/service-auth/gateway`): the host's secret key, a service token,
 * or a browser session on a preview. This module only carries out its
 * decisions, and never forwards a credential of the gateway's to a guest.
 */
import type { IncomingMessage } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import {
  AMIKAD_SERVICE,
  createGateway,
  type Gateway,
  type GatewayRequest,
  type ServiceRoute,
} from "@amika/service-auth/gateway";
import { guestHost } from "./guest-host.js";
import { isHostdPath } from "./hostd-paths.js";
import { namedRoute } from "./tunnel-rig-route.js";
import { namedService, type ServiceRegistry } from "./service-registry.js";
import type { MachineRuntime } from "./machine-runtime.js";

/** amikad's guest port, as Amika registers it. */
export const AMIKAD_PORT = 60999;

/**
 * hostd's gateway: the secret key, the paths that are hostd's own, and
 * Amika's URL, which turns on previews behind a browser login.
 */
export function hostdGateway(secretKey: string, amikaUrl?: string): Gateway {
  return createGateway({ secretKey, isOwnPath: isHostdPath, amikaUrl });
}

/**
 * Handle Node's `upgrade` event: pipe a WebSocket (or any other upgrade)
 * handshake and everything after it to the guest port the route names. The
 * guest answers the handshake itself; hostd only moves bytes, but for any
 * cookie of the gateway's the answer tries to set. Tunnels are tracked so
 * shutdown can end them, since `server.close` does not.
 */
export function createUpgradeHandler(
  secretKey: string,
  runtime: MachineRuntime,
  registry: ServiceRegistry,
  tunnels = new Set<Duplex>(),
  dial: (port: number) => Socket = (port) => connect(port, "127.0.0.1"),
  /** Amika's URL, which turns on previews (`hostdGateway`). */
  { amikaUrl }: { amikaUrl?: string } = {},
) {
  const gateway = hostdGateway(secretKey, amikaUrl);
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
    const incoming = fromIncomingMessage(request);
    // What the registry recorded of the service at its name: who may have
    // it, and the `Host` it sees.
    const named = incoming.named && namedService(registry, incoming.named);
    const decision = await gateway.authorize(
      { ...incoming, named },
      { upgrade: true },
    );
    if (decision.kind === "not-mine") {
      // No service of any machine: refused as any request without the key
      // is, and not found with it.
      return refuse(socket, gateway.checkHostKey(incoming.headers) ?? 404);
    }
    if (decision.kind === "refuse") return refuse(socket, decision.status);
    // A socket cannot be sent to log in.
    if (decision.kind === "login") return refuse(socket, 401);
    const { route } = decision;
    // Only the rig's own amikad, on the port Amika registers it at, answers
    // a request that skipped the key.
    if (
      decision.keyless &&
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
      upstream.write(
        requestHead(
          request,
          `${route.path}${incoming.url.search}`,
          // Only a named request is at a public address of its own, and
          // only there is `Host` hostd's to choose (`guest-host.ts`).
          named
            ? {
                authority: incoming.url.host,
                host: guestHost(
                  named.preserveHost,
                  incoming.url.host,
                  hostPort,
                ),
              }
            : undefined,
        ),
      );
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      relayAnswer(upstream, socket);
    });
    upstream.on("error", () => {
      if (connected) socket.destroy();
      else refuse(socket, 502);
    });
    upstream.on("close", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
  }

  /**
   * The handshake as the guest should see it: the guest path in place of
   * the service route, and every header exactly as the caller sent it,
   * including `Host`, `Origin`, and the `Authorization` the guest
   * authenticates. Only the gateway's credentials and `Proxy-Authorization`
   * are dropped: each was meant for hostd or a proxy in front of it, never
   * for the guest. A named request's `Host` is hostd's to choose, and its
   * public address is told as every proxy tells it.
   */
  function requestHead(
    request: IncomingMessage,
    path: string,
    /** For a named request, its public address and the `Host` to write. */
    named?: { authority: string; host: string },
  ): string {
    const lines = [`${request.method} ${path} HTTP/${request.httpVersion}`];
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      const name = request.rawHeaders[i];
      const lower = name.toLowerCase();
      if (
        lower === "proxy-authorization" ||
        gateway.isCredentialHeader(lower) ||
        (named !== undefined && (isForwardingHeader(lower) || lower === "host"))
      ) {
        continue;
      }
      const value = request.rawHeaders[i + 1];
      if (lower === "cookie" && gateway.carriesCredentialCookie(value)) {
        const kept = gateway.guestCookies(value);
        if (kept) lines.push(`${name}: ${kept}`);
        continue;
      }
      lines.push(`${name}: ${value}`);
    }
    if (named !== undefined) {
      lines.push(`Host: ${named.host}`);
      for (const [name, value] of publicForwarding(named.authority)) {
        lines.push(`${name}: ${value}`);
      }
    }
    return `${lines.join("\r\n")}\r\n\r\n`;
  }

  /**
   * Pipe the guest's side of the tunnel to the caller, its answer to the
   * handshake through `finishUpgrade` first: the guest may set a cookie of
   * its own there, never one of the gateway's. A head that does not end
   * within `MAX_ANSWER_HEAD` bytes ends the tunnel.
   */
  function relayAnswer(upstream: Socket, socket: Duplex): void {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if ((end < 0 ? buffered.length : end) > MAX_ANSWER_HEAD) {
        upstream.destroy();
        return;
      }
      if (end < 0) return;
      upstream.off("data", onData);
      upstream.pause();
      const answer = gateway.finishUpgrade(
        buffered.subarray(0, end).toString("latin1"),
      );
      socket.write(
        Buffer.concat([Buffer.from(answer, "latin1"), buffered.subarray(end)]),
      );
      upstream.pipe(socket);
    };
    upstream.on("data", onData);
  }
}

/** The most of a guest's answer to a handshake hostd holds to read. */
const MAX_ANSWER_HEAD = 64 * 1024;

/**
 * An upgrade as the gateway reads it, on its `Host`, as a preview's session
 * is for the origin it was reached at. A `Host` no URL can hold reaches no
 * session.
 */
function fromIncomingMessage(request: IncomingMessage): GatewayRequest {
  const headers = new Headers();
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    headers.append(request.rawHeaders[i], request.rawHeaders[i + 1]);
  }
  let url: URL;
  try {
    url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  } catch {
    url = new URL(request.url ?? "/", "http://hostd");
  }
  // The service the tunnel named this upgrade for, if it did: a rig's
  // WebSocket opened on its own hostname (`tunnel-rig-route.ts`).
  return {
    method: request.method ?? "GET",
    url,
    headers,
    named: namedRoute(request),
  };
}

const REFUSAL_REASONS = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
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
 * What a service reached at its own address is told about that address:
 * the public name the browser asked for, and that it arrived over https.
 *
 * `Host` stays the guest's local address, as a reverse proxy leaves it by
 * default. A dev server that accepts only `localhost` (Vite's host check,
 * which guards against DNS rebinding) keeps working, and a framework that
 * builds absolute URLs or checks `Origin` reads these instead.
 *
 * Always from the signed authority, never from the request: a caller who
 * could choose these could have the guest mail a reset link to their own
 * site. The caller's own forwarding headers are dropped first
 * ({@link isForwardingHeader}), so these are the only ones the guest sees.
 */
export function publicForwarding(authority: string): Array<[string, string]> {
  return [
    ["X-Forwarded-Host", authority],
    ["X-Forwarded-Proto", "https"],
  ];
}

/** Whether a request header (lowercased) states how a proxy forwarded it. */
export function isForwardingHeader(name: string): boolean {
  return name === "forwarded" || name.startsWith("x-forwarded-");
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
