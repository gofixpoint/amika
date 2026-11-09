/**
 * The lock log of a locked org (phase 1b), as `iroh-contracts.md` ("Lock
 * entries") fixes it: entry types, schemas, encoding, signing, the lock id
 * and the fingerprint. `lock-verify.ts` reduces a log to a `LockState`.
 */
import { z } from "zod";
import { sha256Hex, signWithContext } from "./crypto";
import { fromBase64Url, fromHex, toBase32, toBase64Url } from "./encoding";
import { DEVICE_ID } from "./ids";
import { hex64Schema, principalSchema, type Principal } from "./rules";

/** The lock entry format this package reads and writes. */
export const LOCK_FORMAT = 1;

/** The text that starts every signed lock entry, before one zero byte. */
export const LOCK_SIGNATURE_CONTEXT = "amika-iroh-lock-v1";

/**
 * The required feature of a locked org's rules record. A host that knows
 * it reports it at registration. A phase 1 host refuses such a record.
 */
export const LOCK_FEATURE = "lock_v1";

/** The signer kind of a lock key: a root key or an admin key. */
export const ORG_SIGNER_KIND = "org";

/** The signer kind of a device signing key, on signed requests. */
export const DEVICE_SIGNER_KIND = "device";

/** At most this many payload bytes in one lock entry. */
export const MAX_LOCK_ENTRY_BYTES = 4096;

/** At most this many entries in a lock log: `seq` 0 to 999. */
export const MAX_LOCK_LOG_ENTRIES = 1000;

/** A lock has 1 to this many root keys. */
export const MAX_ROOT_KEYS = 4;

/** The size of a recovery salt, in bytes. */
export const RECOVERY_SALT_BYTES = 16;

/** A lock entry holds 1 to this many recovery check values. */
export const MAX_RECOVERY_CHECKS = 16;

/** Every lock entry `op` this package knows. */
export const LOCK_OPS = [
  "genesis",
  "add_root_key",
  "remove_root_key",
  "approve_key",
  "revoke_key",
  "set_recovery",
  "disable",
] as const;

export type LockOp = (typeof LOCK_OPS)[number];

/** What an approved admin key may do. Only `sign_rules` in 1b. */
export type KeyCapability = "sign_rules";

export interface RootKey {
  key_id: string;
  name: string;
}

/** The salt and the check values of the recovery codes. */
export interface RecoveryData {
  /** 16 bytes, as base64url with no padding. */
  salt: string;
  /** One SHA-256 check value for each code, as 64 lowercase hex. */
  checks: string[];
}

interface EntryBase {
  format: number;
  required_features: string[];
  org_id: string;
  seq: number;
  /** Milliseconds since the Unix epoch. */
  issued_at: number;
}

interface ChainedEntry extends EntryBase {
  /** SHA-256 of the payload bytes of entry `seq - 1`, as 64 lowercase hex. */
  prev: string;
}

/** One lock entry's payload. The genesis has no `prev`. */
export type LockEntryPayload =
  | (EntryBase & {
      op: "genesis";
      root_keys: RootKey[];
      recovery: RecoveryData;
    })
  | (ChainedEntry & { op: "add_root_key"; key_id: string; name: string })
  | (ChainedEntry & { op: "remove_root_key"; key_id: string })
  | (ChainedEntry & {
      op: "approve_key";
      key_id: string;
      principal: Principal;
      device_id: string;
      can: KeyCapability[];
    })
  | (ChainedEntry & { op: "revoke_key"; key_id: string })
  | (ChainedEntry & { op: "set_recovery"; recovery: RecoveryData })
  | (ChainedEntry & { op: "disable" });

/** One signature on a lock entry. `kind` is `org`. */
export interface LockSignature {
  kind: string;
  key_id: string;
  sig: string;
}

/** A signed lock entry: the payload bytes as sent, and signatures. */
export interface LockEntryEnvelope {
  /** The payload bytes, as base64url with no padding. */
  payload: string;
  signatures: LockSignature[];
}

/** A device signing key that a root key approved: an admin key. */
export interface AdminKey {
  key_id: string;
  principal: Principal;
  device_id: string;
  can: KeyCapability[];
}

/**
 * A lock log reduced to what a verifier trusts after its newest entry. It
 * is plain JSON, so hostd and the CLI can store it.
 */
export interface LockState {
  org_id: string;
  /** SHA-256 of the genesis payload bytes, as 64 lowercase hex. */
  lock_id: string;
  /** The `seq` of the newest entry. */
  seq: number;
  /** SHA-256 of the newest entry's payload bytes. Entry `seq + 1`'s `prev`. */
  head: string;
  root_keys: RootKey[];
  admin_keys: AdminKey[];
  /** Revoked admin keys and removed root keys. Never trusted again. */
  removed_keys: string[];
  recovery: RecoveryData;
  /** True after a `disable` entry. The log then takes no more entries. */
  disabled: boolean;
}

/**
 * Encode a lock entry payload as UTF-8 JSON. Throws when it breaks the
 * format or is larger than `MAX_LOCK_ENTRY_BYTES`, so a tool never signs
 * an entry that verifiers refuse. It does not check the entry against a
 * log: `appendLockEntries` does that.
 */
export function encodeLockEntry(payload: LockEntryPayload): Uint8Array {
  lockEntrySchema.parse(payload);
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  if (bytes.length > MAX_LOCK_ENTRY_BYTES) {
    throw new RangeError(
      `a lock entry is at most ${MAX_LOCK_ENTRY_BYTES} bytes`,
    );
  }
  return bytes;
}

/**
 * Sign the exact `payloadBytes` with each 32-byte seed in `privateKeys`,
 * as kind `org`. The genesis needs every root key in it. `add_root_key`
 * needs a trusted root key and the new key.
 */
export async function signLockEntry(
  payloadBytes: Uint8Array,
  privateKeys: readonly Uint8Array[],
): Promise<LockEntryEnvelope> {
  const signatures: LockSignature[] = [];
  for (const seed of privateKeys) {
    const { key_id, sig } = await signWithContext(
      LOCK_SIGNATURE_CONTEXT,
      payloadBytes,
      seed,
    );
    signatures.push({ kind: ORG_SIGNER_KIND, key_id, sig });
  }
  return { payload: toBase64Url(payloadBytes), signatures };
}

/**
 * SHA-256 of an entry's payload bytes, as 64 lowercase hex. It is the next
 * entry's `prev`. For the genesis, it is the lock id.
 */
export async function lockEntryHash(payloadBytes: Uint8Array): Promise<string> {
  return sha256Hex(payloadBytes);
}

/**
 * The fingerprint of a lock: the first 20 bytes of the lock id, in RFC
 * 4648 base32, lowercase, with no padding. 32 characters. Throws when
 * `lockId` is not 64 lowercase hex.
 */
export function lockFingerprint(lockId: string): string {
  const bytes = fromHex(lockId);
  if (bytes?.length !== 32) {
    throw new TypeError("a lock id is 64 lowercase hex characters");
  }
  return toBase32(bytes.subarray(0, 20));
}

/** A fingerprint as tools show it: 8 groups of 4, joined by `-`. */
export function formatFingerprint(fingerprint: string): string {
  return groupsOfFour(normalizeFingerprint(fingerprint));
}

/**
 * Whether two fingerprints are the same, without case, whitespace or `-`.
 * An empty fingerprint matches nothing.
 */
export function sameFingerprint(a: string, b: string): boolean {
  const left = normalizeFingerprint(a);
  return left.length > 0 && left === normalizeFingerprint(b);
}

function normalizeFingerprint(text: string): string {
  return text.toLowerCase().replace(/[\s-]/g, "");
}

/** Split `text` into groups of 4 characters, joined by `-`. */
export function groupsOfFour(text: string): string {
  return (text.match(/.{1,4}/g) ?? []).join("-");
}

const saltSchema = z
  .string()
  .refine(
    (salt) => fromBase64Url(salt)?.length === RECOVERY_SALT_BYTES,
    "not 16 bytes of base64url",
  );

export const recoverySchema = z.object({
  salt: saltSchema,
  checks: z.array(hex64Schema).min(1).max(MAX_RECOVERY_CHECKS),
});

const seqSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const base = {
  format: z.literal(LOCK_FORMAT),
  required_features: z.array(z.string()),
  org_id: z.string().min(1),
  seq: seqSchema,
  issued_at: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
};

const chained = { ...base, prev: hex64Schema };

/**
 * The format 1 lock entry. Unknown fields are dropped. An unknown value of
 * a known field (a `can` value, a principal kind) is refused. The genesis
 * may not carry `prev`.
 */
export const lockEntrySchema: z.ZodType<LockEntryPayload> =
  z.discriminatedUnion("op", [
    z.object({
      ...base,
      prev: z.never().optional(),
      op: z.literal("genesis"),
      root_keys: z
        .array(z.object({ key_id: hex64Schema, name: z.string().min(1) }))
        .min(1),
      recovery: recoverySchema,
    }),
    z.object({
      ...chained,
      op: z.literal("add_root_key"),
      key_id: hex64Schema,
      name: z.string().min(1),
    }),
    z.object({
      ...chained,
      op: z.literal("remove_root_key"),
      key_id: hex64Schema,
    }),
    z.object({
      ...chained,
      op: z.literal("approve_key"),
      key_id: hex64Schema,
      principal: principalSchema,
      device_id: z.string().regex(DEVICE_ID),
      can: z.array(z.literal("sign_rules")).min(1),
    }),
    z.object({ ...chained, op: z.literal("revoke_key"), key_id: hex64Schema }),
    z.object({
      ...chained,
      op: z.literal("set_recovery"),
      recovery: recoverySchema,
    }),
    z.object({ ...chained, op: z.literal("disable") }),
  ]) as z.ZodType<LockEntryPayload>;

export const lockSignatureSchema = z.object({
  kind: z.string().min(1),
  key_id: hex64Schema,
  sig: z.string(),
});
