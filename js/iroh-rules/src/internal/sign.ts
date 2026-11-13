/** The control plane's side: encode a payload and sign its bytes. */
import { fromBase64Url, toBase64Url, toHex } from "./encoding";
import {
  payloadSchema,
  SIGNATURE_CONTEXT,
  type Principal,
  type RulesEnvelope,
  type RulesPayload,
  type RulesSignature,
} from "./rules";

/** Who signs, and with which key. */
export interface RulesSigner {
  /** `amika` for the control plane. */
  kind: string;
  /** The 32-byte Ed25519 seed. */
  privateKey: Uint8Array;
  principal?: Principal;
  device_id?: string;
}

/**
 * Encode `payload` as UTF-8 JSON. Throws when the payload breaks the
 * format, so the control plane never signs a record that hosts refuse.
 */
export function encodePayload(payload: RulesPayload): Uint8Array {
  payloadSchema.parse(payload);
  return new TextEncoder().encode(JSON.stringify(payload));
}

/**
 * Sign the exact `payloadBytes` and wrap them in an envelope with one
 * signature. Ed25519 is deterministic, so the same input gives the same
 * envelope.
 */
export async function signRules(
  payloadBytes: Uint8Array,
  signer: RulesSigner,
): Promise<RulesEnvelope> {
  const key = await importPrivateKey(signer.privateKey);
  const sig = new Uint8Array(
    await crypto.subtle.sign("Ed25519", key, signedMessage(payloadBytes)),
  );
  const { principal, device_id } = signer;
  const signature: RulesSignature = {
    kind: signer.kind,
    key_id: await publicKeyOf(key),
    ...(principal === undefined ? {} : { principal }),
    ...(device_id === undefined ? {} : { device_id }),
    sig: toBase64Url(sig),
  };
  return { payload: toBase64Url(payloadBytes), signatures: [signature] };
}

/** The public key, as 64 lowercase hex, that pairs with a 32-byte seed. */
export async function rulesPublicKey(privateKey: Uint8Array): Promise<string> {
  return publicKeyOf(await importPrivateKey(privateKey));
}

/**
 * The bytes a signature covers: `amika-iroh-rules-v1`, one zero byte, then
 * the payload bytes.
 */
export function signedMessage(
  payloadBytes: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const prefix = new TextEncoder().encode(SIGNATURE_CONTEXT);
  const message = new Uint8Array(prefix.length + 1 + payloadBytes.length);
  message.set(prefix, 0);
  message.set(payloadBytes, prefix.length + 1);
  return message;
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
  // Workers' types return `ArrayBuffer | JsonWebKey` for every format.
  const jwk: unknown = await crypto.subtle.exportKey("jwk", key);
  const x =
    typeof jwk === "object" && jwk !== null && "x" in jwk ? jwk.x : null;
  const publicKey = typeof x === "string" ? fromBase64Url(x) : null;
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
