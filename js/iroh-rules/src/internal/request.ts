/**
 * Signed requests to hostd's API in a locked org (phase 1b): a member's
 * device signing key signs a list of operations. The control plane builds
 * the payload, the CLI signs it, and hostd checks it with
 * `checkSignedRequest`. hostd owns the store of used operations.
 */
import { z } from "zod";
import {
  contextMessage,
  sha256Hex,
  signWithContext,
  verifyEd25519,
} from "./crypto";
import { fromBase64Url, toBase64Url } from "./encoding";
import { roleOf } from "./decide";
import { DEVICE_SIGNER_KIND } from "./lock";
import {
  envelopeSchema,
  hex64Schema,
  principalKey,
  signatureSchema,
  type Principal,
  type RulesPayload,
} from "./rules";
import { describe, parseJson } from "./verify";

/** The text that starts every signed request, before one zero byte. */
export const REQUEST_SIGNATURE_CONTEXT = "amika-iroh-request-v1";

/** The HTTP header that carries the envelope. */
export const SIGNED_REQUEST_HEADER = "Amika-Signed-Request";

/** The request payload format this package reads and writes. */
export const REQUEST_FORMAT = 1;

/** The request payload formats a host on this package reads. */
export const REQUEST_SUPPORTED_FORMATS: readonly number[] = [REQUEST_FORMAT];

/** The request payload required features a host on this package knows. */
export const REQUEST_SUPPORTED_FEATURES: readonly string[] = [];

/** At most this many operations in one signed request. */
export const MAX_REQUEST_OPS = 64;

/** `expires_at - issued_at` is at most this many milliseconds: 30 minutes. */
export const MAX_REQUEST_LIFETIME_MS = 30 * 60 * 1000;

/** A host accepts `issued_at` up to this many milliseconds in its future. */
export const REQUEST_CLOCK_SKEW_MS = 60 * 1000;

/** The header value is at most this many bytes. */
export const MAX_SIGNED_REQUEST_HEADER_BYTES = 16 * 1024;

/** The size of a nonce, in bytes. */
export const REQUEST_NONCE_BYTES = 16;

/** One HTTP request that the signature allows. */
export interface RequestOperation {
  /** Uppercase, for example `POST`. */
  method: string;
  /** The path as sent, with its percent-encoding, without a query string. */
  path: string;
  /** SHA-256 of the exact body bytes, as 64 lowercase hex. */
  body_sha256: string;
}

export interface SignedRequestPayload {
  format: number;
  required_features: string[];
  org_id: string;
  host_id: string;
  /** 16 random bytes, as base64url with no padding. */
  nonce: string;
  /** Milliseconds since the Unix epoch. */
  issued_at: number;
  expires_at: number;
  ops: RequestOperation[];
}

/** The device's signature. `principal` and `device_id` are necessary. */
export interface RequestSignature {
  kind: string;
  key_id: string;
  principal: Principal;
  device_id: string;
  sig: string;
}

export interface SignedRequestEnvelope {
  payload: string;
  signatures: RequestSignature[];
}

/** A member's device, and its signing key's 32-byte seed. */
export interface RequestSigner {
  privateKey: Uint8Array;
  principal: Principal;
  device_id: string;
}

/**
 * Encode a request payload as UTF-8 JSON. Throws when it breaks the
 * format or the limits, so nobody signs a request that hosts refuse.
 */
export function encodeRequestPayload(
  payload: SignedRequestPayload,
): Uint8Array {
  requestPayloadSchema.parse(payload);
  const lifetime = payload.expires_at - payload.issued_at;
  if (lifetime <= 0 || lifetime > MAX_REQUEST_LIFETIME_MS) {
    throw new RangeError("expires_at - issued_at is 1 ms to 30 minutes");
  }
  return new TextEncoder().encode(JSON.stringify(payload));
}

/** Sign the exact `payloadBytes` with a device signing key, as kind `device`. */
export async function signRequest(
  payloadBytes: Uint8Array,
  signer: RequestSigner,
): Promise<SignedRequestEnvelope> {
  const { key_id, sig } = await signWithContext(
    REQUEST_SIGNATURE_CONTEXT,
    payloadBytes,
    signer.privateKey,
  );
  return {
    payload: toBase64Url(payloadBytes),
    signatures: [
      {
        kind: DEVICE_SIGNER_KIND,
        key_id,
        principal: signer.principal,
        device_id: signer.device_id,
        sig,
      },
    ],
  };
}

/** The `Amika-Signed-Request` header value: base64url of the envelope JSON. */
export function encodeSignedRequestHeader(
  envelope: SignedRequestEnvelope,
): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(envelope)));
}

/** SHA-256 of a request body, as 64 lowercase hex. No body is zero bytes. */
export async function bodySha256(body: Uint8Array): Promise<string> {
  return sha256Hex(body);
}

/** A new random nonce: 16 bytes, as base64url with no padding. */
export function makeRequestNonce(): string {
  return toBase64Url(
    crypto.getRandomValues(new Uint8Array(REQUEST_NONCE_BYTES)),
  );
}

/**
 * hostd's store of used operations. It keeps each `(nonce, index)` until
 * its `expiresAt`, in memory: a restart clears it, and check 6 refuses
 * every request issued before the restart.
 *
 * `checkSignedRequest` only reads it. hostd marks an operation as used
 * when its handler starts the runtime call, and not before: a `400`, a
 * `409` or a `503` leaves it unused, so the control plane can retry.
 */
export interface UsedOperationStore {
  /** Whether `(nonce, index)` is marked as used and not yet expired. */
  isUsed(nonce: string, index: number): boolean | Promise<boolean>;
  /**
   * Mark `(nonce, index)` as used until `expiresAt` (ms since the epoch).
   * Returns false when it was already used: the caller then refuses the
   * request with `replayed`. This makes two concurrent requests safe.
   */
  markUsed(
    nonce: string,
    index: number,
    expiresAt: number,
  ): boolean | Promise<boolean>;
}

/** Why hostd refuses a signed request: `403 { "error": "<reason>" }`. */
export type SignedRequestRefusal =
  | "signature_required"
  | "bad_signature"
  | "unknown_signer"
  | "wrong_target"
  | "expired"
  | "no_matching_op"
  | "replayed"
  | "not_allowed";

/**
 * What check 9 needs to know about the request's rig.
 *
 * - `create`: the `owner` in the create body, or `null` when it has none.
 * - `rig`: an existing rig, and its owner, or `null` when it has none.
 */
export type RequestAccess =
  | { kind: "create"; owner: Principal | null }
  | { kind: "rig"; rigOwner: Principal | null };

/** The HTTP request as hostd received it. */
export interface SignedRequestInput {
  /** The `Amika-Signed-Request` header value, or null when it is absent. */
  header: string | null | undefined;
  method: string;
  /** The path as received, with its percent-encoding, without a query. */
  path: string;
  /** The exact body bytes. Zero bytes when the request has no body. */
  body: Uint8Array;
  access: RequestAccess;
}

export interface SignedRequestContext {
  /** The host's current verified rules. */
  rules: RulesPayload;
  orgId: string;
  hostId: string;
  /** Now, in ms since the epoch. */
  now: number;
  /** When this hostd process started, in ms since the epoch. */
  processStartedAt: number;
  used: UsedOperationStore;
  /** Default `REQUEST_SUPPORTED_FORMATS`. */
  knownFormats?: readonly number[];
  /** Default `REQUEST_SUPPORTED_FEATURES`. */
  knownFeatures?: readonly string[];
}

/** An accepted request: the operation to mark as used, and who signed. */
export interface AcceptedRequest {
  ok: true;
  nonce: string;
  opIndex: number;
  expiresAt: number;
  signer: { key_id: string; principal: Principal; device_id: string };
  payload: SignedRequestPayload;
}

export type SignedRequestCheck =
  | AcceptedRequest
  | { ok: false; reason: SignedRequestRefusal; detail: string };

/**
 * hostd's checks on a route that needs a signature, in this order:
 *
 * 1. The header is present (`signature_required`).
 * 2. The envelope parses, and one signature verifies on the payload
 *    bytes, before the payload is parsed (`bad_signature`).
 * 3. That signature's kind is `device`, and its `device_id` is in the
 *    rules with this `signing_key` and `principal` (`unknown_signer`).
 * 4. The payload's format, required features and shape are known, and
 *    `org_id` and `host_id` are this host's (`wrong_target`).
 * 5. `issued_at - 60 s <= now < expires_at`, and the lifetime is at most
 *    30 minutes (`expired`).
 * 6. `issued_at >= processStartedAt` (`expired`).
 * 7. An operation matches the method, the path and the body's hash
 *    (`no_matching_op`).
 * 8. One such operation is not used yet (`replayed`). When several
 *    operations match, the first unused one is chosen.
 * 9. The signer's principal can reach the rig (`not_allowed`).
 *
 * It does not mark the operation as used: see `UsedOperationStore`.
 */
export async function checkSignedRequest(
  input: SignedRequestInput,
  context: SignedRequestContext,
): Promise<SignedRequestCheck> {
  if (input.header === null || input.header === undefined) {
    return refuse("signature_required", "no Amika-Signed-Request header");
  }
  const envelope = decodeHeader(input.header);
  if (!envelope.ok) return envelope;
  const signed = await findDeviceSignature(envelope, context.rules);
  if (!signed.ok) return signed;

  const read = readPayload(envelope.bytes, context);
  if (!read.ok) return read;
  const payload = read.payload;

  const lifetime = payload.expires_at - payload.issued_at;
  if (lifetime <= 0 || lifetime > MAX_REQUEST_LIFETIME_MS) {
    return refuse("expired", `lifetime ${lifetime} ms`);
  }
  if (
    context.now < payload.issued_at - REQUEST_CLOCK_SKEW_MS ||
    context.now >= payload.expires_at
  ) {
    return refuse("expired", `now ${context.now} is outside the window`);
  }
  if (payload.issued_at < context.processStartedAt) {
    return refuse("expired", "issued before this hostd process started");
  }

  const hash = await bodySha256(input.body);
  const matching = payload.ops.flatMap((op, index) =>
    op.method === input.method &&
    op.path === input.path &&
    op.body_sha256 === hash
      ? [index]
      : [],
  );
  if (matching.length === 0) {
    return refuse("no_matching_op", `${input.method} ${input.path}`);
  }
  let opIndex: number | null = null;
  for (const index of matching) {
    if (!(await context.used.isUsed(payload.nonce, index))) {
      opIndex = index;
      break;
    }
  }
  if (opIndex === null) {
    return refuse("replayed", `nonce ${payload.nonce}`);
  }

  if (!mayReach(context.rules, signed.signer.principal, input.access)) {
    return refuse("not_allowed", principalKey(signed.signer.principal));
  }
  return {
    ok: true,
    nonce: payload.nonce,
    opIndex,
    expiresAt: payload.expires_at,
    signer: signed.signer,
    payload,
  };
}

type Refused = { ok: false; reason: SignedRequestRefusal; detail: string };

function refuse(reason: SignedRequestRefusal, detail: string): Refused {
  return { ok: false, reason, detail };
}

/** Decode the header: base64url of the envelope JSON, at most 16 KiB. */
function decodeHeader(
  header: string,
): { ok: true; bytes: Uint8Array; signatures: unknown[] } | Refused {
  if (header.length > MAX_SIGNED_REQUEST_HEADER_BYTES) {
    return refuse("bad_signature", "the header is larger than 16 KiB");
  }
  const json = fromBase64Url(header);
  const parsed = envelopeSchema.safeParse(
    json === null ? undefined : parseJson(json),
  );
  if (!parsed.success) {
    return refuse("bad_signature", "the header is not an envelope");
  }
  const bytes = fromBase64Url(parsed.data.payload);
  if (bytes === null) {
    return refuse("bad_signature", "payload is not base64url");
  }
  return { ok: true, bytes, signatures: parsed.data.signatures };
}

/**
 * Checks 2 and 3. A signature that verifies but names no device of the
 * rules with this key and principal gives `unknown_signer`.
 */
async function findDeviceSignature(
  envelope: { bytes: Uint8Array; signatures: unknown[] },
  rules: RulesPayload,
): Promise<{ ok: true; signer: AcceptedRequest["signer"] } | Refused> {
  const message = contextMessage(REQUEST_SIGNATURE_CONTEXT, envelope.bytes);
  let closest = refuse("bad_signature", "no signature verifies");
  for (const raw of envelope.signatures) {
    const parsed = signatureSchema.safeParse(raw);
    if (!parsed.success) continue;
    const { sig, kind, key_id, principal, device_id } = parsed.data;
    if (!(await verifyEd25519(key_id, sig, message))) continue;
    const device = rules.devices.find((d) => d.device_id === device_id);
    if (
      kind !== DEVICE_SIGNER_KIND ||
      principal === undefined ||
      device === undefined ||
      device.signing_key !== key_id ||
      principalKey(device.principal) !== principalKey(principal)
    ) {
      closest = refuse("unknown_signer", `key ${key_id} is not a device's`);
      continue;
    }
    return {
      ok: true,
      signer: {
        key_id,
        principal: device.principal,
        device_id: device.device_id,
      },
    };
  }
  return closest;
}

/** Check 4: parse the payload and check that it is for this host. */
function readPayload(
  bytes: Uint8Array,
  context: SignedRequestContext,
): { ok: true; payload: SignedRequestPayload } | Refused {
  const json = parseJson(bytes);
  const header = z
    .object({ format: z.number(), required_features: z.array(z.string()) })
    .safeParse(json);
  if (!header.success) {
    return refuse("wrong_target", "payload has no format or features");
  }
  const formats = context.knownFormats ?? REQUEST_SUPPORTED_FORMATS;
  if (!formats.includes(header.data.format)) {
    return refuse("wrong_target", `format ${header.data.format}`);
  }
  const features = context.knownFeatures ?? REQUEST_SUPPORTED_FEATURES;
  const unknown = header.data.required_features.filter(
    (f) => !features.includes(f),
  );
  if (unknown.length > 0) {
    return refuse("wrong_target", `required: ${unknown.join(", ")}`);
  }
  const payload = requestPayloadSchema.safeParse(json);
  if (!payload.success) {
    return refuse("wrong_target", `payload: ${describe(payload.error)}`);
  }
  if (payload.data.org_id !== context.orgId) {
    return refuse("wrong_target", `org ${payload.data.org_id}`);
  }
  if (payload.data.host_id !== context.hostId) {
    return refuse("wrong_target", `host ${payload.data.host_id}`);
  }
  return { ok: true, payload: payload.data };
}

/**
 * Check 9, by the rules' roles. A create needs an owner: the signer's
 * principal, or any owner for a role with `rigs: "all"`. Another operation
 * needs `all`, or `own` and a rig that the principal owns.
 */
function mayReach(
  rules: RulesPayload,
  principal: Principal,
  access: RequestAccess,
): boolean {
  const role = roleOf(rules, principal);
  if (role === undefined) return false;
  const owner = access.kind === "create" ? access.owner : access.rigOwner;
  if (access.kind === "create" && owner === null) return false;
  if (role.rigs === "all") return true;
  return owner !== null && principalKey(owner) === principalKey(principal);
}

const requestPayloadSchema: z.ZodType<SignedRequestPayload> = z.object({
  format: z.literal(REQUEST_FORMAT),
  required_features: z.array(z.string()),
  org_id: z.string().min(1),
  host_id: z.string().min(1),
  nonce: z
    .string()
    .refine(
      (n) => fromBase64Url(n)?.length === REQUEST_NONCE_BYTES,
      "not 16 bytes of base64url",
    ),
  issued_at: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  expires_at: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  ops: z
    .array(
      z.object({
        method: z.string().regex(/^[A-Z]+$/),
        path: z.string().startsWith("/"),
        body_sha256: hex64Schema,
      }),
    )
    .min(1)
    .max(MAX_REQUEST_OPS),
});
