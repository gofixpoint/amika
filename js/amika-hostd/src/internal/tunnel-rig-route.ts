/**
 * Reading which rig and service a tunnelled request is for.
 *
 * A browser reaches a rig at `<service>--<rig>.r.<org>.o.<zone>`. The
 * reverse proxy reads the rig and the service out of that name and signs
 * them, and the gateway checks the signature and writes them onto the
 * tunnel stream as two headers, after removing every `x-amika-` header the
 * request arrived with. So on a tunnel stream these two are the gateway's
 * word, and nothing a caller could have written.
 *
 * On a listening socket they are anybody's, which is why only the tunnel's
 * server reads them, and why what it read is kept beside the request
 * rather than in it: a header can be forged and a `WeakMap` entry cannot.
 * The app and the upgrade handler ask `namedRoute`, and the service-auth
 * gateway takes it from there (`GatewayRequest.named`): every path on that
 * origin is the service's, behind a browser login of its own.
 *
 * The gateway spells these names in `@amika/service-token/hops`
 * (`GATEWAY_TO_HOST`), in the amika-mono repository. Change both or
 * neither.
 */
import type { IncomingMessage } from "node:http";

/** The rig the request is for. */
export const RIG_HEADER = "x-amika-rig";
/** The service on that rig. */
export const SERVICE_HEADER = "x-amika-service";

/** The rig and service a request was named for. */
export interface NamedRoute {
  machine: string;
  service: string;
}

export type RigRouteOutcome =
  /** The request names no rig: it is for this daemon's own API. */
  | { kind: "api" }
  /** The request is the named service's. */
  | { kind: "named"; route: NamedRoute }
  /** The request names a rig in a way that cannot be served. */
  | { kind: "refuse"; reason: string };

/**
 * Read the rig headers off a request that came down the tunnel, and
 * remember them for `namedRoute`.
 *
 * Removes the two headers, so the service the request reaches does not
 * see them. A request with neither is left alone: the control plane's
 * calls to this daemon's API name no rig.
 *
 * Call this from the tunnel's server and nowhere else.
 */
export function routeRigService(request: IncomingMessage): RigRouteOutcome {
  const rig = request.headers[RIG_HEADER];
  const service = request.headers[SERVICE_HEADER];
  if (rig === undefined && service === undefined) return { kind: "api" };
  // One without the other is a gateway that does not speak this contract.
  // Serving it as an API call would answer a browser with this daemon's
  // own routes.
  if (typeof rig !== "string" || typeof service !== "string") {
    return { kind: "refuse", reason: "rig and service must come together" };
  }
  if (!NAME.test(rig) || !NAME.test(service)) {
    return { kind: "refuse", reason: "rig or service is not a name" };
  }
  // Origin-form only. The gateway refuses anything else before it opens
  // a stream, so this is the second line, not the first.
  const target = request.url;
  if (
    target === undefined ||
    !target.startsWith("/") ||
    target.startsWith("//")
  ) {
    return { kind: "refuse", reason: "request target is not a path" };
  }
  const route = { machine: rig, service };
  named.set(request, route);
  dropHeaders(request, [RIG_HEADER, SERVICE_HEADER]);
  return { kind: "named", route };
}

/**
 * Remove every `x-amika-` header but the rig and the service from a
 * request, as the gateway does before it writes those two. For a hop that
 * vouches for the two and nothing else: the dialer, which reaches hostd
 * through `amika-net` (spec 035, `iroh-contracts.md`). Call it before
 * `routeRigService`.
 */
export function dropForeignAmikaHeaders(request: IncomingMessage): void {
  const foreign = Object.keys(request.headers).filter(
    (name) =>
      name.startsWith("x-amika-") &&
      name !== RIG_HEADER &&
      name !== SERVICE_HEADER,
  );
  if (foreign.length > 0) dropHeaders(request, foreign);
}

/**
 * The rig and service the tunnel named `request` for, or undefined for a
 * request it did not: one for this daemon's API, or one that did not come
 * down the tunnel at all.
 */
export function namedRoute(
  request: IncomingMessage | undefined,
): NamedRoute | undefined {
  return request === undefined ? undefined : named.get(request);
}

/** What the tunnel's server read, keyed by the request it read it from. */
const named = new WeakMap<IncomingMessage, NamedRoute>();

/**
 * A rig or service name: one DNS label's worth of letters, digits and
 * hyphens. Both came out of a hostname, and both are routed by, so nothing
 * else may be in them.
 */
const NAME = /^[A-Za-z0-9-]{1,63}$/;

/**
 * Remove `names` from both views of the request's headers.
 *
 * `@hono/node-server` builds its `Request` from `rawHeaders`, and the rest
 * of Node reads `headers`, so a header left in either reaches someone.
 */
function dropHeaders(request: IncomingMessage, names: readonly string[]): void {
  for (const name of names) delete request.headers[name];
  const kept: string[] = [];
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i]!;
    if (names.includes(name.toLowerCase())) continue;
    kept.push(name, request.rawHeaders[i + 1]!);
  }
  request.rawHeaders.splice(0, request.rawHeaders.length, ...kept);
}
