/**
 * The service-link cookie: how a page opened through a service link keeps
 * working once it asks for root-relative URLs.
 *
 * A link serves a service under `/v0beta1/rigs/<rig>/service-links/<name>/
 * <token>/`, but most dev servers (Vite, Next.js) write root-relative URLs
 * into their pages: `/@vite/client`, `/_next/static/...`, `/api/...`. Those
 * reach hostd with no rig, service, or token, so on their own they could only
 * be refused.
 *
 * Opening a link in a browser therefore also sets this cookie, naming the
 * link's rig, service, and token. A request outside hostd's own paths
 * (`isHostdPath`) that carries it is verified exactly as the link would be
 * and forwarded to that service, with its path as the guest path. The cookie
 * grants what the link grants, until the link's own expiry, and is never
 * forwarded to a guest.
 *
 * Only a request the browser marks as the origin's own (`Sec-Fetch-Site:
 * same-origin`, or `none` for one the user started) may use the cookie, and
 * it is never set on a loopback address, whose cookies every local server
 * shares (`linkCookie`, `linkFromCookie`).
 *
 * One host is one origin, so a browser holds one such cookie per host: the
 * link it opened last. A second service opened side by side takes over the
 * root-relative requests of the first. Pages under a link path are
 * unaffected, since their path carries their own token.
 *
 * This leans on a host being one trusted unit: a page from one service can
 * use the cookie the browser holds for another service on the same host,
 * since every request between them is same-origin. Only an origin per
 * preview would isolate them (KAPRO-1038).
 */
import { BlockList, isIP } from "node:net";
import { AMIKAD_SERVICE } from "./services.js";

/**
 * `__Host-` makes the browser insist on `Secure`, `Path=/`, and no `Domain`,
 * so no other host (a sibling subdomain of the tunnel, say) can set or read
 * it.
 */
export const LINK_COOKIE = "__Host-amika-service-link";

/**
 * hostd's other cookies, for previews (`./browser-login.ts`): the signed
 * browser session, the preview whose root-relative URLs a page is asking
 * for, and a login in progress. Like the link cookie, none reaches a guest.
 */
export const SESSION_COOKIE = "__Host-amika-session";
export const PREVIEW_COOKIE = "__Host-amika-preview";
export const LOGIN_STATE_COOKIE = "__Host-amika-login";

const HOSTD_COOKIES: ReadonlySet<string> = new Set([
  LINK_COOKIE,
  SESSION_COOKIE,
  PREVIEW_COOKIE,
  LOGIN_STATE_COOKIE,
]);

/** What the cookie names: a link's rig, service, and token. */
export interface LinkCookieClaim {
  machine: string;
  service: string;
  token: string;
}

/**
 * The `Set-Cookie` value for a link the browser just opened, or null when the
 * request was not a navigation (a script or an image loaded through a link
 * should not change which service owns the root), the link is amikad's, its
 * token carries no usable expiry, or the host was reached on a loopback
 * address or an explicit port: a browser scopes cookies by host, not port,
 * so one set for `localhost:3020` or `preview.example:8443` would go to
 * every other server on that host too, which could replay the token. A
 * tunnel's default HTTPS port (443) leaves no port in the address, and the
 * hostname is then the tunnel's alone.
 *
 * `SameSite=Strict` keeps the cookie off requests other sites start, though
 * a site is a registrable domain, so a sibling subdomain still counts as the
 * same one; `linkFromCookie` therefore also requires the browser's
 * same-origin mark. `HttpOnly`: a guest's script cannot read the token.
 */
export function linkCookie(
  request: Request,
  link: LinkCookieClaim,
  nowS = Math.floor(Date.now() / 1000),
): string | null {
  if (request.headers.get("sec-fetch-mode") !== "navigate") return null;
  if (link.service === AMIKAD_SERVICE) return null;
  const { hostname, port } = new URL(request.url);
  if (isLoopbackHost(hostname) || port !== "") return null;
  const maxAge = Number(link.token.split(".")[0]) - nowS;
  if (!Number.isSafeInteger(maxAge) || maxAge <= 0) return null;
  const value = `${link.machine}/${encodeURIComponent(link.service)}/${link.token}`;
  return `${LINK_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

/**
 * The link a request's `Cookie` header names, or null when it names none or
 * one that cannot be read, or the request is not the origin's own:
 * `fetchSite` (its `Sec-Fetch-Site`) must be `same-origin`, or `none` for a
 * navigation the user started (an address typed, a bookmark, a reload). A
 * page on another origin, even a sibling subdomain the cookie's `SameSite`
 * lets through, cannot drive a preview's routes. Only parsed here; the
 * caller verifies the token. amikad is never reached this way.
 */
export function linkFromCookie(
  cookieHeader: string | null | undefined,
  fetchSite: string | string[] | null | undefined,
): LinkCookieClaim | null {
  if (fetchSite !== "same-origin" && fetchSite !== "none") return null;
  const value = cookieValues(cookieHeader).get(LINK_COOKIE);
  const match =
    value && /^([a-zA-Z0-9][a-zA-Z0-9_-]*)\/([^/]+)\/([^/]+)$/.exec(value);
  if (!match) return null;
  let service: string;
  try {
    service = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  if (service === AMIKAD_SERVICE) return null;
  return { machine: match[1], service, token: match[3] };
}

/**
 * `cookieHeader` without hostd's own cookies, or null when nothing else is
 * left: they are hostd's credentials and state, so a guest never sees them.
 */
export function withoutHostdCookies(
  cookieHeader: string | null | undefined,
): string | null {
  const kept = (cookieHeader ?? "")
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair && !HOSTD_COOKIES.has(pair.split("=")[0].trim()));
  return kept.length ? kept.join("; ") : null;
}

/** Whether `cookieHeader` may carry one of hostd's own cookies. */
export function mayHoldHostdCookie(cookieHeader: string): boolean {
  return cookieHeader.includes("__Host-amika-");
}

/**
 * Whether `pathname` is hostd's own, never a guest's through the cookie: the
 * versioned API (`/v0beta1/...`, every rig, service, link, and preview
 * route), the legacy machine API, `/health`, and the browser login pages
 * under `/__amika/`. Everything else on the host belongs to
 * the service the cookie names.
 */
export function isHostdPath(pathname: string): boolean {
  return (
    pathname === "/health" ||
    pathname === "/__amika" ||
    pathname.startsWith("/__amika/") ||
    pathname === "/v0beta1" ||
    pathname.startsWith("/v0beta1/") ||
    pathname === "/api/v1/machines" ||
    pathname.startsWith("/api/v1/machines/")
  );
}

/**
 * Whether `hostname` (as `URL.hostname` spells it) reaches this machine,
 * where every local server shares one cookie jar: `localhost` and its
 * subdomains, or an address in `LOCAL_ADDRESSES`. The URL parser already
 * turns odd IPv4 spellings (`0x7f.1`, `2130706433`) into dotted ones, and
 * `BlockList` matches an IPv4-mapped IPv6 address (`[::ffff:7f00:1]`)
 * against the IPv4 rules.
 */
export function isLoopbackHost(hostname: string): boolean {
  const name = hostname.replace(/\.$/, "").toLowerCase();
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  const address = name.replace(/^\[(.*)\]$/, "$1");
  const family = isIP(address);
  return (
    family !== 0 &&
    LOCAL_ADDRESSES.check(address, family === 6 ? "ipv6" : "ipv4")
  );
}

/**
 * Loopback, and the unspecified addresses, which reach this machine too on
 * Linux and macOS.
 */
const LOCAL_ADDRESSES = new BlockList();
LOCAL_ADDRESSES.addSubnet("127.0.0.0", 8, "ipv4");
LOCAL_ADDRESSES.addAddress("0.0.0.0", "ipv4");
LOCAL_ADDRESSES.addAddress("::1", "ipv6");
LOCAL_ADDRESSES.addAddress("::", "ipv6");

export function cookieValues(cookieHeader: string | null | undefined) {
  const values = new Map<string, string>();
  for (const pair of (cookieHeader ?? "").split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    // The first one wins, as browsers send the most specific first.
    if (!values.has(name)) values.set(name, pair.slice(eq + 1).trim());
  }
  return values;
}
