/**
 * `@amika/iroh-rules`: the signed rules record of the iroh transport, as
 * spec 035's `iroh-contracts.md` fixes it.
 *
 * - The control plane encodes a payload and signs it (`encodePayload`,
 *   `signRules`).
 * - hostd verifies an envelope before it reads it (`verifyRules`), then
 *   runs check 1 for each connection (`checkPeer`) and check 2 for each
 *   stream (`checkTarget`).
 *
 * Locked orgs (phase 1b) add:
 *
 * - the lock log: `encodeLockEntry`, `signLockEntry`, `verifyLockLog`,
 *   `appendLockEntries`, the lock id and the fingerprint;
 * - rules that a lock key signs: `verifyLockedRules`;
 * - recovery codes: `makeRecoveryCodes`, `testRecoveryCode`,
 *   `checkRecoveryMessage`;
 * - signed requests to hostd's API: `encodeRequestPayload`, `signRequest`,
 *   `checkSignedRequest`.
 *
 * Runs in Node 22+ and in Cloudflare Workers: Web Crypto Ed25519 only.
 */
export {
  AMIKA_SIGNER_KIND,
  RULES_FORMAT,
  SIGNATURE_CONTEXT,
  type AmikaAccessGrant,
  type AmikaAccessKind,
  type DeviceRule,
  type LockOffer,
  type LockRef,
  type PortAccess,
  type Principal,
  type PrincipalRule,
  type RigAccess,
  type RoleRule,
  type RulesEnvelope,
  type RulesPayload,
  type RulesSignature,
  type ServiceRule,
} from "./internal/rules";
export {
  encodePayload,
  rulesPublicKey,
  signRules,
  type RulesSigner,
} from "./internal/sign";
export {
  SUPPORTED_FEATURES,
  SUPPORTED_FORMATS,
  verifyRules,
  type VerifiedSigner,
  type VerifyOptions,
  type VerifyRefusal,
  type VerifyResult,
} from "./internal/verify";
export {
  checkPeer,
  checkTarget,
  type AllowedPeer,
  type PeerCheck,
  type RefusalReason,
  type TargetCheck,
} from "./internal/decide";
export {
  formatTarget,
  parseEndpointId,
  parseTarget,
  type Target,
} from "./internal/ids";
export {
  DEVICE_SIGNER_KIND,
  encodeLockEntry,
  formatFingerprint,
  LOCK_FEATURE,
  LOCK_FORMAT,
  LOCK_OPS,
  LOCK_SIGNATURE_CONTEXT,
  lockEntryHash,
  lockFingerprint,
  MAX_LOCK_ENTRY_BYTES,
  MAX_LOCK_LOG_ENTRIES,
  MAX_RECOVERY_CHECKS,
  MAX_ROOT_KEYS,
  ORG_SIGNER_KIND,
  RECOVERY_SALT_BYTES,
  sameFingerprint,
  signLockEntry,
  type AdminKey,
  type KeyCapability,
  type LockEntryEnvelope,
  type LockEntryPayload,
  type LockOp,
  type LockSignature,
  type LockState,
  type RecoveryData,
  type RootKey,
} from "./internal/lock";
export {
  appendLockEntries,
  LOCK_SUPPORTED_FEATURES,
  LOCK_SUPPORTED_FORMATS,
  verifyLockLog,
  type LockRefusal,
  type LockResult,
  type LockVerifyOptions,
} from "./internal/lock-verify";
export {
  LOCK_HOST_FEATURES,
  verifyLockedRules,
  type LockedSigner,
  type LockedVerifyOptions,
  type LockedVerifyRefusal,
  type LockedVerifyResult,
} from "./internal/locked-rules";
export {
  checkRecoveryMessage,
  formatRecoveryCode,
  makeRecoveryCodes,
  parseRecoveryCode,
  RECOVERY_CODE_BYTES,
  RECOVERY_CODE_COUNT,
  RECOVERY_CONTEXT,
  recoveryCheckValue,
  testRecoveryCode,
  type RecoveryCheck,
  type RecoveryMessage,
  type RecoveryRefusal,
} from "./internal/recovery";
export {
  bodySha256,
  checkSignedRequest,
  encodeRequestPayload,
  encodeSignedRequestHeader,
  makeRequestNonce,
  MAX_REQUEST_LIFETIME_MS,
  MAX_REQUEST_OPS,
  MAX_SIGNED_REQUEST_HEADER_BYTES,
  REQUEST_CLOCK_SKEW_MS,
  REQUEST_FORMAT,
  REQUEST_NONCE_BYTES,
  REQUEST_SIGNATURE_CONTEXT,
  REQUEST_SUPPORTED_FEATURES,
  REQUEST_SUPPORTED_FORMATS,
  signRequest,
  SIGNED_REQUEST_HEADER,
  type AcceptedRequest,
  type RequestAccess,
  type RequestOperation,
  type RequestSignature,
  type RequestSigner,
  type SignedRequestCheck,
  type SignedRequestContext,
  type SignedRequestEnvelope,
  type SignedRequestInput,
  type SignedRequestPayload,
  type SignedRequestRefusal,
  type UsedOperationStore,
} from "./internal/request";
