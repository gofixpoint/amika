/** The host's side: check a rules envelope's signatures, then read it. */
import { z } from "zod";
import { verifyEd25519 } from "./crypto";
import { fromBase64Url } from "./encoding";
import {
  envelopeSchema,
  payloadHeaderSchema,
  payloadSchema,
  requiredFeaturesSchema,
  RULES_FORMAT,
  signatureSchema,
  type Principal,
  type RulesPayload,
} from "./rules";
import { signedMessage } from "./sign";

/** The formats a host on this package reads. It sends them at registration. */
export const SUPPORTED_FORMATS: readonly number[] = [RULES_FORMAT];

/** The required features a host on this package knows. */
export const SUPPORTED_FEATURES: readonly string[] = [];

/** Why a host refuses a rules record. It keeps its old rules. */
export type VerifyRefusal =
  | "bad_signature"
  | "untrusted_key"
  | "untrusted_kind"
  | "unknown_format"
  | "unknown_feature"
  | "wrong_org"
  | "old_version"
  | "malformed";

export interface VerifyOptions {
  /** Public keys, as 64 lowercase hex, that may sign rules. */
  trustedKeys: readonly string[];
  /** Signer kinds trusted for this org. `amika` in phase 1. */
  trustedKinds: readonly string[];
  /** The host's org. A record for another org is refused. */
  orgId: string;
  /** The version the host has, or `null` when it has none. */
  haveVersion: number | null;
  /** Payload formats the host reads. Usually `SUPPORTED_FORMATS`. */
  knownFormats: readonly number[];
  /** Required features the host knows. Usually `SUPPORTED_FEATURES`. */
  knownFeatures: readonly string[];
}

/** The signature that made the host accept a record. */
export interface VerifiedSigner {
  kind: string;
  key_id: string;
  principal?: Principal;
  device_id?: string;
}

export type VerifyResult =
  | { ok: true; rules: RulesPayload; signer: VerifiedSigner }
  | { ok: false; reason: VerifyRefusal; detail: string };

/**
 * Verify a rules envelope (the parsed JSON) and read its payload.
 *
 * The record is accepted when at least one signature verifies on the exact
 * payload bytes with a trusted key, and its kind is trusted. Only then are
 * the bytes parsed. The checks after that run in this order: format,
 * required features, the payload's shape, org, version.
 */
export async function verifyRules(
  envelope: unknown,
  options: VerifyOptions,
): Promise<VerifyResult> {
  const parsed = envelopeSchema.safeParse(envelope);
  if (!parsed.success) {
    return refuse("malformed", `envelope: ${describe(parsed.error)}`);
  }
  const payloadBytes = fromBase64Url(parsed.data.payload);
  if (payloadBytes === null) {
    return refuse("malformed", "payload is not base64url with no padding");
  }
  const signed = await findTrustedSignature(
    payloadBytes,
    parsed.data.signatures,
    options,
  );
  if (!signed.ok) return signed;
  const read = readPayload(payloadBytes, options);
  if (!read.ok) return read;
  return { ok: true, rules: read.rules, signer: signed.signer };
}

type Refused = { ok: false; reason: VerifyRefusal; detail: string };

function refuse<R extends VerifyRefusal>(
  reason: R,
  detail: string,
): { ok: false; reason: R; detail: string } {
  return { ok: false, reason, detail };
}

/**
 * Find a signature that verifies with a trusted key and has a trusted kind.
 * When none does, report the refusal of the signature that came closest:
 * an untrusted kind, then a bad signature, then an untrusted key, then a
 * malformed signature.
 */
async function findTrustedSignature(
  payloadBytes: Uint8Array,
  signatures: unknown[],
  options: VerifyOptions,
): Promise<{ ok: true; signer: VerifiedSigner } | Refused> {
  const message = signedMessage(payloadBytes);
  let closest: SignatureRefusal = "malformed";
  let detail = "no signature has a known shape";
  const note = (reason: SignatureRefusal, why: string) => {
    if (CLOSENESS[reason] > CLOSENESS[closest]) {
      closest = reason;
      detail = why;
    }
  };
  for (const raw of signatures) {
    const parsed = signatureSchema.safeParse(raw);
    if (!parsed.success) continue;
    const { sig, ...signer } = parsed.data;
    if (!options.trustedKeys.includes(signer.key_id)) {
      note("untrusted_key", `key ${signer.key_id} is not trusted`);
      continue;
    }
    if (!(await verifyEd25519(signer.key_id, sig, message))) {
      note("bad_signature", `key ${signer.key_id}: bad signature`);
      continue;
    }
    if (!options.trustedKinds.includes(signer.kind)) {
      note("untrusted_kind", `kind ${signer.kind} is not trusted`);
      continue;
    }
    return { ok: true, signer };
  }
  return refuse(closest, detail);
}

type SignatureRefusal =
  | "malformed"
  | "untrusted_key"
  | "bad_signature"
  | "untrusted_kind";

const CLOSENESS: Record<SignatureRefusal, number> = {
  malformed: 0,
  untrusted_key: 1,
  bad_signature: 2,
  untrusted_kind: 3,
};

/** Parse signed payload bytes and check them against the host's state. */
function readPayload(
  bytes: Uint8Array,
  options: VerifyOptions,
): { ok: true; rules: RulesPayload } | Refused {
  const parsed = parseRulesPayload(
    bytes,
    options.knownFormats,
    options.knownFeatures,
  );
  if (!parsed.ok) return parsed;
  const rules = parsed.rules;
  if (rules.org_id !== options.orgId) {
    return refuse("wrong_org", `org ${rules.org_id}`);
  }
  if (options.haveVersion !== null && rules.version <= options.haveVersion) {
    return refuse(
      "old_version",
      `version ${rules.version}, have ${options.haveVersion}`,
    );
  }
  return { ok: true, rules };
}

/**
 * Parse signed payload bytes, in this order: UTF-8 JSON, a known format,
 * known required features, then the format 1 shape.
 */
export function parseRulesPayload(
  bytes: Uint8Array,
  knownFormats: readonly number[],
  knownFeatures: readonly string[],
):
  | { ok: true; rules: RulesPayload }
  | {
      ok: false;
      reason: "malformed" | "unknown_format" | "unknown_feature";
      detail: string;
    } {
  const json = parseJson(bytes);
  if (json === undefined) {
    return refuse("malformed", "payload is not UTF-8 JSON");
  }
  const header = payloadHeaderSchema.safeParse(json);
  if (!header.success) {
    return refuse("malformed", `payload: ${describe(header.error)}`);
  }
  if (!knownFormats.includes(header.data.format)) {
    return refuse("unknown_format", `format ${header.data.format}`);
  }
  const features = requiredFeaturesSchema.safeParse(json);
  if (!features.success) {
    return refuse("malformed", `payload: ${describe(features.error)}`);
  }
  const unknown = features.data.required_features.filter(
    (feature) => !knownFeatures.includes(feature),
  );
  if (unknown.length > 0) {
    return refuse("unknown_feature", `required: ${unknown.join(", ")}`);
  }
  const payload = payloadSchema.safeParse(json);
  if (!payload.success) {
    return refuse("malformed", `payload: ${describe(payload.error)}`);
  }
  return { ok: true, rules: payload.data };
}

/** Parse UTF-8 JSON bytes, or return `undefined` when they are not. */
export function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (_error) {
    return undefined;
  }
}

export function describe(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}
