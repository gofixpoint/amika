/**
 * Browser login and previews (KAPRO-1038), the gateway's side. The flow and
 * the credentials are described in `../credentials/browser-login.ts`.
 *
 * - `GET /__amika/login?return=<path>` (`startLogin`) remembers a random
 *   state and the path to return to in `__Host-amika-login`, then sends the
 *   browser to Amika's authorize page, naming this host's origin.
 * - `POST /__amika/callback` (`finishLogin`) takes the login pass Amika posts
 *   back, checks it against that state, and sets the session cookie,
 *   `__Host-amika-session`, before returning to the path.
 * - `/v0beta1/rigs/<rig>/previews/<name>/<path>` (`parsePreviewPath`) serves
 *   a service to a browser with a session. Without one, a page load (of the
 *   preview, or a root-relative URL its cookie routes) is sent to log in and
 *   back to the same path; anything else is refused.
 * - Opening a preview also sets `__Host-amika-preview`, naming its rig and
 *   service but no credential, so the page's root-relative URLs reach the
 *   same service (`./cookies.ts`). They need the session too.
 *
 * Every cookie is `__Host-` (Secure, `Path=/`, no `Domain`) and none is set
 * on a loopback address or an explicit port (`browserOrigin`), where every
 * other local server would receive it. The session is `SameSite=Lax`, so a
 * preview opened from Amika (another site) carries it; `Strict` would send
 * every such click back to log in. The login state is `SameSite=None`: it
 * has to come back on Amika's cross-site form post, and holds nothing but a
 * random value and a path.
 */
import { randomBytes } from "node:crypto";
import {
  CALLBACK_PATH,
  LOGIN_PASS_REPLAY_WINDOW_S,
  LOGIN_PATH,
  PREVIEWS_SEGMENT,
  SESSION_TTL_S,
  STATE_PATTERN,
  previewPath,
  signSession,
  verifyLoginPass,
  verifySession,
} from "../credentials";
import {
  LINK_COOKIE,
  LOGIN_STATE_COOKIE,
  PREVIEW_COOKIE,
  SESSION_COOKIE,
  cookieValues,
  expiredCookie,
  isLoopbackHost,
} from "./cookies";
import { dropCdnCachePolicies } from "./responses";
import {
  AMIKAD_SERVICE,
  type GatewayRequest,
  type ServiceRoute,
} from "./routes";

export { CALLBACK_PATH, LOGIN_PATH };

/** How long a login may take, from leaving for Amika to coming back. */
const LOGIN_STATE_TTL_S = 10 * 60;

/** Longer return paths are dropped rather than carried through a cookie. */
const MAX_RETURN_PATH_LENGTH = 2048;

/**
 * The origin a browser reached this host at, as Amika knows it (its
 * registered URL), or null where the gateway sets no cookies: a loopback
 * address or an explicit port. The server listens on plain http behind the
 * tunnel, so the scheme is always https.
 */
export function browserOrigin(url: URL): string | null {
  if (url.port !== "" || isLoopbackHost(url.hostname)) return null;
  return `https://${url.hostname}`;
}

/**
 * Where to send a browser that wants `url` to log in, returning after. A
 * root-relative URL the preview cookie routes (`cookieRoute`) returns
 * through the preview's own path instead: the login's last redirect comes
 * from Amika's site, so the `Strict` preview cookie is not sent on it, and
 * opening the preview again renews that cookie.
 */
export function loginLocation(
  url: URL,
  cookieRoute?: Pick<ServiceRoute, "machine" | "service">,
): string {
  const path = cookieRoute
    ? `${previewPath(RIGS_PATH, cookieRoute.machine, cookieRoute.service)}${url.pathname.slice(1)}`
    : url.pathname;
  const back = `${path}${url.search}`;
  return `${LOGIN_PATH}?${new URLSearchParams({ return: back })}`;
}

const RIGS_PATH = "/v0beta1/rigs";

/** The redirect to `location`, which no cache keeps. */
export function loginRedirect(location: string): Response {
  return noStore(
    new Response(null, { status: 302, headers: { Location: location } }),
  );
}

/**
 * `GET /__amika/login`: send the browser to Amika's authorize page for this
 * host, remembering where to return. Amika answers by posting a pass to
 * this host's registered URL, never to a URL the request names.
 */
export function startLogin(request: Request, amikaUrl: string): Response {
  const url = new URL(request.url);
  const origin = browserOrigin(url);
  if (!origin) {
    return noStore(
      Response.json(
        {
          error:
            "Previews need this host's own https address, without a port. Register one with `amika-hostd register-url <https-url>`, and upgrade amika-hostd if it is out of date.",
        },
        { status: 400 },
      ),
    );
  }
  const back = returnPath(url.searchParams.get("return"));
  const state = randomBytes(32).toString("base64url");
  const value = `${state}.${Buffer.from(back).toString("base64url")}`;
  const authorize = new URL(
    "hosts/authorize",
    amikaUrl.endsWith("/") ? amikaUrl : `${amikaUrl}/`,
  );
  authorize.search = new URLSearchParams({ origin, state }).toString();
  return noStore(
    new Response(null, {
      status: 302,
      headers: {
        Location: authorize.toString(),
        "Set-Cookie": `${LOGIN_STATE_COOKIE}=${value}; Path=/; Max-Age=${LOGIN_STATE_TTL_S}; HttpOnly; Secure; SameSite=None`,
      },
    }),
  );
}

/**
 * Login states already answered, kept until their passes have expired:
 * a pass verifies for at most `LOGIN_PASS_REPLAY_WINDOW_S` after it is
 * first used. Kept in memory, so a restart forgets them; a replay then
 * still needs both the pass and the browser's state cookie.
 */
export function usedLoginStates(ttlMs = LOGIN_PASS_REPLAY_WINDOW_S * 1000) {
  const used = new Map<string, number>();
  return {
    /** Record `state`; false if it was already used. */
    claim(state: string, nowMs = Date.now()): boolean {
      for (const [seen, until] of used) {
        if (until <= nowMs) used.delete(seen);
      }
      if (used.has(state)) return false;
      used.set(state, nowMs + ttlMs);
      return true;
    },
  };
}

export type UsedLoginStates = ReturnType<typeof usedLoginStates>;

/**
 * `POST /__amika/callback`: check the pass Amika posted against the login
 * this browser started, then set the session and return to the path it
 * wanted. A pass answers one login, once.
 */
export async function finishLogin(
  request: Request,
  secretKey: string,
  used: UsedLoginStates,
  nowS = Math.floor(Date.now() / 1000),
): Promise<Response> {
  const origin = browserOrigin(new URL(request.url));
  const login = parseLoginState(
    cookieValues(request.headers.get("cookie")).get(LOGIN_STATE_COOKIE),
  );
  const form = await request.formData().catch(() => null);
  const pass = form?.get("pass");
  if (!origin || !login || typeof pass !== "string") {
    return loginFailed();
  }
  const vouched = await verifyLoginPass(
    secretKey,
    pass,
    { origin, state: login.state },
    nowS,
  );
  if (typeof vouched === "string" || !used.claim(login.state)) {
    return loginFailed();
  }
  const session = await signSession(
    secretKey,
    { origin, user: vouched.user },
    nowS,
  );
  const headers = new Headers({ Location: login.back });
  headers.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=${session}; Path=/; Max-Age=${SESSION_TTL_S}; HttpOnly; Secure; SameSite=Lax`,
  );
  headers.append(
    "Set-Cookie",
    `${LOGIN_STATE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None`,
  );
  return noStore(new Response(null, { status: 303, headers }));
}

/** Whether the request carries a live session for the origin it reached. */
export async function hasSession(
  cookieHeader: string | null | undefined,
  url: URL,
  secretKey: string,
  nowS = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  return (await sessionUser(cookieHeader, url, secretKey, nowS)) !== null;
}

/**
 * The user the request's session cookie vouches for at `url`'s origin, or
 * null without a session: no cookie, a cookie for another origin, or an
 * expired one.
 */
export async function sessionUser(
  cookieHeader: string | null | undefined,
  url: URL,
  secretKey: string,
  nowS = Math.floor(Date.now() / 1000),
): Promise<string | null> {
  const origin = browserOrigin(url);
  const token = cookieValues(cookieHeader).get(SESSION_COOKIE);
  if (!origin || !token) return null;
  const session = await verifySession(secretKey, token, { origin }, nowS);
  return typeof session === "string" ? null : session.user;
}

/**
 * Split a preview path into its route, or null if it is not one. As in
 * `parseServicePath`, the service name is decoded and the guest path kept
 * encoded. amikad has no preview.
 */
export function parsePreviewPath(pathname: string): ServiceRoute | null {
  const match = new RegExp(
    `^${RIGS_PATH}/([a-zA-Z0-9][a-zA-Z0-9_-]*)/${PREVIEWS_SEGMENT}/([^/]+)(/.*)?$`,
  ).exec(pathname);
  if (!match) return null;
  let service: string;
  try {
    service = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  if (service === AMIKAD_SERVICE) return null;
  return { machine: match[1], service, path: match[3] ?? "/" };
}

/**
 * The `Set-Cookie` values for the preview a browser just opened: its cookie,
 * so the preview opened last owns the root, and the end of any retired link
 * cookie (`LINK_COOKIE`).
 * None for anything but a page load (a script or image loaded through a
 * preview must not change which service owns the root) or where the gateway
 * sets no cookies. The cookie names no credential: requests it routes need
 * the session too.
 */
export function previewCookies(
  request: Pick<GatewayRequest, "url" | "headers">,
  route: Pick<ServiceRoute, "machine" | "service">,
): string[] {
  if (request.headers.get("sec-fetch-mode") !== "navigate") return [];
  if (!browserOrigin(request.url)) return [];
  const value = `${route.machine}/${encodeURIComponent(route.service)}`;
  return [
    `${PREVIEW_COOKIE}=${value}; Path=/; Max-Age=${SESSION_TTL_S}; HttpOnly; Secure; SameSite=Strict`,
    expiredCookie(LINK_COOKIE),
  ];
}

/**
 * Whether a preview request is this origin's own, or a page load another
 * site may start (a preview opened from Amika). The session is
 * `SameSite=Lax`, which a sibling subdomain counts as the same site, so
 * without this a page there could post to a preview with the session, or
 * open its WebSocket and read it (no CORS covers a WebSocket). An upgrade
 * must name this origin in `Origin`, which browsers always send on one.
 * A browser too old to send `Sec-Fetch-Site` gets page loads only.
 */
export function isOwnOrPageLoad(
  request: GatewayRequest,
  { upgrade }: { upgrade: boolean },
): boolean {
  const { method, url, headers } = request;
  if (upgrade) {
    const origin = browserOrigin(url);
    return origin !== null && headers.get("origin") === origin;
  }
  const site = headers.get("sec-fetch-site");
  if (site === "same-origin" || site === "none") return true;
  return (
    headers.get("sec-fetch-mode") === "navigate" &&
    (method === "GET" || method === "HEAD")
  );
}

/**
 * The preview a request's cookie names, or null when it names none, or the
 * request is not the origin's own (`Sec-Fetch-Site: same-origin`, or `none`
 * for one the user started): a page on another origin, even a sibling
 * subdomain the cookie's `SameSite` lets through, cannot drive a preview's
 * routes.
 */
export function previewFromCookie(
  cookieHeader: string | null | undefined,
  fetchSite: string | string[] | null | undefined,
): Pick<ServiceRoute, "machine" | "service"> | null {
  if (fetchSite !== "same-origin" && fetchSite !== "none") return null;
  const value = cookieValues(cookieHeader).get(PREVIEW_COOKIE);
  const match = value && /^([a-zA-Z0-9][a-zA-Z0-9_-]*)\/([^/]+)$/.exec(value);
  if (!match) return null;
  let service: string;
  try {
    service = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  if (service === AMIKAD_SERVICE || /^\.{0,2}$/.test(service)) return null;
  return { machine: match[1], service };
}

/**
 * Headers for every response on a preview. The URL carries no credential,
 * so this lets the guest's own caching through, but always
 * `private` (a shared cache must not keep a logged-in page), keeps search
 * engines out, and keeps a service worker inside its own preview.
 */
export function hardenPreviewResponse(response: Response): Response {
  const headers = response.headers;
  dropCdnCachePolicies(headers);
  headers.delete("service-worker-allowed");
  headers.set(
    "cache-control",
    privateCacheControl(headers.get("cache-control")),
  );
  headers.set("x-robots-tag", "noindex");
  return response;
}

/**
 * `value` made `private`: `public` becomes `private`, and a policy naming
 * neither (nor `no-store`) gains it. No policy at all becomes `private`.
 */
export function privateCacheControl(value: string | null): string {
  if (!value?.trim()) return "private";
  if (/\bpublic\b/i.test(value))
    return value.replace(/\bpublic\b/gi, "private");
  if (/\b(private|no-store)\b/i.test(value)) return value;
  return `private, ${value}`;
}

/**
 * A path on this host to return to after login: never another origin. The
 * value is resolved as a browser would resolve `Location`, which drops tabs
 * and newlines and reads `\` as `/`, so `/\t/evil.example` cannot slip
 * through as `//evil.example`; what comes back is the resolved path and
 * query, percent-encoded. That result is checked too, as dot segments
 * collapse only once resolved: `/..//evil.example` resolves within the
 * origin to the path `//evil.example`, which a browser would not. Its
 * length is bounded encoded, as it is carried in a cookie.
 */
function returnPath(value: string | null): string {
  if (!value?.startsWith("/") || value.length > MAX_RETURN_PATH_LENGTH) {
    return "/";
  }
  let resolved: URL;
  try {
    resolved = new URL(value, RETURN_BASE);
  } catch {
    return "/";
  }
  const back = `${resolved.pathname}${resolved.search}`;
  if (
    resolved.origin !== RETURN_BASE ||
    back.startsWith("//") ||
    back.length > MAX_RETURN_PATH_LENGTH ||
    back.startsWith(LOGIN_PATH) ||
    back.startsWith(CALLBACK_PATH)
  ) {
    return "/";
  }
  return back;
}

/** Any origin but a real one: only a path resolving within it returns. */
const RETURN_BASE = "https://return.invalid";

function parseLoginState(
  value: string | undefined,
): { state: string; back: string } | null {
  const dot = value?.indexOf(".") ?? -1;
  if (!value || dot < 0) return null;
  const state = value.slice(0, dot);
  if (!STATE_PATTERN.test(state)) return null;
  const back = returnPath(
    Buffer.from(value.slice(dot + 1), "base64url").toString("utf8"),
  );
  return { state, back };
}

function loginFailed(): Response {
  return noStore(
    new Response(
      "Login failed or expired. Open the preview again to retry.\n",
      { status: 401, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    ),
  );
}

function noStore(response: Response): Response {
  response.headers.set("cache-control", "no-store");
  return response;
}
