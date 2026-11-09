/**
 * Verify a lock log and reduce it to a `LockState`, by "Rules for every
 * verifier" in `iroh-contracts.md`. Pure: the caller stores the log and
 * the state.
 */
import { z } from "zod";
import { contextMessage, sha256Hex, verifyEd25519 } from "./crypto";
import { fromBase64Url } from "./encoding";
import {
  LOCK_FORMAT,
  LOCK_OPS,
  LOCK_SIGNATURE_CONTEXT,
  lockEntrySchema,
  lockSignatureSchema,
  MAX_LOCK_ENTRY_BYTES,
  MAX_LOCK_LOG_ENTRIES,
  MAX_ROOT_KEYS,
  ORG_SIGNER_KIND,
  type LockEntryPayload,
  type LockState,
} from "./lock";
import { envelopeSchema } from "./rules";
import { describe, parseJson } from "./verify";

/** The lock entry formats a verifier on this package reads. */
export const LOCK_SUPPORTED_FORMATS: readonly number[] = [LOCK_FORMAT];

/** The lock entry required features a verifier on this package knows. */
export const LOCK_SUPPORTED_FEATURES: readonly string[] = [];

/** Why a verifier refuses a lock entry, and with it the rest of the log. */
export type LockRefusal =
  | "malformed"
  | "too_large"
  | "too_many_entries"
  | "bad_signature"
  | "untrusted_signer"
  | "missing_signature"
  | "unknown_format"
  | "unknown_feature"
  | "unknown_op"
  | "wrong_org"
  | "bad_seq"
  | "bad_prev"
  | "disabled"
  | "invalid_change";

export interface LockVerifyOptions {
  /** The verifier's org. An entry for another org is refused. */
  orgId: string;
  /** Lock entry formats the verifier reads. Default `LOCK_SUPPORTED_FORMATS`. */
  knownFormats?: readonly number[];
  /** Required features the verifier knows. Default `LOCK_SUPPORTED_FEATURES`. */
  knownFeatures?: readonly string[];
}

/**
 * The state after the last entry, or the refusal of the first bad entry.
 * `index` is that entry's position in the `entries` argument.
 */
export type LockResult =
  | { ok: true; state: LockState }
  | { ok: false; reason: LockRefusal; index: number; detail: string };

/**
 * Verify a whole lock log, from its genesis, and reduce it to a state.
 * Every entry must verify. A verifier stores nothing from a refused log.
 */
export async function verifyLockLog(
  entries: unknown,
  options: LockVerifyOptions,
): Promise<LockResult> {
  if (!Array.isArray(entries) || entries.length === 0) {
    return refuse("malformed", 0, "a lock log is a non-empty list");
  }
  if (entries.length > MAX_LOCK_LOG_ENTRIES) {
    return refuse(
      "too_many_entries",
      MAX_LOCK_LOG_ENTRIES,
      `a lock log has at most ${MAX_LOCK_LOG_ENTRIES} entries`,
    );
  }
  const genesis = await applyGenesis(entries[0], options);
  if (!genesis.ok) return genesis;
  const rest = await appendLockEntries(
    genesis.state,
    entries.slice(1),
    options,
  );
  return rest.ok ? rest : { ...rest, index: rest.index + 1 };
}

/**
 * Verify `entries`, which continue the log that `state` reduces, and
 * return the new state. `state` must come from `verifyLockLog` or from
 * this function. It is not changed.
 */
export async function appendLockEntries(
  state: LockState,
  entries: unknown,
  options: LockVerifyOptions,
): Promise<LockResult> {
  if (!Array.isArray(entries)) {
    return refuse("malformed", 0, "lock entries are a list");
  }
  let current = state;
  for (const [index, raw] of entries.entries()) {
    const next = await applyEntry(current, raw, options);
    if (!next.ok) return refuse(next.reason, index, next.detail);
    current = next.state;
  }
  return { ok: true, state: current };
}

type Step =
  | { ok: true; state: LockState }
  | { ok: false; reason: LockRefusal; detail: string };

type Refused = { ok: false; reason: LockRefusal; detail: string };

function refuse(
  reason: LockRefusal,
  index: number,
  detail: string,
): { ok: false; reason: LockRefusal; index: number; detail: string } {
  return { ok: false, reason, index, detail };
}

function fail(reason: LockRefusal, detail: string): Refused {
  return { ok: false, reason, detail };
}

/**
 * Entry 0. No key is trusted yet: the lock id is trusted by the lock
 * offer or by the fingerprint. Each root key that the genesis names must
 * sign it.
 */
async function applyGenesis(
  raw: unknown,
  options: LockVerifyOptions,
): Promise<{ ok: true; state: LockState } | ReturnType<typeof refuse>> {
  const read = readEnvelope(raw);
  if (!read.ok) return { ...read, index: 0 };
  const signers = await verifySignatures(read.bytes, read.signatures);
  if (signers.verified.size === 0) {
    return refuse(
      signers.failed.size > 0 ? "bad_signature" : "missing_signature",
      0,
      "no signature on the genesis verifies",
    );
  }
  const parsed = parseEntry(read.bytes, options);
  if (!parsed.ok) return { ...parsed, index: 0 };
  const entry = parsed.entry;
  if (entry.org_id !== options.orgId) {
    return refuse("wrong_org", 0, `org ${entry.org_id}`);
  }
  if (entry.op !== "genesis" || entry.seq !== 0) {
    return refuse("bad_seq", 0, "entry 0 must be a genesis with seq 0");
  }
  const keys = entry.root_keys.map((k) => k.key_id);
  if (keys.length > MAX_ROOT_KEYS || new Set(keys).size !== keys.length) {
    return refuse(
      "invalid_change",
      0,
      `the genesis names 1 to ${MAX_ROOT_KEYS} different root keys`,
    );
  }
  for (const key of keys) {
    const missing = requireSigner(
      signers,
      [key],
      `root key ${key}`,
      "missing_signature",
    );
    if (missing !== null) return { ...missing, index: 0 };
  }
  const lockId = await sha256Hex(read.bytes);
  return {
    ok: true,
    state: {
      org_id: entry.org_id,
      lock_id: lockId,
      seq: 0,
      head: lockId,
      root_keys: entry.root_keys.map(({ key_id, name }) => ({ key_id, name })),
      admin_keys: [],
      removed_keys: [],
      recovery: entry.recovery,
      disabled: false,
    },
  };
}

/**
 * One entry after the genesis. A trusted lock key must sign it before its
 * payload is parsed. Then the checks run in this order: format, required
 * features, op, shape, org, seq, prev, the op's signers, the change.
 */
async function applyEntry(
  state: LockState,
  raw: unknown,
  options: LockVerifyOptions,
): Promise<Step> {
  if (state.disabled) {
    return fail("disabled", "the log takes no entries after a disable");
  }
  if (state.seq + 1 >= MAX_LOCK_LOG_ENTRIES) {
    return fail(
      "too_many_entries",
      `a lock log has at most ${MAX_LOCK_LOG_ENTRIES} entries`,
    );
  }
  const read = readEnvelope(raw);
  if (!read.ok) return read;
  const signers = await verifySignatures(read.bytes, read.signatures);
  const roots = state.root_keys.map((k) => k.key_id);
  const admins = state.admin_keys.map((k) => k.key_id);
  const trusted = requireSigner(signers, [...roots, ...admins], "a lock key");
  if (trusted !== null) return trusted;

  const parsed = parseEntry(read.bytes, options);
  if (!parsed.ok) return parsed;
  const entry = parsed.entry;
  if (entry.org_id !== state.org_id || entry.org_id !== options.orgId) {
    return fail("wrong_org", `org ${entry.org_id}`);
  }
  if (entry.seq !== state.seq + 1 || entry.op === "genesis") {
    return fail("bad_seq", `seq ${entry.seq}, expected ${state.seq + 1}`);
  }
  if (entry.prev !== state.head) {
    return fail("bad_prev", `prev ${entry.prev}, expected ${state.head}`);
  }
  const signed = checkOpSigners(entry, signers, roots, admins);
  if (signed !== null) return signed;
  const next = applyChange(state, entry);
  if (!next.ok) return next;
  return {
    ok: true,
    state: { ...next.state, seq: entry.seq, head: await sha256Hex(read.bytes) },
  };
}

/** The signers each op needs, beyond "a trusted lock key". */
function checkOpSigners(
  entry: Exclude<LockEntryPayload, { op: "genesis" }>,
  signers: Signers,
  roots: string[],
  admins: string[],
): Refused | null {
  switch (entry.op) {
    case "add_root_key":
      return (
        requireSigner(signers, roots, "a root key") ??
        requireSigner(
          signers,
          [entry.key_id],
          `the new key ${entry.key_id}`,
          "missing_signature",
        )
      );
    case "remove_root_key":
      return requireSigner(
        signers,
        roots.filter((key) => key !== entry.key_id),
        "another root key",
      );
    case "revoke_key":
      return requireSigner(signers, [...roots, ...admins], "a lock key");
    case "approve_key":
    case "set_recovery":
    case "disable":
      return requireSigner(signers, roots, "a root key");
    default:
      return assertNever(entry);
  }
}

/** Apply a verified, signed entry's change, or refuse a change it breaks. */
function applyChange(
  state: LockState,
  entry: Exclude<LockEntryPayload, { op: "genesis" }>,
): Step {
  const roots = state.root_keys.map((k) => k.key_id);
  const admins = state.admin_keys.map((k) => k.key_id);
  const known = new Set([...roots, ...admins, ...state.removed_keys]);
  switch (entry.op) {
    case "add_root_key":
      if (known.has(entry.key_id)) {
        return fail("invalid_change", `key ${entry.key_id} is already known`);
      }
      if (roots.length >= MAX_ROOT_KEYS) {
        return fail("invalid_change", `at most ${MAX_ROOT_KEYS} root keys`);
      }
      return next({
        root_keys: [
          ...state.root_keys,
          { key_id: entry.key_id, name: entry.name },
        ],
      });
    case "remove_root_key":
      if (!roots.includes(entry.key_id)) {
        return fail("invalid_change", `key ${entry.key_id} is not a root key`);
      }
      if (roots.length <= 1) {
        return fail("invalid_change", "at least 1 root key must stay");
      }
      return next({
        root_keys: state.root_keys.filter((k) => k.key_id !== entry.key_id),
        removed_keys: [...state.removed_keys, entry.key_id],
      });
    case "approve_key":
      if (known.has(entry.key_id)) {
        return fail("invalid_change", `key ${entry.key_id} is already known`);
      }
      return next({
        admin_keys: [
          ...state.admin_keys,
          {
            key_id: entry.key_id,
            principal: entry.principal,
            device_id: entry.device_id,
            can: entry.can,
          },
        ],
      });
    case "revoke_key":
      if (!admins.includes(entry.key_id)) {
        return fail(
          "invalid_change",
          `key ${entry.key_id} is not an admin key`,
        );
      }
      return next({
        admin_keys: state.admin_keys.filter((k) => k.key_id !== entry.key_id),
        removed_keys: [...state.removed_keys, entry.key_id],
      });
    case "set_recovery":
      return next({ recovery: entry.recovery });
    case "disable":
      return next({ disabled: true });
    default:
      return assertNever(entry);
  }

  function next(change: Partial<LockState>): Step {
    return { ok: true, state: { ...state, ...change } };
  }
}

/** A lock entry envelope, decoded and size-checked. */
function readEnvelope(
  raw: unknown,
):
  | { ok: true; bytes: Uint8Array; signatures: unknown[] }
  | { ok: false; reason: LockRefusal; detail: string } {
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("malformed", `envelope: ${describe(parsed.error)}`);
  }
  const bytes = fromBase64Url(parsed.data.payload);
  if (bytes === null) {
    return fail("malformed", "payload is not base64url with no padding");
  }
  if (bytes.length > MAX_LOCK_ENTRY_BYTES) {
    return fail(
      "too_large",
      `${bytes.length} bytes, at most ${MAX_LOCK_ENTRY_BYTES}`,
    );
  }
  return { ok: true, bytes, signatures: parsed.data.signatures };
}

/** The keys whose `org` signature verifies, and those whose does not. */
interface Signers {
  verified: Set<string>;
  failed: Set<string>;
}

/**
 * Check every signature of kind `org` on the payload bytes. A signature of
 * another kind or an unknown shape counts for nothing.
 */
async function verifySignatures(
  bytes: Uint8Array,
  signatures: unknown[],
): Promise<Signers> {
  const message = contextMessage(LOCK_SIGNATURE_CONTEXT, bytes);
  const verified = new Set<string>();
  const failed = new Set<string>();
  for (const raw of signatures) {
    const parsed = lockSignatureSchema.safeParse(raw);
    if (!parsed.success || parsed.data.kind !== ORG_SIGNER_KIND) continue;
    const { key_id, sig } = parsed.data;
    if (await verifyEd25519(key_id, sig, message)) verified.add(key_id);
    else failed.add(key_id);
  }
  return { verified, failed };
}

/**
 * Refuse unless one key of `keys` signed. `bad_signature` when such a key
 * has only a signature that does not verify. Otherwise `missing`:
 * `untrusted_signer` when any trusted key would do, `missing_signature`
 * when one named key must sign.
 */
function requireSigner(
  signers: Signers,
  keys: readonly string[],
  what: string,
  missing: LockRefusal = "untrusted_signer",
): Refused | null {
  if (keys.some((key) => signers.verified.has(key))) return null;
  if (keys.some((key) => signers.failed.has(key))) {
    return fail("bad_signature", `${what}: bad signature`);
  }
  return fail(missing, `${what} did not sign`);
}

const opSchema = z.object({ op: z.string() });

/**
 * Parse signed payload bytes, in this order: UTF-8 JSON, a known format,
 * known required features, a known op, then the op's shape.
 */
function parseEntry(
  bytes: Uint8Array,
  options: LockVerifyOptions,
): { ok: true; entry: LockEntryPayload } | Refused {
  const json = parseJson(bytes);
  if (json === undefined) return fail("malformed", "payload is not UTF-8 JSON");
  const format = z.object({ format: z.number().int() }).safeParse(json);
  if (!format.success) {
    return fail("malformed", `payload: ${describe(format.error)}`);
  }
  const knownFormats = options.knownFormats ?? LOCK_SUPPORTED_FORMATS;
  if (!knownFormats.includes(format.data.format)) {
    return fail("unknown_format", `format ${format.data.format}`);
  }
  const features = z
    .object({ required_features: z.array(z.string()) })
    .safeParse(json);
  if (!features.success) {
    return fail("malformed", `payload: ${describe(features.error)}`);
  }
  const knownFeatures = options.knownFeatures ?? LOCK_SUPPORTED_FEATURES;
  const unknown = features.data.required_features.filter(
    (feature) => !knownFeatures.includes(feature),
  );
  if (unknown.length > 0) {
    return fail("unknown_feature", `required: ${unknown.join(", ")}`);
  }
  const op = opSchema.safeParse(json);
  if (!op.success) return fail("malformed", `payload: ${describe(op.error)}`);
  if (!(LOCK_OPS as readonly string[]).includes(op.data.op)) {
    return fail("unknown_op", `op ${op.data.op}`);
  }
  const entry = lockEntrySchema.safeParse(json);
  if (!entry.success) {
    return fail("malformed", `payload: ${describe(entry.error)}`);
  }
  return { ok: true, entry: entry.data };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${String(value)}`);
}
