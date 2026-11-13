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
 * Runs in Node 22+ and in Cloudflare Workers: Web Crypto Ed25519 only.
 */
export {
  AMIKA_SIGNER_KIND,
  RULES_FORMAT,
  SIGNATURE_CONTEXT,
  type DeviceRule,
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
