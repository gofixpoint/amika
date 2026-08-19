/**
 * Amika-agnostic primitive sandbox-provider interfaces.
 *
 * `@amika/sandbox` is a standalone package for provisioning and manipulating
 * provider sandboxes. It deliberately knows nothing about Amika workflows or
 * product features. Concrete providers implement {@link SandboxProvider};
 * consumers resolve one through the registry and compose these primitives.
 * Higher-level Amika lifecycle and agent behavior belongs in
 * `@amika/sandbox-provisioning`, which wraps this package.
 *
 * Nothing here may import a provider SDK (`@daytonaio/sdk`, etc.) or a
 * provider-specific module. Shared types are defined here so the abstraction
 * owns them.
 */
import type { SandboxCtx } from "../logger";
import type { SandboxProviderName, SandboxService } from "../types";
import type { SandboxStatus } from "../sandbox-status";
import type { GithubAuthMode } from "../enums";

export type { SandboxProviderName, SandboxService } from "../types";

/**
 * Raised when a consumer invokes an operation a provider does not implement.
 * Capability flags (see {@link SandboxProviderCapabilities}) let callers avoid
 * this for the gated operations (ssh, lifecycle, exec, snapshots, …); it is the
 * backstop for everything else.
 */
export class SandboxProviderUnsupportedError extends Error {
  readonly provider: string;
  readonly operation: string;
  constructor(provider: string, operation: string) {
    super(
      `Sandbox provider "${provider}" does not support operation "${operation}"`,
    );
    this.name = "SandboxProviderUnsupportedError";
    this.provider = provider;
    this.operation = operation;
  }
}

/**
 * Thrown when a repository clone fails inside a freshly provisioned sandbox.
 * Carries the original cause so the create flow can map known git errors onto
 * actionable API errors. Provider-agnostic: any provider that clones a repo
 * during initialization throws this.
 */
export class RepositoryCloneError extends Error {
  constructor(repoUrl: string, cause: unknown) {
    const inner =
      cause instanceof Error ? cause.message : "Unknown clone error";
    super(
      `Failed to clone repository ${repoUrl} inside the sandbox: ${inner}. ` +
        "Check that your GitHub token has access to this repository.",
    );
    this.name = "RepositoryCloneError";
    this.cause = cause;
  }
}

/**
 * Thrown by the shared lifecycle-script runner when a *user* lifecycle script
 * (`setup.sh` on create, `start.sh` on start) exits non-zero. The system hooks
 * around it (pre-setup/post-setup) still run before this is raised, so the
 * sandbox's agent server comes up and the VM stays usable; failures of the
 * hooks themselves surface as plain errors (a system-setup problem, not a
 * user-script one).
 */
export class SetupScriptError extends Error {
  /** Which user lifecycle script failed. */
  readonly phase: "setup" | "start";
  constructor(phase: "setup" | "start", cause: unknown) {
    const inner =
      cause instanceof Error ? cause.message : "Unknown script error";
    super(
      phase === "setup"
        ? `Setup script failed: ${inner}`
        : `Start script failed: ${inner}`,
    );
    this.name = "SetupScriptError";
    this.phase = phase;
    this.cause = cause;
  }
}

/**
 * A setup problem an initialization / lifecycle-rerun hit while the VM itself
 * stayed usable. Providers record it and *finish* initializing (agent server,
 * signed URLs) instead of aborting, so the caller can mark the sandbox running
 * with this as its setup sub-status rather than tearing the VM down.
 *
 * `git-failed` strictly means the *primary* repo is missing (the agent's cwd
 * doesn't exist) — consumers make control decisions on that (skipping the
 * workflow kickoff, failing a Slack turn fast). Everything else that leaves
 * the workspace usable but incompletely set up — a failed user script or a
 * failed additional-repo clone — is `setup-failed`. System-setup failures are
 * not represented here — providers can't always finish after those, so they
 * throw and the caller classifies the error.
 */
export interface SandboxSetupFailure {
  kind: "git-failed" | "setup-failed";
  message: string;
}

/**
 * A service-derived env var definition from `.amika/config.toml`:
 *   `MY_URL = { service = "web", field = "url" }`
 * Resolved against live service URLs/ports after a sandbox is provisioned.
 */
export interface ServiceEnvVarDef {
  name: string;
  service: string;
  field: "url" | "host" | "port";
}

/** An MCP integration to wire into the sandbox's agent config. */
export interface McpIntegrationInput {
  name: string;
  mcpServerType: string;
  mcpServerUrl: string;
  // Required for OAuth (http) integrations; omitted for stdio MCPs that
  // run locally in the sandbox with no auth (e.g. Playwright).
  accessToken?: string;
}

/** Lazy resolver for an agent credential (lazy keeps OAuth tokens fresh). */
export type AgentCredentialResolver = () => Promise<{
  value: string;
  type: "oauth" | "api_key";
} | null>;

/**
 * Request to provision a new provider sandbox.
 *
 * The Amika-flavored fields are documented in place: `services` is load-bearing on
 * Vercel (the exposed-port set is fixed at create), and
 * `amikaOpenCodeWeb`/`scrubSafe`/`labels` are an accepted residual exception
 * (Daytona's non-login exec inherits the container env, so the
 * non-secret operational keys are baked at create).
 */
export interface CreateSandboxProviderInput {
  name: string;
  snapshot: string;
  /**
   * Literal resources selected by the caller. Providers that size at create
   * consume the supported dimensions directly; providers with pre-sized boot
   * sources receive the same allocation alongside the selected `snapshot`.
   * Product tier names and their resource mappings belong to the caller.
   */
  resources?: SandboxResources;
  githubUrl?: string;
  repoName?: string | null;
  amikaOpenCodeWeb?: string | null;
  autoStopInterval?: number;
  autoDeleteInterval?: number;
  /**
   * The full service list to seed the sandbox with — including Amika's default
   * "Coding Agent" (OpenCode) service. Built by the caller and passed in;
   * the provider records it rather than deciding services of its own.
   */
  services: SandboxService[];
  labels?: Record<string, string>;
  /**
   * Whether the base snapshot is known to have no Amika-injected secrets
   * baked into its container env. Only when true is the sandbox stamped
   * with the scrub-safe marker that gates "snapshot and delete". Defaults
   * to false (untrusted) when omitted.
   */
  scrubSafe?: boolean;
}

/** Result of provisioning a provider sandbox (pre-initialization). */
export interface CreatedProviderSandbox {
  provider: string;
  providerSandboxId: string;
  providerUrl: string | null;
  services: SandboxService[];
  /** Operational (non-secret) env vars baked into the container, if any. */
  envVars?: Record<string, string>;
}

/** Full initialization request: clone, credentials, lifecycle scripts, URLs. */
export interface InitializeSandboxInput {
  providerSandboxId: string;
  /**
   * The Amika sandbox name. Persisted into the managed base env as
   * `AMIKA_SANDBOX_NAME` so every shell session and the launched agent can
   * identify which sandbox they're running in. Threaded through (rather than
   * read from the provider) because the name is owned by the caller, not stored
   * in the provider's sandbox metadata.
   */
  sandboxName: string;
  /** Lifecycle/base env vars that should be present in shell sessions. */
  envVars: Record<string, string> | null;
  setupScript: string;
  githubUrl?: string;
  branch?: string;
  /** When set, create this branch (off the cloned branch) and check it out. */
  newBranch?: string;
  /**
   * Extra repos to clone alongside the primary repo, from `[filesystem] repos`
   * in `.amika/config.toml`. Each is cloned at its default branch into
   * `~/workspace/<repoName>`. Only cloned during initialization; restart does
   * not re-clone (repos are already on disk), so this is unused on the rerun
   * path. Only the Daytona provider honors this today.
   */
  additionalRepos?: string[];
  repoName?: string | null;
  githubToken?: string | null;
  /**
   * GitHub runtime auth mode. `"pat"` (default when absent)
   * writes the static credential files; `"app_token"` installs a
   * callback-based credential helper + gh shim instead, and strips
   * the one-shot clone token from persisted git remotes. Creation-only:
   * the rerun path never re-installs.
   */
  githubAuthMode?: GithubAuthMode;
  resolveClaudeCredentials?: AgentCredentialResolver;
  resolveCodexCredentials?: AgentCredentialResolver;
  /** Resolver for the OpenCode OpenAI credential (lazy for OAuth freshness). */
  resolveOpenCodeOpenaiCredential?: AgentCredentialResolver;
  /** Anthropic API key for OpenCode (API key credentials only). */
  openCodeAnthropicApiKey?: string;
  /** OpenAI API key for OpenCode (eagerly resolved from api_key credential). */
  openCodeOpenaiApiKey?: string;
  openCodePort?: number;
  openCodePassword: string;
  amikaOpenCodeWeb?: string | null;
  injectedEnvVars?: Record<string, string>;
  gitUserName?: string;
  gitUserEmail?: string;
  mcpIntegrations?: McpIntegrationInput[];
  /** Service definitions created at sandbox provision time (with empty URLs). */
  services: SandboxService[];
  /** Service-derived env var definitions to resolve after URL refresh. */
  serviceEnvVars?: ServiceEnvVarDef[];
}

/**
 * Re-run the lifecycle on a restarted sandbox. Same shape as initialization
 * minus the create-only inputs (the repo is already cloned), plus the start
 * script to (re)upload.
 */
export type RerunLifecycleInput = Omit<
  InitializeSandboxInput,
  "setupScript" | "githubUrl" | "githubToken"
> & {
  startScript: string;
  /**
   * When true, skip re-running the start script (the start-phase lifecycle
   * step) on this restart. Honored by the Daytona and Vercel providers;
   * providers that don't wire it through always run the start script.
   */
  skipStartScript?: boolean;
};

/** Result of initialization / lifecycle re-run: the signed URLs to persist. */
export interface SandboxInitializeResult {
  providerUrl: string | null;
  services: SandboxService[];
  /**
   * A repo-clone or user-script failure the run absorbed while completing the
   * rest of initialization (see {@link SandboxSetupFailure}). Absent when
   * everything set up cleanly.
   */
  setupFailure?: SandboxSetupFailure;
}

/** Result of refreshing signed preview URLs for a sandbox's services. */
export interface RefreshUrlsResult {
  providerUrl: string | null;
  services: SandboxService[];
}

/**
 * Result of running a one-shot command inside a sandbox.
 *
 * The two streams are kept separate on purpose. Callers that parse a
 * command's *value* (a host key, a JSON document, a PID) must read
 * {@link stdout} only: a zero-exit command can still write to stderr
 * (`sudo` emits `unable to resolve host …` on many sandbox images), and
 * folding that into the value stream corrupts every such parser. Callers
 * reporting a *failure* should surface {@link stderr}, which is where the
 * diagnosis usually is.
 */
export interface SandboxExecResult {
  exitCode: number;
  /** Standard output only; never carries stderr text. */
  stdout: string;
  /** Standard error only; empty when the command wrote nothing to it. */
  stderr: string;
}

/**
 * Options for {@link SandboxProvider.executeCommand}. Every field is optional
 * and only the providers it applies to honor it; the rest ignore it (so an
 * omitted third argument is always safe).
 *
 * Both fields exist for providers whose sandboxes suspend and resume between
 * calls (Vercel). They let a caller that only needs a bare command run — an
 * agent launch, an exit probe — opt out of the full interactive-exec behavior
 * interactive/editor callers want:
 *
 *   - `resumeMode` — on a cold resume, `"restart-services"` (the default)
 *     relaunches the sandbox's lifecycle services (OpenCode, preview servers)
 *     so an interactive session is fully live; `"bare"` skips that relaunch,
 *     resuming only the filesystem. Use `"bare"` when the command doesn't need
 *     those services up and the relaunch would just add latency.
 *   - `sessionTimeoutMs` — reapply this idle-suspend timeout before running the
 *     command. A resumed sandbox otherwise reverts to the provider's short
 *     default and could suspend mid-command; set this on long-running work
 *     (e.g. an agent turn) whose caller can't re-drive the persisted interval.
 *   - `cwd` — working directory to run the command in.
 *   - `env` — extra environment variables to expose to the command (exported so
 *     they win over the managed base env).
 *   - `sudo` — run with root privileges. Providers whose default user is
 *     unprivileged (Daytona's/Vercel's sandbox user) translate this to `sudo`;
 *     providers that already exec as root (Freestyle) route it to a root handle.
 */
export interface ExecCommandOptions {
  resumeMode?: "restart-services" | "bare";
  sessionTimeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
  sudo?: boolean;
  /** Bytes delivered on stdin without embedding them in argv or logs. */
  input?: string;
}

/**
 * Literal sandbox resources, normalized to vCPUs and GiB. Create callers use
 * this shape to request an allocation without exposing product tier names to
 * the provider package; provider listings use it to report the allocation that
 * was actually provisioned.
 */
export interface SandboxResources {
  /** Provisioned vCPU count. */
  vcpus: number;
  /** Provisioned memory, gibibytes. */
  memoryGib: number;
  /** Provisioned disk, gibibytes. */
  diskGib: number;
}

export type ProviderSandboxSizing = SandboxResources;

/**
 * One account-wide sandbox as reported by {@link SandboxProvider.listSandboxes}.
 * Carries only what an out-of-band enumerator (e.g. a spend meter)
 * needs to attribute and price it: the provider handle, the org the create path
 * stamped on the resource (label/tag/name — `null` for an unstamped resource),
 * the raw provider state/status string (the consumer maps it to a bill mode),
 * and the normalized {@link ProviderSandboxSizing}. Resources whose size the
 * provider can't determine, and Freestyle's soft-deleted VMs, are omitted rather
 * than reported with a zero sizing.
 */
export interface ProviderSandboxListing {
  providerSandboxId: string;
  orgId: string | null;
  state: string;
  sizing: ProviderSandboxSizing;
}

/**
 * Resolves an org-scoped snapshot name to the provider's bootable handle
 * (`provider_snapshot_id`), or `null` when no handle is recorded yet or the name
 * is absent. Injected by the caller, which owns the name↔handle mapping.
 *
 * Name-native providers (Daytona, Freestyle) address snapshots by name and never
 * need this. Vercel snapshots are id-only, so its snapshot capability resolves the
 * id through this port, keeping the provider layer free of any storage coupling.
 * The resolver is invoked on demand (including per-poll in
 * `waitForSnapshotActive`), so it reflects a handle recorded asynchronously after
 * a capture starts.
 */
export type SnapshotIdResolver = (name: string) => Promise<string | null>;

/** Callbacks for streamed command output. */
export interface StreamCommandHandlers {
  onStdout: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

/**
 * The access a provider has minted: a bearer token, the SSH destination
 * (`[user@]host`) already parsed by the provider, and the expiry. Providers
 * own the command-shape parsing so consumers never re-parse a provider string.
 *
 * The two optional fields describe a WebSocket-tunneled SSH transport (Vercel):
 * the sandbox runs a real `sshd` reached through a `websocat` `ProxyCommand`
 * rather than a direct-dial gateway. They are absent for gateway providers
 * (Daytona, Freestyle), which embed the credential in `sshDestination` and dial
 * the host directly.
 */
export interface MintedSshAccess {
  token: string;
  sshDestination: string;
  expiresAt: Date;
  /**
   * The `wss://…` URL the client bridges SSH stdio through (via `websocat` as an
   * OpenSSH `ProxyCommand`). Present for WebSocket-tunneled SSH (Vercel exposes
   * the sandbox's `sshd` on a public port addressed over a WebSocket); absent
   * for direct-dial gateways whose `sshDestination` is itself a reachable host.
   */
  webSocketProxyUrl?: string;
  /**
   * An ephemeral PEM private key the client authenticates with, for providers
   * that mint a per-access keypair (Vercel injects the matching public key into
   * the sandbox user's `authorized_keys`). Absent for gateway providers that
   * embed the credential directly in `sshDestination`.
   */
  privateKey?: string;
}

/**
 * Inputs to {@link SandboxGitNamespace.clone}: clone one git repo into a
 * provisioned sandbox. `branch` falls back to the repo's default branch,
 * creating it if the requested branch is absent on the remote; an omitted
 * `repoName` clones directly into `~/workspace`.
 */
export interface CloneRepoInput {
  /** The sandbox user's home directory (repos land under `~/workspace`). */
  homeDir: string;
  githubUrl: string;
  repoName?: string | null;
  githubToken?: string | null;
  branch?: string;
  /**
   * Whether to check out the repo's git submodules as well. Defaults to `true`
   * when omitted: a repo that declares submodules is not usable without them,
   * and silently landing an empty submodule directory fails later, further
   * away, and far more confusingly than a slow clone does.
   *
   * Set this `false` only when the caller knows the extra fetch is wasted (no
   * submodules) or unauthorized (private submodules the sandbox's credential
   * cannot reach).
   *
   * Note that no provider SDK exposes a submodule option on its native clone
   * primitive, so honoring `true` means cloning over the exec port instead of
   * through {@link SandboxGitNamespace.clone}. See `resolveCloneRepo` in
   * amika-mono's `@amika/sandbox-provisioning`, which makes that choice.
   */
  recurseSubmodules?: boolean;
}

// ---------------------------------------------------------------------------
// Snapshot capability
// ---------------------------------------------------------------------------

/**
 * Provider-agnostic snapshot metadata. Describes the load-bearing fields the
 * UI/CLI use. Concrete provider objects typically carry more fields than this;
 * those extras flow through to API responses, which validate the snapshot
 * shape loosely (`.passthrough()`), so this type need only name what consumers
 * read — not mirror a provider's full DTO.
 */
export interface ProviderSnapshot {
  name: string;
  /**
   * The provider's own bootable handle for the snapshot, when distinct from the
   * name. Undefined for providers that boot by name (Daytona); the opaque
   * snapshot id for Freestyle. Lets consumers backfill a missing
   * `provider_snapshot_id` from a live lookup if the capture never recorded it.
   */
  providerSnapshotId?: string | null;
  state?: string;
  imageName?: string;
  errorReason?: string | null;
  cpu?: number;
  mem?: number;
  disk?: number;
  size?: number | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

/** Create an image-derived snapshot. */
export interface CreateImageSnapshotInput {
  name: string;
  image: string;
  entrypoint?: string[];
  regionId?: string;
}

export interface ScrubResult {
  /** Credential files targeted for removal. */
  removedFiles: string[];
  /** Env var names removed from the sandbox environment. */
  removedEnvVars: string[];
}

/**
 * The concrete paths and env-var names a pre-snapshot scrub removes, computed by
 * the caller and passed to a provider's scrub capability. Keeping the "what is a
 * secret" knowledge out of core lets `@amika/sandbox` stay a generic provider
 * mechanics layer: it removes exactly the paths it is handed, per its own
 * mechanism, and never decides which files/env vars are Amika secrets.
 */
export interface ScrubTargets {
  /** Home-dir paths to remove as the sandbox user (credential files/dirs). */
  files: string[];
  /** System paths to remove with sudo (the managed env files). */
  sudoFiles: string[];
  /**
   * Root-owned baseline files restored immediately before capture. These are
   * declared by the provisioning layer; core only performs the mechanics.
   *
   * Required rather than optional, and passed as `[]` when a producer genuinely
   * restores nothing: `/etc/environment` is restored here instead of being
   * deleted via {@link sudoFiles}, so a producer that omitted this field would
   * capture that file intact, with its injected secrets, and no verification
   * would fire because the path was never in the removal set.
   */
  sudoFileRestores: Array<{ sourcePath: string; destinationPath: string }>;
  /** Env var names that were removed — for the returned disclosure only. */
  envVarNames: string[];
  /**
   * Workspace root under which tokenized git remotes are sanitized: every
   * `.git/config` beneath it has `https://x-access-token:<token>@` stripped
   * back to plain `https://`, verified fail-closed. Declarative — where repos
   * live is Amika layout knowledge, so the caller passes the root rather than
   * core hardcoding it. Omit to skip the git-remote pass.
   */
  gitTokenWorkspaceRoot?: string;
}

/**
 * Outcome of capturing a snapshot from a running sandbox.
 *
 * `providerSnapshotId` is the provider's own bootable handle for the new
 * snapshot, or `null` when the provider boots snapshots by their org-scoped
 * name (Daytona). Freestyle returns the opaque id from `vm.snapshot`, which the
 * caller persists so a sandbox can later be created from it (`vms.create`).
 */
export interface CapturedSnapshot {
  providerSnapshotId: string | null;
}

export interface ScrubPreview {
  /** Credential files that currently exist and would be removed. */
  files: string[];
  /** Files that would be reset to a retained clean baseline. */
  restoredFiles: string[];
  /** Env var names that would be removed (names only, never values). */
  envVars: string[];
}

/**
 * Thrown when one or more scrubbed paths are still present after the scrub.
 * Carries the leftover paths so the caller can surface them to the user (the
 * most common cause is an active agent process recreating its config dir
 * between rm and verification).
 */
export class ScrubVerificationError extends Error {
  public readonly leftover: string[];
  constructor(leftover: string[]) {
    super(
      `Scrub verification failed; paths still present after scrub: [${leftover.join(", ")}]`,
    );
    this.name = "ScrubVerificationError";
    this.leftover = leftover;
  }
}

/**
 * A declared baseline restore failed or did not verify. Distinct from
 * {@link ScrubVerificationError}: that one means a path that should be gone is
 * still there. This one means a file that should be present and identical to
 * its source could not be restored safely.
 */
export class ScrubRestoreError extends Error {
  public readonly sourcePath: string;
  public readonly destinationPath: string;
  constructor(sourcePath: string, destinationPath: string, detail?: string) {
    super(
      `Scrub restore failed; ${destinationPath} could not be restored from ${sourcePath}${detail ? `: ${detail}` : ""}`,
    );
    this.name = "ScrubRestoreError";
    this.sourcePath = sourcePath;
    this.destinationPath = destinationPath;
  }
}

/**
 * Snapshot management for providers that support it. `getSnapshot` returns
 * `null` for a missing snapshot (rather than throwing) so consumers don't
 * couple to provider-specific not-found errors; real failures still throw.
 * `deleteSnapshot` is idempotent (a missing snapshot is a no-op).
 * `createImageSnapshot` returns `null` when the snapshot already exists.
 */
export interface SnapshotCapability {
  createImageSnapshot(
    input: CreateImageSnapshotInput,
  ): Promise<ProviderSnapshot | null>;
  getSnapshot(name: string): Promise<ProviderSnapshot | null>;
  /**
   * Like `getSnapshot`, but tolerates a snapshot that is still registering: a
   * freshly captured sandbox snapshot can be absent from a bare by-name lookup
   * while already present in the provider's listing. Use this when "does any
   * snapshot still occupy this name?" must account for in-flight captures
   * (name-reuse checks, reconciling stranded rows). Returns `null` when
   * genuinely absent.
   */
  findSnapshot(name: string): Promise<ProviderSnapshot | null>;
  /**
   * `providerSnapshotId` on `deleteSnapshot`/`waitForSnapshotActive` is the
   * provider's bootable handle when the caller already holds it (a freshly
   * captured {@link Snapshot} carries one). Id-only providers (Vercel) use it
   * directly instead of resolving the name through the injected
   * {@link SnapshotIdResolver} — which cannot know about a capture the caller
   * hasn't persisted yet. Name-native providers (Daytona, Freestyle) ignore it.
   */
  deleteSnapshot(
    name: string,
    providerSnapshotId?: string | null,
  ): Promise<void>;
  waitForSnapshotActive(
    name: string,
    providerSnapshotId?: string | null,
  ): Promise<ProviderSnapshot>;
  /**
   * Capture a snapshot of the sandbox as it stands — the one raw capture
   * primitive; scrubbing is layered above in core. All capture
   * mechanics stay inside: Daytona picks cold-VM vs container capture and
   * quiesces/restarts dind; Vercel calls `sandbox.snapshot()`; Freestyle
   * snapshots the running VM.
   *
   * `keepSourceRunning: false` declares the caller's INTENT to delete the
   * source afterwards — deletion is not guaranteed (activation can time out,
   * deletion can fail, and the caller then retains and releases the
   * source), so the flag only relaxes keep-alive where a retained source
   * stays recoverable. Daytona's cold-VM branch skips the power-restart (a
   * stopped VM is user-restartable), but its container branch keeps the
   * unconditional dind restore-in-finally — a retained source must never come
   * back with Docker quiesced. `true` is the non-destructive full-capture
   * mode, gated by `capabilities.fullSnapshotCapture`.
   */
  capture(
    providerSandboxId: string,
    snapshotName: string,
    opts: { keepSourceRunning: boolean },
  ): Promise<CapturedSnapshot>;
  /**
   * Remove secrets the PROVIDER itself injected into the sandbox, ahead of a
   * capture. Vercel removes its resume-context file (which carries the source
   * OpenCode password); Daytona and Freestyle are no-ops. Amika-injected
   * secrets are not this method's concern — those are scrubbed above by the
   * core-synthesized `scrubAndCreate`.
   */
  removeInjectedSecrets(providerSandboxId: string): Promise<void>;
  /** Whether the sandbox was created with secrets kept out of container env. */
  isEnvScrubbable(providerSandboxId: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Docker registry capability
// ---------------------------------------------------------------------------

/** Provider-agnostic docker registry metadata. */
export interface ProviderDockerRegistry {
  id: string;
  name: string;
  url: string;
  username: string;
  project?: string;
  registryType: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDockerRegistryInput {
  name: string;
  url: string;
  username: string;
  password: string;
  project?: string;
}

/** Docker registry management for providers that support it. */
export interface DockerRegistryCapability {
  createRegistry(
    input: CreateDockerRegistryInput,
  ): Promise<ProviderDockerRegistry>;
  listRegistries(): Promise<ProviderDockerRegistry[]>;
  getRegistry(registryId: string): Promise<ProviderDockerRegistry>;
  deleteRegistry(registryId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * What a provider can do beyond the always-present create/delete. Consumers
 * check these before invoking a gated operation, surfacing a clean
 * "unsupported for this provider" message instead of hitting
 * {@link SandboxProviderUnsupportedError}.
 */
export interface SandboxProviderCapabilities {
  /** Full provisioning lifecycle: initialize, start, stop, rerun-lifecycle. */
  lifecycle: boolean;
  /** Mint/revoke short-lived SSH access. */
  ssh: boolean;
  /** Expose sandbox services through provider-managed routes. */
  services: boolean;
  /** Run one-shot commands inside the sandbox. */
  exec: boolean;
  /** Enumerate account-wide sandboxes with sizing (spend metering). */
  listSandboxes: boolean;
  /** Stream a long-running command's output (e.g. for SSE). */
  streaming: boolean;
  /** Snapshot management (`provider.snapshots` is non-null iff true). */
  snapshots: boolean;
  /**
   * Whether the provider supports the non-destructive "full" capture mode
   * (snapshot the sandbox as-is, secrets included, source kept running). A
   * provider can support `snapshots` yet offer only the destructive
   * scrub-and-delete path — e.g. Vercel, whose per-sandbox retention would evict
   * a kept-alive full capture — so this is a separate flag. Always false when
   * `snapshots` is false; the create-snapshot API rejects `mode: "full"` for
   * providers where this is false.
   */
  fullSnapshotCapture: boolean;
  /**
   * Whether the destructive scrub-and-capture path (`sandbox.snapshots
   * .scrubAndCreate`) is available. The scrub is synthesized in core and runs
   * its removal/verification commands through the exec primitive, so this is
   * true iff the provider declares BOTH `snapshots` and `exec` — a provider
   * can support snapshots without exec and then offers only the raw captures.
   */
  scrubCapture: boolean;
  /** Docker registry management (`provider.docker` non-null iff true). */
  dockerRegistries: boolean;
  /**
   * Whether starting the sandbox can skip re-running the start script (the
   * start-phase lifecycle step). Only providers that honor
   * {@link RerunLifecycleInput.skipStartScript} set this true; the UI hides the
   * "start without start script" option otherwise so it can't be a silent no-op.
   */
  skipStartScript: boolean;
  /**
   * Whether the provider's bootable snapshot handle is an opaque id
   * (`sc-…`/`snap_…`) distinct from the org-scoped snapshot *name* — the
   * consumer-side mirror of {@link ProviderSnapshot.providerSnapshotId} /
   * {@link SnapshotIdResolver}. When true (Freestyle, Vercel), the snapshot
   * column stores an id the consumer must reverse-look-up to a display name and
   * cannot verify by name through a control-plane listing. When false (Daytona),
   * snapshots are addressed by their name directly. Lets consumers gate the
   * id-resolution/display path on a fact instead of the provider name.
   */
  snapshotIdsAreOpaque: boolean;
  /**
   * Whether the provider honors a time-based auto-delete interval. Daytona
   * deletes idle sandboxes on the interval; Freestyle and Vercel back
   * persistent VMs that suspend/resume instead of being deleted, so an
   * auto-delete request is rejected at create rather than silently ignored.
   */
  supportsAutoDelete: boolean;
}

// ---------------------------------------------------------------------------
// Capability namespaces
// ---------------------------------------------------------------------------
//
// The shape a provider author writes via `defineProvider`: cohesive capability
// namespaces, omitted (null) when the provider does not back them. These are
// provider-side only — `buildProvider` synthesizes the public resource objects
// over them; consumers gate on the `capabilities` descriptor or a nullable
// object namespace's presence.

/**
 * Manage a sandbox's existence and run state. create/delete is the one
 * always-present capability — a provider that can't create and delete a sandbox
 * isn't a sandbox provider. The run-state ops (start/stop/getState/mapState)
 * are optional and present as a unit: a minimal provider can create and delete
 * without being able to power-cycle.
 *
 * Run state (on/off/resumed) is distinct from the *lifecycle scripts*
 * (`setup.sh`/`start.sh`) run via provisioning's `initialize`/`rerun` — those
 * operate inside an already-running sandbox.
 */
export interface SandboxCapability {
  create(
    ctx: SandboxCtx,
    input: CreateSandboxProviderInput,
  ): Promise<CreatedProviderSandbox>;
  delete(providerSandboxId: string): Promise<void>;

  // Run-state control: start (power on / resume), stop (suspend), read the raw
  // run state, and map it to the canonical status vocabulary. Present as a unit
  // on a lifecycle provider; all absent on a create/delete-only one.
  start?(
    providerSandboxId: string,
    autoStopInterval?: number | null,
  ): Promise<void>;
  stop?(providerSandboxId: string): Promise<void>;
  getState?(providerSandboxId: string): Promise<string>;
  mapState?(rawState: string): SandboxStatus;
}

/** Run one-shot commands inside the sandbox. `stream` is present iff `streaming`. */
export interface ExecCapability {
  run(
    providerSandboxId: string,
    command: string,
    opts?: ExecCommandOptions,
  ): Promise<SandboxExecResult>;
  readonly streaming: boolean;
  /** Whether `run(..., { input })` is supported without an argv/env fallback. */
  readonly stdin?: boolean;
  stream?(
    providerSandboxId: string,
    command: string,
    handlers: StreamCommandHandlers,
  ): Promise<void>;
}

/** Read/write files inside the sandbox. */
export interface FileCapability {
  read(providerSandboxId: string, filePath: string): Promise<string | null>;
  write(
    providerSandboxId: string,
    filePath: string,
    content: Buffer | string,
  ): Promise<void>;
}

/** Mint/revoke short-lived SSH access. */
export interface SshCapability {
  mint(
    providerSandboxId: string,
    expiresInMinutes: number,
    services?: SandboxService[],
  ): Promise<MintedSshAccess>;
  revoke(providerSandboxId: string, token: string): Promise<void>;
}

/**
 * (Re)generate service preview URLs and reconcile service routes.
 *
 * `syncRoutes` is declarative: reconcile the provider's
 * routes to exactly the `desired` service set — expose what is missing, tear
 * down what no longer appears — rather than imperatively revoking one route
 * with the surviving set threaded alongside. Revoking a service is
 * `syncRoutes(remaining)`. Reconciliation must only ever touch state the
 * provider (or Amika's deterministic naming) owns; a route a user mapped to
 * the same sandbox out-of-band is never reconcilable state.
 */
export interface ServiceCapability {
  refreshUrls(
    providerSandboxId: string,
    services: SandboxService[],
  ): Promise<RefreshUrlsResult>;
  syncRoutes(
    providerSandboxId: string,
    desired: SandboxService[],
  ): Promise<void>;
}

/** Enumerate account-wide sandboxes with sizing. */
export interface ListingCapability {
  list(): Promise<ProviderSandboxListing[]>;
}

// ---------------------------------------------------------------------------
// Resource-object surface
// ---------------------------------------------------------------------------
//
// The consumer-facing API. Instead of calling a flat
// `provider.<capability>.<verb>(providerSandboxId, …)`, a consumer resolves a
// resource object — a {@link Sandbox}, {@link Snapshot}, or {@link
// DockerRegistry} — and calls methods on it. The object encapsulates the provider
// handle (so the id isn't re-threaded through every call) and any hidden state.
//
// These objects are synthesized in core (`./shared/resources`) over the
// capability namespaces above; providers author only the low-level primitives
// and {@link defineProvider} attaches the resource namespaces. Presence gating
// is unchanged: a
// method whose backing capability is absent throws {@link
// SandboxProviderUnsupportedError}, and richer sub-namespaces are `null` when
// unsupported — callers presence-check `sandbox.ssh` / `sandbox.services` /
// `sandbox.snapshots` exactly as they gate on `provider.<capability>` today.

/**
 * SSH access minted for a sandbox, with a `revoke()` bound to it. Extends the
 * {@link MintedSshAccess} data the provider returns with the method to tear it
 * back down, so a caller holding the handle need not re-supply the token.
 */
export interface MintedSshHandle extends MintedSshAccess {
  /** Revoke this access (idempotent per the provider). */
  revoke(): Promise<void>;
}

/** A sandbox's SSH sub-namespace. `null` on providers without SSH. */
export interface SandboxSshNamespace {
  /** Mint short-lived SSH access to this sandbox. */
  mint(
    expiresInMinutes: number,
    services?: SandboxService[],
  ): Promise<MintedSshHandle>;
  /**
   * Revoke previously-minted access by its token. `MintedSshHandle.revoke()`
   * is the same operation bound to a freshly minted handle; this form serves
   * callers that revoke a token they persisted rather than a live handle.
   */
  revoke(token: string): Promise<void>;
}

/**
 * A service of a loaded set: its authored/live fields plus
 * the mutations that need the surrounding set to reconcile. The methods
 * derive `desired` from the {@link LoadedServices} snapshot this object came
 * from — the caller never hand-computes a removed/remaining split.
 */
export interface Service extends SandboxService {
  /**
   * Tear down this service's route: reconcile the provider's routes to the
   * loaded set minus this service (idempotent; a shared port survives while
   * any other loaded service uses it).
   */
  revoke(): Promise<void>;
  /**
   * Reconcile + re-mint with `next` in this service's place: routes sync to
   * the set with the replacement, then URLs refresh over that set. The
   * loaded snapshot itself is NOT updated — `load()` is point-in-time, so
   * re-load after a mutation before chaining further calls.
   */
  update(next: SandboxService): Promise<RefreshUrlsResult>;
}

/**
 * A point-in-time snapshot of a sandbox's service set, object-ified. The
 * authoritative set lives in the control plane — providers keep
 * no listable per-sandbox route state (Daytona has none at all) — so the
 * caller loads the set it already holds and the objects derive everything
 * else. Lookup keys on the CONTAINER PORT: a service name may repeat across
 * ports, while a given port hosts exactly one service (the uniqueness key)
 * and the port is what the provider route layer addresses.
 */
export interface LoadedServices {
  list(): Service[];
  /** The service on `containerPort`, or null. First match on a legacy set
   * that carries duplicates (load order decides). */
  get(containerPort: number): Service | null;
  /**
   * Reconcile routes to the loaded set (exposing late-added ports, tearing
   * down stale ones), then (re)mint the set's preview URLs.
   */
  refresh(): Promise<RefreshUrlsResult>;
}

/** A sandbox's service sub-namespace. `null` on providers without services. */
export interface SandboxServiceNamespace {
  /**
   * (Re)generate signed preview URLs for all of the sandbox's services — the
   * no-object fast path for read/re-mint flows that must not touch routes.
   */
  refreshAll(services: SandboxService[]): Promise<RefreshUrlsResult>;
  /** Load a point-in-time service set and get {@link Service} objects over it. */
  load(services: SandboxService[]): LoadedServices;
}

/** A captured snapshot paired with what the pre-capture scrub removed. */
export interface ScrubbedSnapshot extends ScrubResult {
  snapshot: Snapshot;
}

/**
 * A sandbox's snapshot sub-namespace: capture a snapshot *from this sandbox*.
 * (Account-level snapshot lookup/management lives on the top-level
 * {@link SandboxProvider} snapshot namespace.) `null` on providers without
 * snapshots.
 */
export interface SandboxSnapshotNamespace {
  /** Capture a snapshot of the running sandbox as-is (secrets included). */
  create(snapshotName: string): Promise<Snapshot>;
  /** Remove the given targets, then capture a clean snapshot. */
  scrubAndCreate(
    snapshotName: string,
    targets: ScrubTargets,
  ): Promise<ScrubbedSnapshot>;
  /** Whether the sandbox was created with secrets kept out of container env. */
  isEnvScrubbable(): Promise<boolean>;
}

/**
 * A sandbox's git sub-namespace: an OPTIONAL provider override for how repos
 * are cloned. Present (non-null) only when a provider's SDK has a first-class
 * clone primitive worth using over shell `git` — Daytona exposes it via the
 * SDK's native `git.clone`. It is `null` on providers with no native primitive
 * (Freestyle, Vercel); the provisioning layer clones those by running `git`
 * over the {@link SandboxAdapter} exec port instead. Cloning is Amika
 * provisioning orchestration, not a core sandbox capability, so there is no
 * always-present clone method on {@link Sandbox} — callers presence-check
 * `sandbox.git` and fall back to their own exec-based clone.
 */
export interface SandboxGitNamespace {
  /** Clone one git repo into the sandbox via the provider's native primitive. */
  clone(input: CloneRepoInput): Promise<void>;
}

/**
 * The inputs a provider persists so it can relaunch a sandbox's services after a
 * resume — see {@link Sandbox.persistServiceRestartContext}. The relaunch re-runs
 * the start-phase lifecycle hooks, which need the OpenCode server password and
 * the agent working directory they run in.
 */
export interface ServiceRestartContext {
  openCodePassword: string;
  amikaOpenCodeWeb?: string | null;
  /** The agent working directory (`AMIKA_AGENT_CWD`) the relaunch hooks run in. */
  repoDir: string;
}

/**
 * A provisioned sandbox. Methods that map to a nullable capability
 * (start/stop/state → the sandbox run-state ops, exec/streamExec → exec, readFile/writeFile → files)
 * throw {@link SandboxProviderUnsupportedError} when the provider doesn't back
 * them; the sub-namespaces (`git`, `ssh`, `services`, `snapshots`) are `null`
 * in that case so callers can presence-check instead.
 */
export interface Sandbox {
  /** The provider's handle for this sandbox (`providerSandboxId`). */
  readonly id: string;
  readonly provider: SandboxProviderName;
  /** The creation result, present only on a `Sandbox` returned from `create`. */
  readonly created?: CreatedProviderSandbox;
  start(autoStopInterval?: number | null): Promise<void>;
  stop(): Promise<void>;
  delete(): Promise<void>;
  /** The raw provider run-state string. */
  getState(): Promise<string>;
  /** Map a raw provider state to the canonical vocabulary. */
  mapState(rawState: string): SandboxStatus;
  /** The raw state mapped to the canonical vocabulary (getState + mapState). */
  getRuntimeState(): Promise<SandboxStatus>;
  exec(command: string, opts?: ExecCommandOptions): Promise<SandboxExecResult>;
  streamExec(command: string, handlers: StreamCommandHandlers): Promise<void>;
  readFile(filePath: string): Promise<string | null>;
  writeFile(filePath: string, content: Buffer | string): Promise<void>;
  /** Optional provider-native clone override; `null` → clone via adapter exec. */
  readonly git: SandboxGitNamespace | null;
  /**
   * Persist the context needed to relaunch this sandbox's services after a
   * resume — or `null` when the provider doesn't need it.
   *
   * Present (non-null) ONLY on providers whose suspended sandboxes come back
   * with their running processes gone: Vercel's microVMs restore the filesystem
   * but not the processes the lifecycle hooks started, so on the next exec Vercel
   * re-runs the start hooks and reads this persisted context for the inputs. On
   * providers whose processes survive a stop/restart (Daytona, Freestyle) there
   * is nothing to relaunch, so this is `null` and the provisioning flow skips it.
   * The flow calls it on create and restart, when the inputs are known — a
   * provider that never resets services on resume simply omits it, so this stays
   * out of the shared capability descriptor every provider fills.
   */
  readonly persistServiceRestartContext:
    | ((context: ServiceRestartContext) => Promise<void>)
    | null;
  readonly ssh: SandboxSshNamespace | null;
  readonly services: SandboxServiceNamespace | null;
  readonly snapshots: SandboxSnapshotNamespace | null;
}

/** Top-level namespace for resolving and creating {@link Sandbox} objects. */
export interface SandboxNamespace {
  /** Provision a new sandbox; the returned `Sandbox` carries the create result. */
  create(ctx: SandboxCtx, input: CreateSandboxProviderInput): Promise<Sandbox>;
  /** A lightweight reference to an existing sandbox by handle — no I/O. */
  get(providerSandboxId: string): Sandbox;
  /** Enumerate account-wide sandboxes with sizing (spend metering). */
  list(): Promise<ProviderSandboxListing[]>;
}

/**
 * An account-level snapshot, with its metadata (from {@link ProviderSnapshot})
 * plus the methods to wait on and delete it.
 *
 * The bound methods pass the snapshot's `providerSnapshotId` (when present)
 * through to the capability, so a freshly captured snapshot on an id-only
 * provider (Vercel) is operable before the name↔id mapping the
 * {@link SnapshotIdResolver} reads has been persisted.
 */
export interface Snapshot extends ProviderSnapshot {
  /** Resolve once the snapshot reaches the active state. */
  waitForActive(): Promise<Snapshot>;
  /** Delete the snapshot (idempotent — a missing snapshot is a no-op). */
  delete(): Promise<void>;
}

/**
 * Account-level snapshot lookup/management — the shape of
 * `provider.snapshots`. `get`/`find`/`createImage` are nullable: a missing or
 * still-registering snapshot (or a `createImage` that hit an existing name)
 * resolves to `null`, preserving the `getSnapshot`/`findSnapshot`/
 * `createImageSnapshot` contract consumers fall back on. Deleting or waiting
 * goes through the returned {@link Snapshot}'s bound methods.
 *
 * Snapshots are addressed by their org-scoped *name*, which the caller builds
 * via its own naming helpers — naming is Amika policy, not part of the provider
 * surface.
 */
export interface SnapshotNamespace {
  /** Look up a snapshot by org-scoped name; `null` when missing. */
  get(name: string): Promise<Snapshot | null>;
  /**
   * Like `get`, but tolerates a snapshot that is still registering (list-scan
   * fallback). Use when "does any snapshot still occupy this name?" must
   * account for in-flight captures. `null` when genuinely absent.
   */
  find(name: string): Promise<Snapshot | null>;
  /** Create an image-derived snapshot; `null` when the name already exists. */
  createImage(input: CreateImageSnapshotInput): Promise<Snapshot | null>;
}

/** A docker registry, with its metadata plus the method to delete it. */
export interface DockerRegistry extends ProviderDockerRegistry {
  delete(): Promise<void>;
}

/** Namespace for creating/listing/resolving {@link DockerRegistry} objects. */
export interface DockerRegistryNamespace {
  create(input: CreateDockerRegistryInput): Promise<DockerRegistry>;
  list(): Promise<DockerRegistry[]>;
  get(registryId: string): Promise<DockerRegistry>;
}

/** Top-level docker namespace (`provider.docker.registries.*`). */
export interface DockerNamespace {
  readonly registries: DockerRegistryNamespace;
}

/**
 * The sandbox-provisioner contract every consumer codes against. Provider-
 * agnostic and free of control-plane concerns. Resolve one through the registry
 * (`./registry`); the only place a concrete provider is named is there.
 *
 * The consumer surface is the resource-object API: resolve a
 * {@link Sandbox} via `sandboxes.get(id)`/`create(...)` and call methods on it;
 * account-level snapshots and docker registries hang off `snapshots` and
 * `docker.registries`. Provider *authoring* is capability-namespace-based — a
 * provider declares its low-level primitives via `defineProvider`'s
 * {@link ProviderDefinition} — but those namespaces are not exposed here;
 * `buildProvider` synthesizes the objects over them. Gating: consumers check
 * the SDK-free `capabilities` descriptor (or a nullable namespace's presence);
 * an unsupported op throws {@link SandboxProviderUnsupportedError}.
 *
 * The Amika-specific provisioning flows live in `@amika/sandbox-provisioning`;
 * they drive the sandbox through these objects (`sandbox.git?.clone`,
 * `sandbox.services.refreshAll`) plus the per-provider adapter opened via
 * `getSandboxAdapter`.
 */
export interface SandboxProvider {
  readonly name: SandboxProviderName;
  readonly capabilities: SandboxProviderCapabilities;
  /** TTL of signed preview URLs this provider mints, in seconds. */
  readonly signedUrlTtlSeconds: number;
  /**
   * The user's home directory inside every sandbox this provider boots (e.g.
   * `/home/amika`, `/vercel/sandbox`) — a per-provider constant, so callers
   * read it here instead of querying a running sandbox.
   */
  readonly userHomeDir: string;

  /** Resolve/create {@link Sandbox} objects. Always present. */
  readonly sandboxes: SandboxNamespace;
  /** Account-level snapshot lookup/mgmt, or null when unsupported (`capabilities.snapshots`). */
  readonly snapshots: SnapshotNamespace | null;
  /** Docker registry objects, or null when unsupported. */
  readonly docker: DockerNamespace | null;
}
