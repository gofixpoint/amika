// CamelCase TS mirrors of the Go SDK types in go/internal/apiclient/client.go.
// Each request/response has explicit toWire/fromWire mappers to translate
// between the SDK's camelCase developer surface and the snake_case JSON wire
// format the server expects. (A few nested objects are camelCase on the wire
// too; those mappers say so.)
//
// Nullability follows the Go struct tags, which in turn follow the OpenAPI
// document served at /api/openapi.json:
//
//   - `string`             (required, not nullable) -> `x: string`
//   - `*string`            (required, nullable)     -> `x: string | null`
//   - `*string,omitempty`  (optional, nullable)     -> `x?: string`
//
// The last case collapses null and absent into `undefined`: Go's `omitempty`
// on a pointer encodes nil as an omitted key, so the server never distinguishes
// the two either.

import { AmikaError } from "@/errors";

// ---------- Rigs ----------
//
// `rig` is the canonical product term for what the API still calls a sandbox.
// Every rig-named type below is the canonical spelling; the sandbox-named one
// beside it is a type alias kept so existing code keeps compiling. Wire keys
// are untouched: the server's schema is still snake_case `sandbox_*`.
//
// Response types gained rig-spelled mirrors of their sandbox-spelled fields.
// The decoders always populate both, so the mirror is required on the rig-named
// type and a returned value satisfies it. The sandbox-named alias relaxes those
// same fields to optional via {@link LegacyShape}, so an object literal written
// against an earlier release still type-checks. Three types keep their own
// names (`Session` and the agent-session responses) and so have no alias to
// relax; their mirrors are declared optional for the same reason.

/**
 * `T` with the keys in `K` made optional. Gives a legacy sandbox-named alias a
 * shape that accepts a literal predating the rig fields, while still admitting
 * every value the SDK decodes (which carries both spellings).
 */
type LegacyShape<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

/**
 * Selects which stored credential of a given `kind` the server injects
 * into a rig (e.g. a Claude credential surfaces as `ANTHROPIC_API_KEY`
 * or an on-disk OAuth token).
 *
 * One entry engages exactly one kind; at most one entry per kind is
 * allowed. Within an entry the fields resolve by precedence (first match
 * wins):
 *
 *   1. `none: true` -> inject nothing for this kind (explicit opt-out;
 *      cannot be combined with `name` or `type`).
 *
 *        { kind: "claude", none: true }
 *
 *   2. `name` (+ optional `type`) -> use the credential with that name;
 *      if `type` is also given it must match the stored type.
 *
 *        { kind: "claude", name: "personal-oauth" }
 *        { kind: "claude", name: "work-key", type: "api_key" }
 *
 *   3. `type` only -> use the caller's single credential of that type
 *      for this kind (errors if they have zero or more than one).
 *
 *        { kind: "claude", type: "api_key" }
 *
 *   4. `{ kind }` alone -> let the server pick: repo default from
 *      `.amika/config.toml`, else auto-default (OAuth first, then API
 *      key, considering org-scoped credentials as a fallback).
 *
 *        { kind: "claude" }
 *
 * IMPORTANT: This is per-entry only. A kind with no entry in the
 * request's `agentCredentials` array gets NO credential injected, and
 * auto-default does not run for it. Omitting the array entirely means
 * the rig boots unauthenticated against every agent, regardless of
 * any configured user or org credential.
 *
 *   // Unauthenticated: the agent has no credential to use.
 *   await client.createRig({ repoUrl });
 *
 *   // Authenticated: server picks the default Claude credential.
 *   await client.createRig({
 *     repoUrl,
 *     agentCredentials: [{ kind: "claude" }],
 *   });
 *
 * The create-rig response echoes the outcome per engaged kind in
 * `resolvedAgentCredentials`, e.g.
 * `{ kind: "claude", outcome: "resolved", type: "oauth", source: "default:oauth" }`
 * or `{ kind: "claude", outcome: "skipped", reason: "no_user_credential" }`.
 */
export interface AgentCredentialRef {
  /** Agent this entry configures, e.g. "claude" or "codex". */
  kind: string;
  /** Select a specific stored credential by its name. */
  name?: string;
  /** Select by credential type; disambiguates when a name is not given. */
  type?: "oauth" | "api_key";
  /** Inject nothing for this kind. Cannot be combined with name/type. */
  none?: boolean;
}

/** Request body for POST /api/v0beta1/rigs. */
export interface CreateRigRequest {
  name?: string;
  provider?: string;
  repoUrl?: string;
  autoStopInterval?: number;
  autoDeleteInterval?: number;
  envVars?: Record<string, string>;
  secretEnvVars?: Record<string, string>;
  preset?: string;
  size?: string;
  /**
   * Snapshot to fork the new rig from, given as its org-stripped slug
   * (e.g. `amika-mono-base`). Capture one with {@link AmikaClient.createRigSnapshot}.
   *
   * Tri-state, matching the server's `snapshot` param:
   *   - a slug  -> boot from that snapshot
   *   - `null`  -> explicitly opt out of the repo-level default snapshot
   *   - omitted -> keep the full default chain (repo default, else preset/size)
   */
  snapshot?: string | null;
  setupScriptText?: string;
  agentCredentials?: AgentCredentialRef[];
  branch?: string;
  newBranchName?: string;
  /** How the rig authenticates to GitHub, e.g. "app" or "none". */
  githubAuthMode?: string;
}

/** Legacy spelling of {@link CreateRigRequest}. */
export type CreateSandboxRequest = CreateRigRequest;

export function createRigRequestToWire(
  r: CreateRigRequest,
): Record<string, unknown> {
  return omitUndefined({
    name: r.name,
    provider: r.provider,
    repo_url: r.repoUrl,
    auto_stop_interval: r.autoStopInterval,
    auto_delete_interval: r.autoDeleteInterval,
    env_vars: r.envVars,
    secret_env_vars: r.secretEnvVars,
    preset: r.preset,
    size: r.size,
    // omitUndefined keeps an explicit `null` (opt out of the default snapshot)
    // and drops `undefined` (keep the default chain).
    snapshot: r.snapshot,
    setup_script_text: r.setupScriptText,
    agent_credentials: r.agentCredentials,
    branch: r.branch,
    new_branch_name: r.newBranchName,
    github_auth_mode: r.githubAuthMode,
  });
}

/** Legacy spelling of {@link createRigRequestToWire}. */
export const createSandboxRequestToWire = createRigRequestToWire;

export interface ResolvedAgentCredential {
  kind: string;
  outcome: "resolved" | "skipped" | string;
  name?: string;
  type?: string;
  source?: string;
  reason?: string;
}

/**
 * One named service exposed by a rig: a published port with an optional
 * generated URL. Wire keys are camelCase here, unlike the rest of the API.
 */
export interface RemoteRigService {
  name: string;
  url: string;
  hostPort: number;
  containerPort: number;
  protocol: string;
}

/** Legacy spelling of {@link RemoteRigService}. */
export type RemoteSandboxService = RemoteRigService;

function remoteRigServiceFromWire(
  w: Record<string, unknown>,
): RemoteRigService {
  return {
    name: str(w["name"]),
    url: str(w["url"]),
    hostPort: num(w["hostPort"]),
    containerPort: num(w["containerPort"]),
    protocol: str(w["protocol"]),
  };
}

/**
 * One secret a rig carries, by name and scope. The API deliberately
 * returns no value and no vault handle. `managed` distinguishes a credential
 * Amika manages for a provider from a plain user-defined secret; it is the
 * discriminator rather than a null `credentialType`, which a managed entry is
 * allowed to have.
 */
export interface MountedSecret {
  name: string;
  scope: string;
  managed: boolean;
  credentialType: string | null;
  provider: string | null;
}

function mountedSecretFromWire(w: Record<string, unknown>): MountedSecret {
  return {
    name: str(w["name"]),
    scope: str(w["scope"]),
    managed: bool(w["managed"]),
    credentialType: nullableStr(w["credential_type"]),
    provider: nullableStr(w["provider"]),
  };
}

/**
 * Mirrors the API's Sandbox schema (the `Sandbox` component in
 * /api/openapi.json), the response of the /rigs endpoints.
 *
 * `providerRigId`, `rigPreset`, and `rigSize` are the canonical spellings of
 * the three fields the schema still names after sandboxes. Each is decoded
 * from the same wire key as its `sandbox*` twin and carries the same value, so
 * either name reads the field.
 *
 * `containerId` and `image` have no equivalent in the API schema — the CLI
 * populates them for local Docker rigs only, and the schema's
 * `additionalProperties` allows the extra keys.
 */
export interface RemoteRig {
  id: string;
  userId: string | null;
  orgId: string;
  name: string;
  provider: string | null;
  /** Canonical spelling; mirrors {@link RemoteRig.providerSandboxId}. */
  providerRigId: string | null;
  providerSandboxId: string | null;
  providerUrl: string | null;
  amikaOpencodeWeb: string | null;
  repoName: string | null;
  repoProvider: string | null;
  repoId: string | null;
  repoUrl: string | null;
  branch: string | null;
  commitHash: string | null;
  snapshot: string | null;
  currentSessionId: string | null;
  services: RemoteRigService[];
  createdAt: string;
  updatedAt: string;

  snapshotName?: string;
  /** Canonical spelling; mirrors {@link RemoteRig.sandboxPreset}. */
  rigPreset?: string;
  sandboxPreset?: string;
  /** Canonical spelling; mirrors {@link RemoteRig.sandboxSize}. */
  rigSize?: string;
  sandboxSize?: string;
  githubAuthMode?: string;
  githubCredentialProvisioned?: boolean;
  errorMessage?: string;
  state: string;
  status: string;
  setupStatus?: string;
  urlsExpireAt?: string;
  secretNames?: string[];
  mountedSecrets?: MountedSecret[];
  hasWorkflow: boolean;
  resolvedAgentCredentials?: ResolvedAgentCredential[];
  createdBy?: RemoteRigCreator;
  origin?: string;

  /**
   * Local Docker rigs only. Not an API schema field at all, so unlike
   * `state`/`status` (non-pointer Go strings that decode to "") it is typed
   * optional: an API-backed rig never carries one.
   */
  containerId?: string;
  /** Local Docker rigs only; see {@link RemoteRig.containerId}. */
  image?: string;
}

/** Legacy spelling of {@link RemoteRig}; see {@link LegacyShape}. */
export type RemoteSandbox = LegacyShape<RemoteRig, "providerRigId">;

/**
 * The human who created a remote rig. Either field may be null if the
 * server could not resolve the user (deleted account, API-key principal, or
 * noop auth mode).
 */
export interface RemoteRigCreator {
  name: string | null;
  email: string | null;
}

/** Legacy spelling of {@link RemoteRigCreator}. */
export type RemoteSandboxCreator = RemoteRigCreator;

export function remoteRigFromWire(w: Record<string, unknown>): RemoteRig {
  return {
    id: str(w["id"]),
    userId: nullableStr(w["user_id"]),
    orgId: str(w["org_id"]),
    name: str(w["name"]),
    provider: nullableStr(w["provider"]),
    providerRigId: nullableStr(w["provider_sandbox_id"]),
    providerSandboxId: nullableStr(w["provider_sandbox_id"]),
    providerUrl: nullableStr(w["provider_url"]),
    amikaOpencodeWeb: nullableStr(w["amika_opencode_web"]),
    repoName: nullableStr(w["repo_name"]),
    repoProvider: nullableStr(w["repo_provider"]),
    repoId: nullableStr(w["repo_id"]),
    repoUrl: nullableStr(w["repo_url"]),
    branch: nullableStr(w["branch"]),
    commitHash: nullableStr(w["commit_hash"]),
    snapshot: nullableStr(w["snapshot"]),
    currentSessionId: nullableStr(w["current_session_id"]),
    services: mapArray(w["services"], remoteRigServiceFromWire),
    createdAt: str(w["created_at"]),
    updatedAt: str(w["updated_at"]),

    snapshotName: optionalStr(w["snapshot_name"]),
    rigPreset: optionalStr(w["sandbox_preset"]),
    sandboxPreset: optionalStr(w["sandbox_preset"]),
    rigSize: optionalStr(w["sandbox_size"]),
    sandboxSize: optionalStr(w["sandbox_size"]),
    githubAuthMode: optionalStr(w["github_auth_mode"]),
    githubCredentialProvisioned: optionalBool(
      w["github_credential_provisioned"],
    ),
    errorMessage: optionalStr(w["error_message"]),
    state: str(w["state"]),
    status: str(w["status"]),
    setupStatus: optionalStr(w["setup_status"]),
    urlsExpireAt: optionalStr(w["urls_expire_at"]),
    secretNames: optionalStrArray(w["secret_names"]),
    mountedSecrets: optionalArray(w["mounted_secrets"], mountedSecretFromWire),
    hasWorkflow: bool(w["has_workflow"]),
    resolvedAgentCredentials: w["resolved_agent_credentials"] as
      | ResolvedAgentCredential[]
      | undefined,
    createdBy: optionalObject(w["created_by"], (c) => ({
      name: nullableStr(c["name"]),
      email: nullableStr(c["email"]),
    })),
    origin: optionalStr(w["origin"]),

    containerId: optionalStr(w["container_id"]),
    image: optionalStr(w["image"]),
  };
}

/** Legacy spelling of {@link remoteRigFromWire}. */
export const remoteSandboxFromWire = remoteRigFromWire;

// ---------- Repositories ----------

/** A repository known to the caller's org, from GET /api/v0beta1/repositories. */
export interface RemoteRepository {
  id: string;
  repoUrl: string;
}

export function remoteRepositoryFromWire(
  w: Record<string, unknown>,
): RemoteRepository {
  return {
    id: str(w["id"]),
    repoUrl: str(w["repo_url"]),
  };
}

// ---------- Secrets ----------

/**
 * Mirrors the API's SecretSummary schema, returned by the /secrets endpoints.
 * Never carries the secret's value.
 */
export interface Secret {
  id: string;
  orgId: string;
  userId: string;
  name: string;
  description: string | null;
  /** "user" or "org". */
  scope: string;
  createdAt: string;
  updatedAt: string;
}

export function secretFromWire(w: Record<string, unknown>): Secret {
  return {
    id: str(w["id"]),
    orgId: str(w["org_id"]),
    userId: str(w["user_id"]),
    name: str(w["name"]),
    description: nullableStr(w["description"]),
    scope: str(w["scope"]),
    createdAt: str(w["created_at"]),
    updatedAt: str(w["updated_at"]),
  };
}

export interface CreateSecretRequest {
  name: string;
  value: string;
  scope: string;
}

export interface UpdateSecretRequest {
  value: string;
}

// ---------- Provider secrets ----------

export interface CreateProviderSecretRequest {
  name: string;
  value: string;
  /** "oauth" or "api_key" — required by the server. */
  type: "oauth" | "api_key";
  /** "user" (default) or "org"; omit to take the server default. */
  scope?: "user" | "org";
}

export interface ProviderSecretSummary {
  id: string;
  name: string;
  scope: string;
}

export interface ProviderSecretListItem {
  id: string;
  name: string;
  type: string;
  /** "user" or "org". */
  scope: string;
}

// ---------- Agent send ----------

export interface AgentSendRequest {
  message: string;
  newSession?: boolean;
  sessionId?: string;
  agent?: string;
}

export function agentSendRequestToWire(
  r: AgentSendRequest,
): Record<string, unknown> {
  return omitUndefined({
    message: r.message,
    new_session: r.newSession,
    session_id: r.sessionId,
    agent: r.agent,
  });
}

export interface AgentSendResponse {
  /** The agent's textual response (`response` field on the wire). */
  result: string;
  sessionId: string;
  isError: boolean;
  isNewSession: boolean;
  agentSessionId?: string;
  costUsd?: number;
}

export function agentSendResponseFromWire(
  w: Record<string, unknown>,
): AgentSendResponse {
  return {
    result: str(w["response"]),
    sessionId: str(w["session_id"]),
    isError: bool(w["is_error"]),
    isNewSession: bool(w["is_new_session"]),
    agentSessionId: optionalStr(w["agent_session_id"]),
    costUsd: optionalNum(w["cost_usd"]),
  };
}

// ---------- Sessions ----------

export interface Session {
  id: string;
  /**
   * Canonical spelling; mirrors {@link Session.sandboxId}. Always set by the
   * decoder, and optional only so a literal predating it still type-checks.
   */
  rigId?: string;
  sandboxId: string;
  orgId: string;
  agentName: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  metadata: Record<string, unknown>;
  /** First user message, capped by the server. List responses only. */
  preview?: string;
  createdAt: string;
  updatedAt: string;
}

export function sessionFromWire(w: Record<string, unknown>): Session {
  return {
    id: str(w["id"]),
    rigId: str(w["sandbox_id"]),
    sandboxId: str(w["sandbox_id"]),
    orgId: str(w["org_id"]),
    agentName: str(w["agent_name"]),
    status: str(w["status"]),
    startedAt: str(w["started_at"]),
    endedAt: nullableStr(w["ended_at"]),
    metadata: (w["metadata"] ?? {}) as Record<string, unknown>,
    preview: optionalStr(w["preview"]),
    createdAt: str(w["created_at"]),
    updatedAt: str(w["updated_at"]),
  };
}

export interface CreateSessionRequest {
  agentName: string;
  metadata?: Record<string, unknown>;
}

export function createSessionRequestToWire(
  r: CreateSessionRequest,
): Record<string, unknown> {
  return omitUndefined({
    agent_name: r.agentName,
    metadata: r.metadata,
  });
}

export interface UpdateSessionRequest {
  status?: string;
  metadata?: Record<string, unknown>;
}

export function updateSessionRequestToWire(
  r: UpdateSessionRequest,
): Record<string, unknown> {
  return omitUndefined({
    status: r.status,
    metadata: r.metadata,
  });
}

// ---------- Rig services ----------

/**
 * One service on a rig, as returned by the /rig-services endpoints.
 * It unifies rows from the `sandbox_services` table with legacy jsonb entries:
 * `source` discriminates ("table" or "legacy") and `kind` is "system" or
 * "user". A legacy or not-yet-provisioned service has a null `url`/`urlScheme`.
 *
 * Distinct from {@link RemoteRigService}, the abbreviated form nested in a
 * rig resource.
 */
export interface RigServiceResource {
  id: string | null;
  /** Canonical spelling; mirrors {@link RigServiceResource.sandboxId}. */
  rigId: string;
  sandboxId: string;
  name: string;
  port: number;
  urlScheme: string | null;
  protocol: string;
  url: string | null;
  hostPort: number | null;
  source: string;
  kind: string;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Legacy spelling of {@link RigServiceResource}; see {@link LegacyShape}. */
export type SandboxServiceResource = LegacyShape<RigServiceResource, "rigId">;

export function rigServiceResourceFromWire(
  w: Record<string, unknown>,
): RigServiceResource {
  return {
    id: nullableStr(w["id"]),
    rigId: str(w["sandbox_id"]),
    sandboxId: str(w["sandbox_id"]),
    name: str(w["name"]),
    port: num(w["port"]),
    urlScheme: nullableStr(w["url_scheme"]),
    protocol: str(w["protocol"]),
    url: nullableStr(w["url"]),
    hostPort: nullableNum(w["host_port"]),
    source: str(w["source"]),
    kind: str(w["kind"]),
    createdAt: nullableStr(w["created_at"]),
    updatedAt: nullableStr(w["updated_at"]),
  };
}

/** Legacy spelling of {@link rigServiceResourceFromWire}. */
export const sandboxServiceResourceFromWire = rigServiceResourceFromWire;

/** Request body for creating (POST) or replacing (PUT) a rig service. */
export interface RigServiceRequest {
  name: string;
  /** A user-assignable container port. See {@link validateServicePort}. */
  port: number;
  urlScheme: "http" | "https";
}

/** Legacy spelling of {@link RigServiceRequest}. */
export type SandboxServiceRequest = RigServiceRequest;

/**
 * Inclusive lower bound of the container port range Amika reserves for its own
 * rig services.
 */
export const RESERVED_PORT_MIN = 60899;
/**
 * Inclusive upper bound of the reserved range (the OpenCode web UI runs on
 * 60998 and the amikad daemon on 60999). See `docs/sandbox-configuration.md`
 * for the full allocation table.
 */
export const RESERVED_PORT_MAX = 60999;

/**
 * Throw unless `port` is a legal, user-assignable container port: within
 * 1-65535 and outside the reserved Amika range. Mirrors Go's
 * `services.ValidatePort`, including its messages, so the same bad port fails
 * the same way whether it goes through the CLI or the SDK.
 *
 * The server enforces this too. Checking here turns a round trip into an
 * immediate error, which is the point of keeping the two in sync.
 */
export function validateServicePort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AmikaError(`invalid port ${port}: must be between 1 and 65535`);
  }
  if (port >= RESERVED_PORT_MIN && port <= RESERVED_PORT_MAX) {
    throw new AmikaError(
      `invalid port ${port}: ports ${RESERVED_PORT_MIN}-${RESERVED_PORT_MAX} are reserved for internal Amika services`,
    );
  }
}

/**
 * Validation lives here rather than in the two client methods so that every
 * path to the wire goes through it, including any future one.
 */
export function rigServiceRequestToWire(
  r: RigServiceRequest,
): Record<string, unknown> {
  validateServicePort(r.port);
  return { name: r.name, port: r.port, url_scheme: r.urlScheme };
}

/** Legacy spelling of {@link rigServiceRequestToWire}. */
export const sandboxServiceRequestToWire = rigServiceRequestToWire;

// ---------- Rig snapshots ----------

/**
 * Provider-specific Daytona detail nested under {@link RigSnapshot.daytona}.
 * Only `name` is required by the schema; wire keys are camelCase here.
 */
export interface ExperimentalDaytonaSnapshot {
  name: string;
  state?: string;
  imageName?: string;
  cpu?: number;
  memory?: number;
  disk?: number;
  createdAt?: string;
  updatedAt?: string;
}

function experimentalDaytonaSnapshotFromWire(
  w: Record<string, unknown>,
): ExperimentalDaytonaSnapshot {
  return {
    name: str(w["name"]),
    state: optionalStr(w["state"]),
    imageName: optionalStr(w["imageName"]),
    cpu: optionalNum(w["cpu"]),
    memory: optionalNum(w["memory"]),
    disk: optionalNum(w["disk"]),
    createdAt: optionalStr(w["createdAt"]),
    updatedAt: optionalStr(w["updatedAt"]),
  };
}

/**
 * A snapshot captured from a running rig, as returned by the
 * `/api/v0beta1/rig-snapshots` endpoints. `snapshot` is the slug used to
 * fork new rigs (pass it as {@link CreateRigRequest.snapshot}).
 *
 * The four `sourceRig*` / `rig*` fields are the canonical spellings of the
 * `sourceSandbox*` / `sandbox*` ones beside them, decoded from the same wire
 * keys.
 */
export interface RigSnapshot {
  id: string;
  snapshot: string;
  provider: string;
  description: string | null;
  /** Canonical spelling; mirrors {@link RigSnapshot.sourceSandboxId}. */
  sourceRigId: string | null;
  sourceSandboxId: string | null;
  /** Canonical spelling; mirrors {@link RigSnapshot.sourceSandboxName}. */
  sourceRigName: string | null;
  sourceSandboxName: string | null;
  repositoryId: string | null;
  repositoryUrl: string | null;
  baseSnapshot: string | null;
  /** Canonical spelling; mirrors {@link RigSnapshot.sandboxPreset}. */
  rigPreset: string | null;
  sandboxPreset: string | null;
  /** Canonical spelling; mirrors {@link RigSnapshot.sandboxSize}. */
  rigSize: string | null;
  sandboxSize: string | null;
  captureMode: string | null;
  state: string;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  daytona: ExperimentalDaytonaSnapshot | null;
}

/** Legacy spelling of {@link RigSnapshot}; see {@link LegacyShape}. */
export type SandboxSnapshot = LegacyShape<
  RigSnapshot,
  "sourceRigId" | "sourceRigName" | "rigPreset" | "rigSize"
>;

export function rigSnapshotFromWire(w: Record<string, unknown>): RigSnapshot {
  return {
    id: str(w["id"]),
    snapshot: str(w["snapshot"]),
    provider: str(w["provider"]),
    description: nullableStr(w["description"]),
    sourceRigId: nullableStr(w["source_sandbox_id"]),
    sourceSandboxId: nullableStr(w["source_sandbox_id"]),
    sourceRigName: nullableStr(w["source_sandbox_name"]),
    sourceSandboxName: nullableStr(w["source_sandbox_name"]),
    repositoryId: nullableStr(w["repository_id"]),
    repositoryUrl: nullableStr(w["repository_url"]),
    baseSnapshot: nullableStr(w["base_snapshot"]),
    rigPreset: nullableStr(w["sandbox_preset"]),
    sandboxPreset: nullableStr(w["sandbox_preset"]),
    rigSize: nullableStr(w["sandbox_size"]),
    sandboxSize: nullableStr(w["sandbox_size"]),
    captureMode: nullableStr(w["capture_mode"]),
    state: str(w["state"]),
    errorMessage: nullableStr(w["error_message"]),
    createdAt: str(w["created_at"]),
    updatedAt: str(w["updated_at"]),
    daytona:
      optionalObject(w["daytona"], experimentalDaytonaSnapshotFromWire) ?? null,
  };
}

/** Legacy spelling of {@link rigSnapshotFromWire}. */
export const sandboxSnapshotFromWire = rigSnapshotFromWire;

/** The fields of a snapshot capture request that name nothing rig-related. */
interface RigSnapshotCaptureFields {
  /** Name for the new snapshot. */
  name: string;
  description?: string;
  /**
   * Capture mode (default `scrub_and_delete`):
   *   - `scrub_and_delete`: strip Amika-injected secrets, capture the clean
   *     filesystem, then delete the source rig.
   *   - `full`: capture everything as-is (including secrets) and keep the
   *     rig running.
   */
  mode?: "scrub_and_delete" | "full";
}

/**
 * Request body for POST /api/v0beta1/rig-snapshots. The union requires one of
 * the two spellings for the source rig without forcing callers that already
 * pass `sandboxRef` to change.
 */
export type CreateRigSnapshotRequest = RigSnapshotCaptureFields &
  (
    | { rigRef: string; sandboxRef?: string }
    | { sandboxRef: string; rigRef?: string }
  );

/**
 * Legacy spelling of {@link CreateRigSnapshotRequest}.
 *
 * Spelled out rather than aliased to the union: under the union a *read* of
 * `sandboxRef` widens to `string | undefined`, because one member declares it
 * optional. That silently breaks 0.11 code doing `const ref: string =
 * req.sandboxRef`. Here `sandboxRef` stays required exactly as it was, and the
 * type is still assignable to {@link CreateRigSnapshotRequest}.
 */
export type CreateSandboxSnapshotRequest = RigSnapshotCaptureFields & {
  /** Source rig, by name or id (the server resolves id first, then name). */
  sandboxRef: string;
  rigRef?: string;
};

export function createRigSnapshotRequestToWire(
  r: CreateRigSnapshotRequest,
): Record<string, unknown> {
  return omitUndefined({
    sandbox_ref: rigRefOf(r),
    name: r.name,
    description: r.description,
    mode: r.mode,
  });
}

/** Legacy spelling of {@link createRigSnapshotRequestToWire}. */
export const createSandboxSnapshotRequestToWire =
  createRigSnapshotRequestToWire;

/**
 * Resolve the source rig from whichever of the two spellings the caller used.
 * A non-empty `rigRef` wins; `||` rather than `??` so an empty rig spelling
 * falls through to the legacy one instead of shadowing it.
 *
 * The union above already rejects a request carrying neither, so the throw
 * catches an empty string in both, plus callers arriving untyped from
 * JavaScript.
 */
function rigRefOf(r: { rigRef?: string; sandboxRef?: string }): string {
  const ref = r.rigRef || r.sandboxRef;
  if (!ref) {
    throw new AmikaError("rigRef (or its alias sandboxRef) is required");
  }
  return ref;
}

/**
 * The injected secrets a scrub-and-delete snapshot would remove from a
 * rig — file paths and env var names only, never values. `restoredFiles`
 * is a third category: paths reset to a retained clean baseline rather than
 * deleted outright.
 */
export interface RigScrubPreview {
  files: string[];
  restoredFiles: string[];
  envVars: string[];
}

/** Legacy spelling of {@link RigScrubPreview}. */
export type SandboxScrubPreview = RigScrubPreview;

export function rigScrubPreviewFromWire(
  w: Record<string, unknown>,
): RigScrubPreview {
  return {
    files: strArray(w["files"]),
    restoredFiles: strArray(w["restored_files"]),
    envVars: strArray(w["env_vars"]),
  };
}

/** Legacy spelling of {@link rigScrubPreviewFromWire}. */
export const sandboxScrubPreviewFromWire = rigScrubPreviewFromWire;

// ---------- wire helpers ----------

function omitUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** A schema-required, non-nullable string: null and absent both become "". */
export function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}

/** A schema-nullable string: null and absent both become null. */
export function nullableStr(v: unknown): string | null {
  return v === undefined || v === null ? null : String(v);
}

/** An optional string: null and absent both become undefined. */
export function optionalStr(v: unknown): string | undefined {
  return v === undefined || v === null ? undefined : String(v);
}

export function num(v: unknown): number {
  return v === undefined || v === null ? 0 : Number(v);
}

export function nullableNum(v: unknown): number | null {
  return v === undefined || v === null ? null : Number(v);
}

export function optionalNum(v: unknown): number | undefined {
  return v === undefined || v === null ? undefined : Number(v);
}

export function bool(v: unknown): boolean {
  return Boolean(v);
}

export function optionalBool(v: unknown): boolean | undefined {
  return v === undefined || v === null ? undefined : Boolean(v);
}

export function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((item) => str(item)) : [];
}

function optionalStrArray(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.map((item) => str(item)) : undefined;
}

export function mapArray<T>(
  v: unknown,
  from: (w: Record<string, unknown>) => T,
): T[] {
  return Array.isArray(v)
    ? v.map((item) => from(item as Record<string, unknown>))
    : [];
}

function optionalArray<T>(
  v: unknown,
  from: (w: Record<string, unknown>) => T,
): T[] | undefined {
  return Array.isArray(v)
    ? v.map((item) => from(item as Record<string, unknown>))
    : undefined;
}

export function optionalObject<T>(
  v: unknown,
  from: (w: Record<string, unknown>) => T,
): T | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? from(v as Record<string, unknown>)
    : undefined;
}
