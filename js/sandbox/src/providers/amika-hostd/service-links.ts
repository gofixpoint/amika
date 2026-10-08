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
 * Only Web Crypto is used, so this runs wherever the provider does.
 */

/** The path segment that marks a service-link route. */
export const SERVICE_LINKS_SEGMENT = "service-links";

/** Separates a link key from any other use of the host's secret key. */
const LINK_KEY_LABEL = "amika-hostd service links v1";

/** An HMAC-SHA256 digest is 32 bytes: 43 base64url characters, unpadded. */
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const EXPIRY_PATTERN = /^[1-9][0-9]{0,11}$/;

const encoder = new TextEncoder();

// The lib config has no DOM types, so `CryptoKey` is named through Web Crypto.
type LinkKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

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
export async function signServiceLink(
  secretKey: string,
  claim: ServiceLinkClaim,
): Promise<string> {
  if (!Number.isSafeInteger(claim.expiresAt) || claim.expiresAt <= 0) {
    throw new Error("A service link's expiry must be a positive Unix time");
  }
  const key = await linkKey(secretKey, ["sign"]);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signedText(claim)),
  );
  return `${claim.expiresAt}.${toBase64Url(new Uint8Array(signature))}`;
}

/**
 * Why `token` does not grant `rig`'s `service` at `nowS` (Unix seconds), or
 * null when it does. The signature is checked in constant time before the
 * expiry, so a forged token is told nothing about its expiry.
 */
export async function verifyServiceLink(
  secretKey: string,
  { rig, service, token }: { rig: string; service: string; token: string },
  nowS: number,
): Promise<"malformed" | "invalid" | "expired" | null> {
  const dot = token.indexOf(".");
  const expiry = token.slice(0, dot);
  const encoded = token.slice(dot + 1);
  if (
    dot < 0 ||
    !EXPIRY_PATTERN.test(expiry) ||
    !SIGNATURE_PATTERN.test(encoded)
  ) {
    return "malformed";
  }
  const signature = fromBase64Url(encoded);
  // 43 characters carry 258 bits, so four spellings decode to one digest;
  // accept only the canonical one.
  if (toBase64Url(signature) !== encoded) return "malformed";
  const expiresAt = Number(expiry);
  const key = await linkKey(secretKey, ["verify"]);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    encoder.encode(signedText({ rig, service, expiresAt })),
  );
  if (!valid) return "invalid";
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

/** HMAC-SHA256(secretKey, label), imported as an HMAC key. */
async function linkKey(
  secretKey: string,
  usages: ("sign" | "verify")[],
): Promise<LinkKey> {
  const secret = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secretKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const derived = await crypto.subtle.sign(
    "HMAC",
    secret,
    encoder.encode(LINK_KEY_LABEL),
  );
  return crypto.subtle.importKey(
    "raw",
    derived,
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(encoded: string): Uint8Array<ArrayBuffer> {
  const binary = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
