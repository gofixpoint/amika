/**
 * Ed25519 and SHA-256 through Web Crypto, shared by the rules record, the
 * lock log and signed requests. Each signs a domain string, one zero byte,
 * then the exact payload bytes.
 */
import { fromBase64Url, fromHex, toBase64Url, toHex } from "./encoding";

/** Sign `context || 0x00 || payloadBytes` with a 32-byte seed. */
export async function signWithContext(
  context: string,
  payloadBytes: Uint8Array,
  seed: Uint8Array,
): Promise<{ key_id: string; sig: string }> {
  const key = await importPrivateKey(seed);
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      "Ed25519",
      key,
      contextMessage(context, payloadBytes),
    ),
  );
  return { key_id: await publicKeyOf(key), sig: toBase64Url(sig) };
}

/** The bytes a signature covers: `context`, one zero byte, the payload. */
export function contextMessage(
  context: string,
  payloadBytes: Uint8Array,
): Uint8Array {
  const prefix = new TextEncoder().encode(context);
  const message = new Uint8Array(prefix.length + 1 + payloadBytes.length);
  message.set(prefix, 0);
  message.set(payloadBytes, prefix.length + 1);
  return message;
}

/** Verify `sig` (base64url) over `message` with the hex public key. */
export async function verifyEd25519(
  keyHex: string,
  sig: string,
  message: Uint8Array,
): Promise<boolean> {
  const keyBytes = fromHex(keyHex);
  const sigBytes = fromBase64Url(sig);
  if (keyBytes?.length !== 32 || sigBytes?.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      "Ed25519",
      false,
      ["verify"],
    );
    return await crypto.subtle.verify("Ed25519", key, sigBytes, message);
  } catch (_error) {
    // A key that is not a curve point, for example.
    return false;
  }
}

/** The public key, as 64 lowercase hex, that pairs with a 32-byte seed. */
export async function publicKeyFromSeed(seed: Uint8Array): Promise<string> {
  return publicKeyOf(await importPrivateKey(seed));
}

/** SHA-256 of `bytes`, as 64 lowercase hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

/** Whether two strings are equal, in time that depends only on length. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Import a seed. Web Crypto has no raw import for an Ed25519 private key,
 * so wrap the seed in its fixed PKCS #8 header.
 */
async function importPrivateKey(seed: Uint8Array): Promise<SigningKey> {
  if (seed.length !== 32) {
    throw new TypeError("an Ed25519 private key is a 32-byte seed");
  }
  const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
  pkcs8.set(PKCS8_ED25519_PREFIX, 0);
  pkcs8.set(seed, PKCS8_ED25519_PREFIX.length);
  return crypto.subtle.importKey("pkcs8", pkcs8, "Ed25519", true, ["sign"]);
}

/** The public key of a private key, read from its JWK's `x`. */
async function publicKeyOf(key: SigningKey): Promise<string> {
  const jwk = await crypto.subtle.exportKey("jwk", key);
  const publicKey = jwk.x === undefined ? null : fromBase64Url(jwk.x);
  if (publicKey === null || publicKey.length !== 32) {
    throw new Error("Web Crypto returned no Ed25519 public key");
  }
  return toHex(publicKey);
}

/**
 * Web Crypto's key type. Named through `crypto.subtle` because Node's
 * types declare no global `CryptoKey`, and Workers' types do.
 */
type SigningKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

/** DER: SEQUENCE { INTEGER 0, SEQUENCE { OID 1.3.101.112 }, OCTET STRING { OCTET STRING (32) } }. */
const PKCS8_ED25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04,
  0x22, 0x04, 0x20,
]);
