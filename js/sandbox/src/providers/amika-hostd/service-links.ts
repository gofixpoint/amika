/**
 * Signed service links: browser-usable URLs for an amika-hostd rig's services.
 *
 * hostd routes `/v0beta1/rigs/<rig>/services/<name>/...` only for callers that
 * present the host's secret key in a header, which a browser navigation cannot
 * send and which must never reach a browser anyway. A service link carries a
 * credential in its path instead:
 *
 *   /v0beta1/rigs/<rig>/service-links/<name>/<expiry>.<signature>/<guest path>
 *
 * `<expiry>` is a Unix time in seconds and `<signature>` is the base64url
 * HMAC-SHA256 of `v1\n<rig>\n<name>\n<expiry>` under a link key derived from
 * the host's secret key. The provider (which holds the secret key on the
 * control plane) signs links and hostd verifies them, each deriving the link
 * key itself, so nothing new is shared and no request reaches the control
 * plane. Regenerating the host's secret key invalidates every link.
 *
 * The signed text is unambiguous: a rig name has no newline and an expiry is
 * digits only, so a service name containing newlines cannot be read as a
 * different rig, name or expiry.
 *
 * Every link on a host shares the host's one origin, so links isolate
 * services only as far as paths can: cookies and storage are shared, and a
 * service's root-relative URLs (`/assets/app.js`) leave its link. hostd sends
 * those to the link the browser opened last, which it records in a cookie
 * (amika-hostd's `link-cookie.ts`). hostd strips `Service-Worker-Allowed`
 * from link responses, so a service worker a page registers is confined to
 * its own link. One origin per service would need wildcard DNS for each host.
 *
 * Service tokens are the same claim signed under a second derived key, for
 * callers that are not browsers: `curl -H "X-Amika-Authorization: Bearer
 * <token>"` against the service route `/v0beta1/rigs/<rig>/services/<name>/`,
 * whose URL carries no credential. The keys differ so a link's token never
 * works as a header token, nor the other way round. A token lives at most
 * `MAX_SERVICE_TOKEN_TTL_S`, which hostd enforces too.
 *
 * Only Web Crypto is used, so this runs wherever the provider does.
 */

import { signText, verifyText } from "./internal/signing";

/** The path segment that marks a service-link route. */
export const SERVICE_LINKS_SEGMENT = "service-links";

/** Separates a link key from any other use of the host's secret key. */
const LINK_KEY_LABEL = "amika-hostd service links v1";

/** Separates a service-token key from any other use of the host's secret key. */
const TOKEN_KEY_LABEL = "amika-hostd service tokens v1";

/**
 * Carries a service token on a service route. hostd removes it before
 * forwarding, so the guest's own `Authorization` stays its own.
 */
export const SERVICE_TOKEN_HEADER = "X-Amika-Authorization";

/** How long a service token lives when the caller does not say. */
export const DEFAULT_SERVICE_TOKEN_TTL_S = 60 * 60;

/** The longest a service token may live: a day, as a browser session does. */
export const MAX_SERVICE_TOKEN_TTL_S = 24 * 60 * 60;

/**
 * How far ahead of hostd's clock a token's issuer may be. A token that claims
 * to live longer than `MAX_SERVICE_TOKEN_TTL_S` plus this is refused.
 */
const CLOCK_SKEW_S = 5 * 60;

/** Unix seconds, at most 12 digits: a millisecond time is refused. */
const EXPIRY_PATTERN = /^[1-9][0-9]{0,11}$/;
const MAX_EXPIRY = 10 ** 12 - 1;

/** What a service link grants: one service of one rig, until `expiresAt`. */
export interface ServiceLinkClaim {
  rig: string;
  service: string;
  /** Unix time in seconds after which the link is refused. */
  expiresAt: number;
}

/**
 * The `<expiry>.<signature>` token for `claim`, as it appears in the link's
 * path.
 */
export function signServiceLink(
  secretKey: string,
  claim: ServiceLinkClaim,
): Promise<string> {
  return sign(LINK_KEY_LABEL, secretKey, claim);
}

/**
 * Why `token` does not grant `rig`'s `service` at `nowS` (Unix seconds), or
 * null when it does. The signature is checked in constant time before the
 * expiry, so a forged token is told nothing about its expiry.
 */
export function verifyServiceLink(
  secretKey: string,
  link: { rig: string; service: string; token: string },
  nowS: number,
): Promise<"malformed" | "invalid" | "expired" | null> {
  return verify(LINK_KEY_LABEL, secretKey, link, nowS);
}

/**
 * A service token granting `rig`'s `service` until `nowS + ttlS`, for the
 * `X-Amika-Authorization` header. Throws for a lifetime that is not a whole
 * number of seconds between 1 and `MAX_SERVICE_TOKEN_TTL_S`.
 */
export async function signServiceToken(
  secretKey: string,
  { rig, service }: { rig: string; service: string },
  {
    ttlS = DEFAULT_SERVICE_TOKEN_TTL_S,
    nowS = Math.floor(Date.now() / 1000),
  }: { ttlS?: number; nowS?: number } = {},
): Promise<string> {
  if (
    !Number.isSafeInteger(ttlS) ||
    ttlS <= 0 ||
    ttlS > MAX_SERVICE_TOKEN_TTL_S
  ) {
    throw new Error(
      `A service token's lifetime must be 1 to ${MAX_SERVICE_TOKEN_TTL_S} seconds`,
    );
  }
  return sign(TOKEN_KEY_LABEL, secretKey, {
    rig,
    service,
    expiresAt: nowS + ttlS,
  });
}

/**
 * As `verifyServiceLink`, for a service token, which is also refused when it
 * claims to live longer than `MAX_SERVICE_TOKEN_TTL_S` (give or take clock
 * skew): only a buggy or compromised issuer mints one.
 */
export async function verifyServiceToken(
  secretKey: string,
  token: { rig: string; service: string; token: string },
  nowS: number,
): Promise<"malformed" | "invalid" | "expired" | null> {
  const problem = await verify(TOKEN_KEY_LABEL, secretKey, token, nowS);
  if (problem) return problem;
  const expiresAt = Number(token.token.slice(0, token.token.indexOf(".")));
  return expiresAt - nowS > MAX_SERVICE_TOKEN_TTL_S + CLOCK_SKEW_S
    ? "invalid"
    : null;
}

async function sign(
  label: string,
  secretKey: string,
  claim: ServiceLinkClaim,
): Promise<string> {
  if (
    !Number.isSafeInteger(claim.expiresAt) ||
    claim.expiresAt <= 0 ||
    claim.expiresAt > MAX_EXPIRY
  ) {
    throw new Error(
      "A service link or token's expiry must be a positive Unix time in seconds",
    );
  }
  return `${claim.expiresAt}.${await signText(label, secretKey, signedText(claim))}`;
}

async function verify(
  label: string,
  secretKey: string,
  { rig, service, token }: { rig: string; service: string; token: string },
  nowS: number,
): Promise<"malformed" | "invalid" | "expired" | null> {
  const dot = token.indexOf(".");
  const expiry = token.slice(0, dot);
  if (dot < 0 || !EXPIRY_PATTERN.test(expiry)) return "malformed";
  const expiresAt = Number(expiry);
  const problem = await verifyText(
    label,
    secretKey,
    signedText({ rig, service, expiresAt }),
    token.slice(dot + 1),
  );
  if (problem) return problem;
  return expiresAt > nowS ? null : "expired";
}

/**
 * The path of a service link, ending in `/` so the service's relative URLs
 * resolve under it. The rig name is a hostd machine name (URL-safe); the
 * service name is percent-encoded as one segment.
 */
export function serviceLinkPath(
  rigsPath: string,
  rig: string,
  service: string,
  token: string,
): string {
  return `${rigsPath}/${rig}/${SERVICE_LINKS_SEGMENT}/${encodeURIComponent(service)}/${token}/`;
}

function signedText({ rig, service, expiresAt }: ServiceLinkClaim): string {
  return `v1\n${rig}\n${service}\n${expiresAt}`;
}
