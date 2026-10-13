/**
 * Browser login for amika-hostd previews (KAPRO-1038): a preview URL is only
 * an address, and the browser proves who it is with a cookie hostd set after
 * Amika vouched for the user.
 *
 *   /v0beta1/rigs/<rig>/previews/<name>/<path>
 *
 * 1. A browser with no session opens a preview. hostd remembers a random
 *    `state` in a short-lived cookie and redirects to Amika's authorize page,
 *    naming its own origin (`LOGIN_PATH`).
 * 2. Amika checks the user is signed in and that one of their org's hosts is
 *    registered at that origin, then posts a login pass to that host's
 *    registered URL (`CALLBACK_PATH`): a form submission, so the pass never
 *    lands in a URL. The pass names the origin, the state and the user, and
 *    lives `LOGIN_PASS_TTL_S`.
 * 3. hostd verifies the pass with a key derived from its secret key (no call
 *    to Amika), checks the state against its cookie, and sets a session
 *    cookie for `SESSION_TTL_S`, signed under another derived key.
 *
 * A session covers every preview on the host: a host is one trusted unit.
 * Regenerating the host's secret key ends every session and pass at once.
 *
 * Cookies need a hostname of the host's own at the root of an https origin
 * on the default port (`isBrowserLoginOrigin`): on a loopback address or an
 * explicit port every other local server would receive them. Hosts reached
 * any other way keep signed service links.
 *
 * Only Web Crypto is used, so this runs wherever the provider does.
 */
import {
  fromBase64Url,
  signText,
  toBase64Url,
  verifyText,
} from "./internal/signing";

/** The hostd feature, in `GET /health`'s `features`, that serves previews. */
export const BROWSER_LOGIN_FEATURE = "browser-login";

/** The path segment that marks a preview route. */
export const PREVIEWS_SEGMENT = "previews";

/** Where hostd starts a login, and where Amika posts the pass. */
export const LOGIN_PATH = "/__amika/login";
export const CALLBACK_PATH = "/__amika/callback";

/** How long a login pass lives: long enough for one redirect. */
export const LOGIN_PASS_TTL_S = 60;

/** How long a browser session lives. */
export const SESSION_TTL_S = 24 * 60 * 60;

/** How far apart Amika's and hostd's clocks may be. */
const CLOCK_SKEW_S = 5 * 60;

const PASS_KEY_LABEL = "amika-hostd login passes v1";
const SESSION_KEY_LABEL = "amika-hostd sessions v1";

/** The random value tying a pass to the browser that asked for it. */
export const STATE_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;

/** No credential here needs more; refusing longer bounds the work. */
const MAX_TOKEN_LENGTH = 2048;

/** Why a pass or session is refused. */
export type CredentialProblem = "malformed" | "invalid" | "expired";

/**
 * A login pass for `user` to log in at `origin`, answering the login that
 * `state` started. Amika signs it; only the host whose secret key it holds
 * can verify it.
 */
export async function signLoginPass(
  secretKey: string,
  { origin, state, user }: { origin: string; state: string; user: string },
  nowS = Math.floor(Date.now() / 1000),
): Promise<string> {
  if (!STATE_PATTERN.test(state)) throw new Error("Invalid login state");
  return signPayload(PASS_KEY_LABEL, secretKey, {
    o: origin,
    s: state,
    u: user,
    e: nowS + LOGIN_PASS_TTL_S,
  });
}

/**
 * The user a login pass vouches for, or why it is refused: not for `origin`,
 * not answering `state`, expired, or claiming a longer life than any pass
 * gets.
 */
export async function verifyLoginPass(
  secretKey: string,
  token: string,
  { origin, state }: { origin: string; state: string },
  nowS: number,
): Promise<{ user: string } | CredentialProblem> {
  const payload = await verifyPayload(PASS_KEY_LABEL, secretKey, token);
  if (typeof payload === "string") return payload;
  if (payload.o !== origin || payload.s !== state) return "invalid";
  if (payload.e - nowS > LOGIN_PASS_TTL_S + CLOCK_SKEW_S) return "invalid";
  if (payload.e <= nowS) return "expired";
  return { user: payload.u };
}

/** A session cookie value for `user` at `origin`, as hostd sets it. */
export async function signSession(
  secretKey: string,
  { origin, user }: { origin: string; user: string },
  nowS = Math.floor(Date.now() / 1000),
): Promise<string> {
  return signPayload(SESSION_KEY_LABEL, secretKey, {
    o: origin,
    u: user,
    e: nowS + SESSION_TTL_S,
  });
}

/** The user a session vouches for at `origin`, or why it is refused. */
export async function verifySession(
  secretKey: string,
  token: string,
  { origin }: { origin: string },
  nowS: number,
): Promise<{ user: string; expiresAt: number } | CredentialProblem> {
  const payload = await verifyPayload(SESSION_KEY_LABEL, secretKey, token);
  if (typeof payload === "string") return payload;
  if (payload.o !== origin) return "invalid";
  if (payload.e - nowS > SESSION_TTL_S + CLOCK_SKEW_S) return "invalid";
  if (payload.e <= nowS) return "expired";
  return { user: payload.u, expiresAt: payload.e };
}

/**
 * The path of a preview, ending in `/` so the service's relative URLs
 * resolve under it. The rig name is a hostd machine name (URL-safe); the
 * service name is percent-encoded as one segment.
 */
export function previewPath(
  rigsPath: string,
  rig: string,
  service: string,
): string {
  return `${rigsPath}/${rig}/${PREVIEWS_SEGMENT}/${encodeURIComponent(service)}/`;
}

/**
 * Whether a host registered at `url` can log browsers in: https, the default
 * port, no path, and a hostname that is not this machine's own (`localhost`,
 * loopback and unspecified addresses, including IPv4-mapped ones). The URL
 * parser has already turned odd IPv4 spellings into dotted ones.
 */
export function isBrowserLoginOrigin(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.port !== "" ||
    parsed.pathname !== "/" ||
    parsed.username ||
    parsed.password
  ) {
    return false;
  }
  const host = parsed.hostname.replace(/\.$/, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return !host.startsWith("127.") && host !== "0.0.0.0";
  }
  if (host.startsWith("[")) {
    const address = host.slice(1, -1);
    return !(
      address === "::1" ||
      address === "::" ||
      // IPv4-mapped loopback or unspecified: `::ffff:7f00:1`, `::ffff:0:0`.
      /^::ffff:(7f[0-9a-f]{2}:[0-9a-f]{1,4}|0:0)$/.test(address)
    );
  }
  return true;
}

interface Payload {
  /** The origin the credential is for. */
  o: string;
  /** A pass's login state. */
  s?: string;
  /** The user's Amika id. */
  u: string;
  /** Expiry, Unix seconds. */
  e: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function signPayload(
  label: string,
  secretKey: string,
  payload: Payload,
): Promise<string> {
  const encoded = toBase64Url(encoder.encode(JSON.stringify(payload)));
  return `${encoded}.${await signText(label, secretKey, encoded)}`;
}

async function verifyPayload(
  label: string,
  secretKey: string,
  token: string,
): Promise<Payload | "malformed" | "invalid"> {
  const dot = token.indexOf(".");
  if (dot <= 0 || token.length > MAX_TOKEN_LENGTH) return "malformed";
  const encoded = token.slice(0, dot);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return "malformed";
  // The signature first, so a forged token is told nothing about its content.
  const problem = await verifyText(
    label,
    secretKey,
    encoded,
    token.slice(dot + 1),
  );
  if (problem) return problem;
  let payload: unknown;
  try {
    payload = JSON.parse(decoder.decode(fromBase64Url(encoded)));
  } catch {
    return "malformed";
  }
  const { o, s, u, e } = (payload ?? {}) as Record<string, unknown>;
  if (
    typeof o !== "string" ||
    typeof u !== "string" ||
    (s !== undefined && typeof s !== "string") ||
    !Number.isSafeInteger(e)
  ) {
    return "malformed";
  }
  return { o, s, u, e: e as number };
}
