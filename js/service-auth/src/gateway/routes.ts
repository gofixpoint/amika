/** The service routes a gateway serves, and the request shape it reads. */

/**
 * What the gateway reads of a request, whatever server received it: a
 * Fetch `Request`, or a Node upgrade (`fromIncomingMessage`).
 */
export interface GatewayRequest {
  method: string;
  /** The request's URL; only its path and query are trusted. */
  url: URL;
  headers: Headers;
  /**
   * The rig and service the request's own hostname names, as a hop the
   * server trusts vouched for them: amika-hostd's tunnel, which the gateway
   * in front of it fills from what the reverse proxy signed. Never from a
   * header a caller could write. Absent for every other request.
   *
   * Such a request is the service's whatever its path, but for the two
   * login endpoints: its origin is the service's own (`gateway.ts`).
   */
  named?: Pick<ServiceRoute, "machine" | "service">;
}

/** A Fetch `Request` as the gateway reads it. */
export function fromRequest(request: Request): GatewayRequest {
  return {
    method: request.method,
    url: new URL(request.url),
    headers: request.headers,
  };
}

/** amikad's service name, as Amika registers it. */
export const AMIKAD_SERVICE = "amikad";

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

/**
 * amikad's SSH WebSocket routes: `/v1` carries raw SSH bytes, and `/v2` the
 * resumable stream that lets a session outlive a dropped WebSocket. Both take
 * the same connect token, which amikad checks before it accepts the socket.
 */
const AMIKAD_SSH_PATHS = ["/v1/ssh-sessions", "/v2/ssh-sessions"] as const;

/**
 * Whether this upgrade is the one service request that needs no host key:
 * the SSH WebSocket a user's `amika sandbox ssh` opens to the rig's amikad,
 * exactly `GET /v0beta1/rigs/<rig>/services/amikad/v1/ssh-sessions` (or its
 * `/v2` twin), no query, as a WebSocket upgrade. The control plane hands the
 * CLI that URL and the rig's connect token, never the host key; amikad
 * verifies the token before it accepts the WebSocket, and sshd then checks
 * the user's SSH key. Every other path, method, service and plain HTTP
 * request still needs the key.
 */
export function isAmikadSshUpgrade(request: GatewayRequest): boolean {
  const route = parseServicePath(request.url.pathname);
  return (
    route !== null &&
    AMIKAD_SSH_PATHS.some((path) =>
      isSshWebSocket(
        request,
        `/v0beta1/rigs/${route.machine}/services/${AMIKAD_SERVICE}${path}`,
      ),
    )
  );
}

/**
 * The same upgrade made to amikad at the rig's own address,
 * `amikad--<rig>.r.<org>.o.<zone>`, where a tunnel host's rigs are reached:
 * exactly `GET /v1/ssh-sessions` or `GET /v2/ssh-sessions`, no query, as a
 * WebSocket upgrade. It is the only request amikad answers at its name, and
 * it is authenticated as the service route's is, by amikad's connect token
 * and then sshd.
 */
export function isNamedAmikadSshUpgrade(request: GatewayRequest): boolean {
  return (
    request.named?.service === AMIKAD_SERVICE &&
    AMIKAD_SSH_PATHS.some((path) => isSshWebSocket(request, path))
  );
}

function isSshWebSocket(
  { method, url, headers }: GatewayRequest,
  path: string,
): boolean {
  if (
    method !== "GET" ||
    url.search !== "" ||
    // The literal path, not just its decoding, so no encoded variant counts.
    url.pathname !== path
  ) {
    return false;
  }
  const upgrade = headers.get("upgrade")?.trim().toLowerCase();
  const connection = (headers.get("connection") ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase());
  return upgrade === "websocket" && connection.includes("upgrade");
}
