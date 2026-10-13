/**
 * HMAC-SHA256 signing under keys derived from a host's secret key, shared by
 * every credential the control plane and hostd exchange: service links and
 * tokens (`../service-links.ts`), and browser login passes and sessions
 * (`../browser-login.ts`). Each use derives its own key from a distinct
 * label, so a credential minted for one use never verifies as another.
 *
 * Only Web Crypto is used, so this runs wherever the provider does.
 */

/** An HMAC-SHA256 digest is 32 bytes: 43 base64url characters, unpadded. */
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const encoder = new TextEncoder();

// The lib config has no DOM types, so `CryptoKey` is named through Web Crypto.
type DerivedKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

/** The base64url HMAC of `text` under the key `label` derives. */
export async function signText(
  label: string,
  secretKey: string,
  text: string,
): Promise<string> {
  const key = await derivedKey(label, secretKey);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(text));
  return toBase64Url(new Uint8Array(signature));
}

/**
 * Why `encoded` is not the signature of `text` under the key `label`
 * derives, or null when it is. Checked in constant time.
 */
export async function verifyText(
  label: string,
  secretKey: string,
  text: string,
  encoded: string,
): Promise<"malformed" | "invalid" | null> {
  if (!SIGNATURE_PATTERN.test(encoded)) return "malformed";
  const signature = fromBase64Url(encoded);
  // 43 characters carry 258 bits, so four spellings decode to one digest;
  // accept only the canonical one.
  if (toBase64Url(signature) !== encoded) return "malformed";
  const key = await derivedKey(label, secretKey);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    encoder.encode(text),
  );
  return valid ? null : "invalid";
}

/**
 * Derived keys by label and secret key. hostd verifies every asset request a
 * page makes through a link, so a key is derived once, not per request. A
 * control plane signs for many hosts, so the cache is bounded.
 */
const derivedKeys = new Map<string, Promise<DerivedKey>>();
const MAX_CACHED_KEYS = 64;

/** HMAC-SHA256(secretKey, label), imported as an HMAC key. */
function derivedKey(label: string, secretKey: string): Promise<DerivedKey> {
  // A label has no newline, so the pair is unambiguous.
  const cacheKey = `${label}\n${secretKey}`;
  let key = derivedKeys.get(cacheKey);
  if (!key) {
    if (derivedKeys.size >= MAX_CACHED_KEYS) derivedKeys.clear();
    key = deriveKey(label, secretKey);
    derivedKeys.set(cacheKey, key);
    key.catch(() => derivedKeys.delete(cacheKey));
  }
  return key;
}

async function deriveKey(
  label: string,
  secretKey: string,
): Promise<DerivedKey> {
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
    encoder.encode(label),
  );
  return crypto.subtle.importKey(
    "raw",
    derived,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function fromBase64Url(encoded: string): Uint8Array<ArrayBuffer> {
  const binary = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
