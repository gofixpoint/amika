/** The control plane's side: encode a payload and sign its bytes. */
import { contextMessage, publicKeyFromSeed, signWithContext } from "./crypto";
import { toBase64Url } from "./encoding";
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
  /** `amika` for the control plane, `org` for a lock key. */
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
  const { key_id, sig } = await signWithContext(
    SIGNATURE_CONTEXT,
    payloadBytes,
    signer.privateKey,
  );
  const { principal, device_id } = signer;
  const signature: RulesSignature = {
    kind: signer.kind,
    key_id,
    ...(principal === undefined ? {} : { principal }),
    ...(device_id === undefined ? {} : { device_id }),
    sig,
  };
  return { payload: toBase64Url(payloadBytes), signatures: [signature] };
}

/** The public key, as 64 lowercase hex, that pairs with a 32-byte seed. */
export async function rulesPublicKey(privateKey: Uint8Array): Promise<string> {
  return publicKeyFromSeed(privateKey);
}

/**
 * The bytes a signature covers: `amika-iroh-rules-v1`, one zero byte, then
 * the payload bytes.
 */
export function signedMessage(
  payloadBytes: Uint8Array,
): Uint8Array<ArrayBuffer> {
  return contextMessage(SIGNATURE_CONTEXT, payloadBytes);
}
