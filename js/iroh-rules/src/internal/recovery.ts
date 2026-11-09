/**
 * Recovery codes of a locked org: make them, compute their check values,
 * and test a code or a recovery message. A code turns the lock off without
 * a lock key. Rate limits and the list of turned-off locks are the
 * caller's job.
 */
import { z } from "zod";
import { constantTimeEqual, sha256Hex } from "./crypto";
import { fromBase32, fromBase64Url, toBase32, toBase64Url } from "./encoding";
import {
  groupsOfFour,
  RECOVERY_SALT_BYTES,
  type LockState,
  type RecoveryData,
} from "./lock";
import { hex64Schema } from "./rules";

/** The text that starts every check value's hash input, before a zero byte. */
export const RECOVERY_CONTEXT = "amika-iroh-recovery-v1";

/** A recovery code is this many random bytes. */
export const RECOVERY_CODE_BYTES = 20;

/** `amika lock init` makes this many codes. */
export const RECOVERY_CODE_COUNT = 5;

/**
 * Make `count` recovery codes and a new salt for `orgId`. Returns the
 * codes as people see them, and the data for a genesis or `set_recovery`.
 * Show the codes once. Store only `recovery`.
 */
export async function makeRecoveryCodes(
  orgId: string,
  count: number = RECOVERY_CODE_COUNT,
): Promise<{ codes: string[]; recovery: RecoveryData }> {
  const salt = toBase64Url(randomBytes(RECOVERY_SALT_BYTES));
  const codes: string[] = [];
  const checks: string[] = [];
  for (let i = 0; i < count; i++) {
    const code = randomBytes(RECOVERY_CODE_BYTES);
    codes.push(formatRecoveryCode(code));
    checks.push(await recoveryCheckValue(orgId, salt, code));
  }
  return { codes, recovery: { salt, checks } };
}

/** A code as people see it: lowercase base32, 8 groups of 4, joined by `-`. */
export function formatRecoveryCode(code: Uint8Array): string {
  if (code.length !== RECOVERY_CODE_BYTES) {
    throw new TypeError(`a recovery code is ${RECOVERY_CODE_BYTES} bytes`);
  }
  return groupsOfFour(toBase32(code));
}

/**
 * Read a code that a person typed. Case, whitespace and `-` do not matter.
 * Returns `null` unless the text is exactly 20 bytes of base32.
 */
export function parseRecoveryCode(text: string): Uint8Array | null {
  const bytes = fromBase32(text.toLowerCase().replace(/[\s-]/g, ""));
  return bytes?.length === RECOVERY_CODE_BYTES ? bytes : null;
}

/**
 * The check value of one code:
 * `hex(SHA-256("amika-iroh-recovery-v1" || 0x00 || org_id || 0x00 || salt || code))`.
 * `org_id` is UTF-8. `salt` is the 16 decoded salt bytes, and `code` the
 * 20 code bytes.
 */
export async function recoveryCheckValue(
  orgId: string,
  salt: string,
  code: Uint8Array,
): Promise<string> {
  const saltBytes = fromBase64Url(salt);
  if (saltBytes?.length !== RECOVERY_SALT_BYTES) {
    throw new TypeError("a recovery salt is 16 bytes of base64url");
  }
  const encoder = new TextEncoder();
  return sha256Hex(
    concat(
      encoder.encode(RECOVERY_CONTEXT),
      ZERO,
      encoder.encode(orgId),
      ZERO,
      saltBytes,
      code,
    ),
  );
}

/**
 * Whether `code` (as typed) matches one of the check values. It compares
 * with every check value in constant time.
 */
export async function testRecoveryCode(
  recovery: RecoveryData,
  orgId: string,
  code: string,
): Promise<boolean> {
  const bytes = parseRecoveryCode(code);
  if (bytes === null || fromBase64Url(recovery.salt) === null) return false;
  const check = await recoveryCheckValue(orgId, recovery.salt, bytes);
  let found = false;
  for (const candidate of recovery.checks) {
    if (constantTimeEqual(candidate, check)) found = true;
  }
  return found;
}

/** Turns a lock off. It needs no signature: a correct code is the proof. */
export interface RecoveryMessage {
  type: "recover";
  org_id: string;
  lock_id: string;
  code: string;
}

export type RecoveryRefusal =
  | "malformed"
  | "wrong_org"
  | "wrong_lock"
  | "wrong_code";

export type RecoveryCheck =
  | { ok: true; message: RecoveryMessage }
  | { ok: false; reason: RecoveryRefusal; detail: string };

/**
 * Check a recovery message against a lock state: its org, its lock id,
 * then its code against the state's check values. On `ok`, the caller
 * turns the lock off and adds the lock id to its turned-off locks.
 */
export async function checkRecoveryMessage(
  message: unknown,
  lock: LockState,
): Promise<RecoveryCheck> {
  const parsed = recoveryMessageSchema.safeParse(message);
  if (!parsed.success) {
    return { ok: false, reason: "malformed", detail: "not a recover message" };
  }
  const { org_id, lock_id, code } = parsed.data;
  if (org_id !== lock.org_id) {
    return { ok: false, reason: "wrong_org", detail: `org ${org_id}` };
  }
  if (lock_id !== lock.lock_id) {
    return { ok: false, reason: "wrong_lock", detail: `lock ${lock_id}` };
  }
  if (!(await testRecoveryCode(lock.recovery, lock.org_id, code))) {
    return { ok: false, reason: "wrong_code", detail: "the code is wrong" };
  }
  return { ok: true, message: parsed.data };
}

const recoveryMessageSchema = z.object({
  type: z.literal("recover"),
  org_id: z.string().min(1),
  lock_id: hex64Schema,
  code: z.string(),
});

const ZERO = new Uint8Array([0]);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}
