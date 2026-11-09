/**
 * Verify a rules record on a host with a lock (phase 1b): only a lock key
 * may sign it, as "The `org` signer kind" in `iroh-contracts.md` fixes.
 */
import { verifyEd25519 } from "./crypto";
import { fromBase64Url } from "./encoding";
import {
  LOCK_FEATURE,
  ORG_SIGNER_KIND,
  type AdminKey,
  type LockState,
} from "./lock";
import {
  envelopeSchema,
  principalKey,
  signatureSchema,
  type Principal,
  type RulesPayload,
} from "./rules";
import { signedMessage } from "./sign";
import {
  parseRulesPayload,
  SUPPORTED_FEATURES,
  SUPPORTED_FORMATS,
} from "./verify";

/** The required features a host with `lock_v1` knows. */
export const LOCK_HOST_FEATURES: readonly string[] = [
  ...SUPPORTED_FEATURES,
  LOCK_FEATURE,
];

/** Why a host with a lock refuses a rules record. It keeps its old rules. */
export type LockedVerifyRefusal =
  | "malformed"
  | "bad_signature"
  | "untrusted_signer"
  | "unknown_format"
  | "unknown_feature"
  | "wrong_org"
  | "missing_lock_feature"
  | "wrong_lock"
  | "lock_behind"
  | "old_version";

export interface LockedVerifyOptions {
  /** The host's lock state, from `verifyLockLog` or `appendLockEntries`. */
  lock: LockState;
  /** The host's org. */
  orgId: string;
  /** The version the host has, or `null` when it has none. */
  haveVersion: number | null;
  /** Payload formats the host reads. Default `SUPPORTED_FORMATS`. */
  knownFormats?: readonly number[];
  /**
   * Required features the host knows. Default `LOCK_HOST_FEATURES`.
   * `lock_v1` is always known here.
   */
  knownFeatures?: readonly string[];
}

/** The lock key whose signature made the host accept a record. */
export type LockedSigner =
  | { kind: "org"; key_id: string; role: "root" }
  | {
      kind: "org";
      key_id: string;
      role: "admin";
      principal: Principal;
      device_id: string;
    };

export type LockedVerifyResult =
  | { ok: true; rules: RulesPayload; signer: LockedSigner }
  | { ok: false; reason: LockedVerifyRefusal; detail: string };

/**
 * Verify a rules envelope on a host whose lock is on.
 *
 * One signature must be of kind `org`, by a trusted root key, or by an
 * admin key with `sign_rules` whose `principal` and `device_id` equal its
 * approval note. A root key's signature carries neither. A signature of
 * kind `amika` is never trusted here. Then, in this order: format,
 * required features, the payload's shape, org, `lock_v1` in
 * `required_features`, `lock.lock_id`, `lock.seq`, version.
 *
 * A `lock_behind` refusal means the record names lock entries the host
 * does not have. Fetch the lock log, then verify the record again.
 */
export async function verifyLockedRules(
  envelope: unknown,
  options: LockedVerifyOptions,
): Promise<LockedVerifyResult> {
  const { lock } = options;
  const parsed = envelopeSchema.safeParse(envelope);
  if (!parsed.success) return refuse("malformed", "envelope has no shape");
  const bytes = fromBase64Url(parsed.data.payload);
  if (bytes === null) {
    return refuse("malformed", "payload is not base64url with no padding");
  }
  if (lock.disabled) return refuse("untrusted_signer", "the lock is off");
  const signed = await findLockSignature(bytes, parsed.data.signatures, lock);
  if (!signed.ok) return signed;

  const knownFeatures = [
    ...(options.knownFeatures ?? LOCK_HOST_FEATURES),
    LOCK_FEATURE,
  ];
  const read = parseRulesPayload(
    bytes,
    options.knownFormats ?? SUPPORTED_FORMATS,
    knownFeatures,
  );
  if (!read.ok) return read;
  const rules = read.rules;
  if (rules.org_id !== options.orgId) {
    return refuse("wrong_org", `org ${rules.org_id}`);
  }
  if (!rules.required_features.includes(LOCK_FEATURE)) {
    return refuse("missing_lock_feature", "required_features lacks lock_v1");
  }
  if (rules.lock === undefined || rules.lock.lock_id !== lock.lock_id) {
    return refuse("wrong_lock", `lock ${rules.lock?.lock_id ?? "(none)"}`);
  }
  if (rules.lock.seq > lock.seq) {
    return refuse(
      "lock_behind",
      `lock seq ${rules.lock.seq}, have ${lock.seq}`,
    );
  }
  if (options.haveVersion !== null && rules.version <= options.haveVersion) {
    return refuse(
      "old_version",
      `version ${rules.version}, have ${options.haveVersion}`,
    );
  }
  return { ok: true, rules, signer: signed.signer };
}

type Refused = { ok: false; reason: LockedVerifyRefusal; detail: string };

function refuse(reason: LockedVerifyRefusal, detail: string): Refused {
  return { ok: false, reason, detail };
}

/**
 * Find a signature by a trusted lock key that verifies. When none does,
 * report `bad_signature` if a trusted key's signature failed, otherwise
 * `untrusted_signer`.
 */
async function findLockSignature(
  bytes: Uint8Array,
  signatures: unknown[],
  lock: LockState,
): Promise<{ ok: true; signer: LockedSigner } | Refused> {
  const message = signedMessage(bytes);
  let closest = refuse("untrusted_signer", "no signature by a lock key");
  for (const raw of signatures) {
    const parsed = signatureSchema.safeParse(raw);
    if (!parsed.success) continue;
    const { sig, ...claimed } = parsed.data;
    const signer = trustedSigner(claimed, lock);
    if (signer === null) continue;
    if (await verifyEd25519(signer.key_id, sig, message)) {
      return { ok: true, signer };
    }
    closest = refuse("bad_signature", `key ${signer.key_id}: bad signature`);
  }
  return closest;
}

/** The lock key a signature claims, when the lock trusts it for rules. */
function trustedSigner(
  claimed: {
    kind: string;
    key_id: string;
    principal?: Principal;
    device_id?: string;
  },
  lock: LockState,
): LockedSigner | null {
  if (claimed.kind !== ORG_SIGNER_KIND) return null;
  const { key_id, principal, device_id } = claimed;
  if (lock.root_keys.some((k) => k.key_id === key_id)) {
    if (principal !== undefined || device_id !== undefined) return null;
    return { kind: "org", key_id, role: "root" };
  }
  const admin = lock.admin_keys.find((k) => k.key_id === key_id);
  if (admin === undefined || !matchesNote(admin, principal, device_id)) {
    return null;
  }
  return {
    kind: "org",
    key_id,
    role: "admin",
    principal: admin.principal,
    device_id: admin.device_id,
  };
}

function matchesNote(
  admin: AdminKey,
  principal: Principal | undefined,
  deviceId: string | undefined,
): boolean {
  return (
    admin.can.includes("sign_rules") &&
    principal !== undefined &&
    principalKey(principal) === principalKey(admin.principal) &&
    deviceId === admin.device_id
  );
}
