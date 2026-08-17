/**
 * `@amika/sandbox` — the sandbox provisioner.
 *
 * Server entry (the `.` export). The single contract is {@link SandboxProvider}
 * (create / start / stop / delete / exec / ssh, plus the optional log-streaming,
 * snapshot, and docker-registry capabilities gated by `capabilities`). Resolve a
 * provider with {@link createSandboxProvider}.
 *
 * Client components must import capability/label helpers from
 * `@amika/sandbox/capabilities` (SDK-free) rather than this barrel.
 */

// Core contract: interfaces, error classes, input/result types, the
// SnapshotIdResolver port, and the re-exported SandboxProviderName /
// SandboxService.
export * from "./providers/provider";
// Provider factory + deps + name guard.
export * from "./providers/registry";
// Capability flags + display helpers (also the client-safe `./capabilities` entry).
export * from "./providers/capabilities";

// Two-track lifecycle status.
export {
  SANDBOX_STATUS_VALUES,
  SANDBOX_SETUP_STATUS_VALUES,
  parseSandboxSetupStatus,
  isSetupInProgress,
  deriveSandboxStatus,
  type SandboxStatus,
  type SandboxSetupStatus,
} from "./sandbox-status";

// Config: the shared base plus each provider's own config slice (defined in its
// provider folder), enums, shared provider types (names + service shapes),
// on-box constants, logging contract.
export * from "./config";
export type { DaytonaConfig } from "./providers/daytona/config";
export type { FreestyleConfig } from "./providers/freestyle/config";
export type { SailboxConfig } from "./providers/sailbox/config";
export type { VercelConfig } from "./providers/vercel/config";
// Server-only env → config-slice factory (the single provider env-var contract).
export {
  sandboxProviderConfigsFromEnv,
  type SandboxProviderConfigs,
} from "./config-from-env";
export * from "./enums";
export * from "./types";
export * from "./constants";
export * from "./logger";

// Deep helpers consumed by the control plane (provider sizing, Freestyle
// naming, the adapter port + fake, github-auth script builders).
export {
  freestyleSizingForSize,
  type FreestyleSizing,
} from "./providers/freestyle/sizing";
export {
  sailboxSizingForSize,
  type SailboxSizing,
} from "./providers/sailbox/sizing";
export {
  encodeSailboxImageRef,
  decodeSailboxImageRef,
} from "./providers/sailbox/image-ref";
export {
  vercelSizingForSize,
  vercelVcpusForSize,
  type VercelSizing,
} from "./providers/vercel/sizing";
export {
  buildFreestyleSnapshotName,
  buildFreestyleVmName,
  freestyleVmNameOrgId,
  freestyleVmBelongsToOrg,
} from "./providers/freestyle/naming";
export {
  execChecked,
  execFailureText,
  type SandboxAdapter,
  type ExecOptions,
  type ExecResult,
} from "./providers/shared/adapter";

// Provisioning seam: the generic mechanics the lifecycle flows drive the
// sandbox through. Exported here so callers can import them from the barrel
// without a reverse (circular) dependency on core internals.
export {
  getWorkspaceDir,
  getRepoDir,
} from "./providers/shared/adapter-helpers";
export { buildLifecycleCommands } from "./providers/shared/lifecycle-commands";
export { EXEC_INPUT_STAGING_ROOT } from "./providers/shared/exec-input";
export { shellQuote } from "./util/shell";
export {
  buildGitCheckoutNewBranchCmd,
  buildGitSetPlainRemoteCmd,
  buildRefreshClonedRepoScript,
  checkBranchExistsOnRemote,
} from "./util/git-clone";
export { getRepoNameFromGithubUrl } from "./util/github";
