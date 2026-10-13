/**
 * Browser login and previews (KAPRO-1038), hostd's side. The flow and the
 * credentials are described in `@amika/sandbox/hostd-browser-login`.
 *
 * - `GET /__amika/login?return=<path>` (`startLogin`) remembers a random
 *   state and the path to return to in `__Host-amika-login`, then sends the
 *   browser to Amika's authorize page, naming this host's origin.
 * - `POST /__amika/callback` (`finishLogin`) takes the login pass Amika posts
 *   back, checks it against that state, and sets the session cookie,
 *   `__Host-amika-session`, before returning to the path.
 * - `/v0beta1/rigs/<rig>/previews/<name>/<path>` (`parsePreviewPath`) serves
 *   a service to a browser with a session. Without one, a page load is sent
 *   to log in; anything else is refused.
 * - Opening a preview also sets `__Host-amika-preview`, naming its rig and
 *   service but no credential, so the page's root-relative URLs reach the
 *   same service, as the link cookie does for links (`./link-cookie.ts`).
 *   They need the session too.
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
  LOGIN_PATH,
  PREVIEWS_SEGMENT,
  SESSION_TTL_S,
  STATE_PATTERN,
  signSession,
  verifyLoginPass,
  verifySession,
} from "@amika/sandbox/hostd-browser-login";
import {
  LOGIN_STATE_COOKIE,
  PREVIEW_COOKIE,
  SESSION_COOKIE,
  cookieValues,
  isLoopbackHost,
} from "./link-cookie.js";
import { AMIKAD_SERVICE, type ServiceRoute } from "./services.js";

export { CALLBACK_PATH, LOGIN_PATH };

/** How long a login may take, from leaving for Amika to coming back. */
const LOGIN_STATE_TTL_S = 10 * 60;

/** Longer return paths are dropped rather than carried through a cookie. */
const MAX_RETURN_PATH_LENGTH = 2048;

/**
 * The origin a browser reached this host at, as Amika knows it (its
 * registered URL), or null where hostd sets no cookies: a loopback address
 * or an explicit port. hostd itself listens on plain http behind the
 * tunnel, so the scheme is always https.
 */
export function browserOrigin(url: URL): string | null {
  if (url.port !== "" || isLoopbackHost(url.hostname)) return null;
  return `https://${url.hostname}`;
}

/** Send a browser that wants `url` to log in, returning to it after. */
export function loginRedirect(url: URL): Response {
  const back = `${url.pathname}${url.search}`;
  return noStore(
    new Response(null, {
      status: 302,
      headers: {
        Location: `${LOGIN_PATH}?${new URLSearchParams({ return: back })}`,
      },
    }),
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
            "Browser login needs the host's own https address, without a port; open the rig's service link instead",
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

/** Login states already answered, kept until their passes have expired. */
export function usedLoginStates(ttlMs = LOGIN_STATE_TTL_S * 1000) {
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
  const origin = browserOrigin(url);
  const token = cookieValues(cookieHeader).get(SESSION_COOKIE);
  if (!origin || !token) return false;
  const session = await verifySession(secretKey, token, { origin }, nowS);
  return typeof session !== "string";
}

/**
 * Split a preview path into its route, or null if it is not one. As in
 * `parseServicePath`, the service name is decoded and the guest path kept
 * encoded. amikad has no preview.
 */
export function parsePreviewPath(pathname: string): ServiceRoute | null {
  const match = new RegExp(
    `^/v0beta1/rigs/([a-zA-Z0-9][a-zA-Z0-9_-]*)/${PREVIEWS_SEGMENT}/([^/]+)(/.*)?$`,
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
 * The `Set-Cookie` value naming the preview a browser just opened, or null
 * for anything but a page load (a script or image loaded through a preview
 * must not change which service owns the root) or where hostd sets no
 * cookies. It names no credential: requests it routes need the session too.
 */
export function previewCookie(
  request: Request,
  route: Pick<ServiceRoute, "machine" | "service">,
): string | null {
  if (request.headers.get("sec-fetch-mode") !== "navigate") return null;
  if (!browserOrigin(new URL(request.url))) return null;
  const value = `${route.machine}/${encodeURIComponent(route.service)}`;
  return `${PREVIEW_COOKIE}=${value}; Path=/; Max-Age=${SESSION_TTL_S}; HttpOnly; Secure; SameSite=Strict`;
}

/**
 * The preview a request's cookie names, or null when it names none, or the
 * request is not the origin's own (`Sec-Fetch-Site: same-origin`, or `none`
 * for one the user started), as for the link cookie.
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
  if (service === AMIKAD_SERVICE) return null;
  return { machine: match[1], service };
}

/**
 * Headers for every response on a preview. The URL carries no credential,
 * so unlike a link's this lets the guest's own caching through, but always
 * `private` (a shared cache must not keep a logged-in page), keeps search
 * engines out, and keeps a service worker inside its own preview.
 */
export function hardenPreviewResponse(response: Response): Response {
  const headers = response.headers;
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

/** A path on this host to return to after login: never another origin. */
function returnPath(value: string | null): string {
  if (
    !value ||
    value.length > MAX_RETURN_PATH_LENGTH ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.startsWith(LOGIN_PATH) ||
    value.startsWith(CALLBACK_PATH)
  ) {
    return "/";
  }
  return value;
}

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
