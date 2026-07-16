// CamelCase TS mirrors of the Go SDK types in go/internal/apiclient/client.go.
// Each request/response has explicit toWire/fromWire mappers to translate
// between the SDK's camelCase developer surface and the snake_case JSON wire
// format the server expects.

// ---------- Sandboxes ----------

/**
 * Selects which stored credential of a given `kind` the server injects
 * into a sandbox (e.g. a Claude credential surfaces as `ANTHROPIC_API_KEY`
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
 * the sandbox boots unauthenticated against every agent, regardless of
 * any configured user or org credential.
 *
 *   // Unauthenticated: the agent has no credential to use.
 *   await client.createSandbox({ repoUrl });
 *
 *   // Authenticated: server picks the default Claude credential.
 *   await client.createSandbox({
 *     repoUrl,
 *     agentCredentials: [{ kind: "claude" }],
 *   });
 *
 * The create-sandbox response echoes the outcome per engaged kind in
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

/** Request body for POST /api/v0beta1/sandboxes. */
export interface CreateSandboxRequest {
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
   * Snapshot to fork the new sandbox from, given as its org-stripped slug
   * (e.g. `amika-mono-base`). Capture one with {@link AmikaClient.createSandboxSnapshot}.
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
}

export function createSandboxRequestToWire(
  r: CreateSandboxRequest,
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
  });
}

export interface ResolvedAgentCredential {
  kind: string;
  outcome: "resolved" | "skipped" | string;
  name?: string;
  type?: string;
  source?: string;
  reason?: string;
}

export interface RemoteSandboxCreator {
  name: string | null;
  email: string | null;
}

export interface RemoteSandbox {
  id: string;
  name: string;
  provider: string;
  repoUrl: string;
  state: string;
  createdAt: string;
  branch: string;
  errorMessage: string;
  resolvedAgentCredentials?: ResolvedAgentCredential[];
  createdBy?: RemoteSandboxCreator | null;
}

export function remoteSandboxFromWire(
  w: Record<string, unknown>,
): RemoteSandbox {
  return {
    id: String(w["id"] ?? ""),
    name: String(w["name"] ?? ""),
    provider: String(w["provider"] ?? ""),
    repoUrl: String(w["repo_url"] ?? ""),
    state: String(w["state"] ?? ""),
    createdAt: String(w["created_at"] ?? ""),
    branch: String(w["branch"] ?? ""),
    errorMessage: String(w["error_message"] ?? ""),
    resolvedAgentCredentials: w["resolved_agent_credentials"] as
      | ResolvedAgentCredential[]
      | undefined,
    createdBy: w["created_by"] as RemoteSandboxCreator | null | undefined,
  };
}

// ---------- SSH ----------

export interface SSHInfo {
  sshDestination: string;
  token: string;
  expiresAt: string;
  repoName: string;
}

export function sshInfoFromWire(w: Record<string, unknown>): SSHInfo {
  return {
    sshDestination: String(w["ssh_destination"] ?? ""),
    token: String(w["token"] ?? ""),
    expiresAt: String(w["expires_at"] ?? ""),
    repoName: String(w["repo_name"] ?? ""),
  };
}

/** Request body for DELETE /api/v0beta1/sandboxes/{name}/ssh. */
export interface RevokeSSHRequest {
  token: string;
}

// ---------- Secrets ----------

export interface Secret {
  id: string;
  name: string;
  scope: string;
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
}

export function agentSendResponseFromWire(
  w: Record<string, unknown>,
): AgentSendResponse {
  return {
    result: String(w["response"] ?? ""),
    sessionId: String(w["session_id"] ?? ""),
    isError: Boolean(w["is_error"]),
  };
}

// ---------- Sessions ----------

export interface Session {
  id: string;
  sandboxId: string;
  orgId: string;
  agentName: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export function sessionFromWire(w: Record<string, unknown>): Session {
  return {
    id: String(w["id"] ?? ""),
    sandboxId: String(w["sandbox_id"] ?? ""),
    orgId: String(w["org_id"] ?? ""),
    agentName: String(w["agent_name"] ?? ""),
    status: String(w["status"] ?? ""),
    startedAt: String(w["started_at"] ?? ""),
    endedAt: (w["ended_at"] ?? null) as string | null,
    metadata: (w["metadata"] ?? {}) as Record<string, unknown>,
    createdAt: String(w["created_at"] ?? ""),
    updatedAt: String(w["updated_at"] ?? ""),
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

// ---------- Sandbox snapshots ----------

/**
 * A snapshot captured from a running sandbox, as returned by the
 * `/api/v0beta1/sandbox-snapshots` endpoints. `snapshot` is the slug used to
 * fork new sandboxes (pass it as {@link CreateSandboxRequest.snapshot}).
 */
export interface SandboxSnapshot {
  snapshot: string;
  provider: string;
  description: string | null;
  sourceSandboxId: string | null;
  sourceSandboxName: string | null;
  repositoryId: string | null;
  baseSnapshot: string | null;
  sandboxPreset: string | null;
  sandboxSize: string | null;
  state: string;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export function sandboxSnapshotFromWire(
  w: Record<string, unknown>,
): SandboxSnapshot {
  return {
    snapshot: String(w["snapshot"] ?? ""),
    provider: String(w["provider"] ?? ""),
    description: (w["description"] ?? null) as string | null,
    sourceSandboxId: (w["source_sandbox_id"] ?? null) as string | null,
    sourceSandboxName: (w["source_sandbox_name"] ?? null) as string | null,
    repositoryId: (w["repository_id"] ?? null) as string | null,
    baseSnapshot: (w["base_snapshot"] ?? null) as string | null,
    sandboxPreset: (w["sandbox_preset"] ?? null) as string | null,
    sandboxSize: (w["sandbox_size"] ?? null) as string | null,
    state: String(w["state"] ?? ""),
    errorMessage: (w["error_message"] ?? null) as string | null,
    createdAt: String(w["created_at"] ?? ""),
    updatedAt: String(w["updated_at"] ?? ""),
  };
}

/** Request body for POST /api/v0beta1/sandbox-snapshots. */
export interface CreateSandboxSnapshotRequest {
  /** Source sandbox, by name or id (the server resolves id first, then name). */
  sandboxRef: string;
  /** Name for the new snapshot. */
  name: string;
  description?: string;
  /**
   * Capture mode (default `scrub_and_delete`):
   *   - `scrub_and_delete`: strip Amika-injected secrets, capture the clean
   *     filesystem, then delete the source sandbox.
   *   - `full`: capture everything as-is (including secrets) and keep the
   *     sandbox running.
   */
  mode?: "scrub_and_delete" | "full";
}

export function createSandboxSnapshotRequestToWire(
  r: CreateSandboxSnapshotRequest,
): Record<string, unknown> {
  return omitUndefined({
    sandbox_ref: r.sandboxRef,
    name: r.name,
    description: r.description,
    mode: r.mode,
  });
}

/**
 * The injected secrets a scrub-and-delete snapshot would remove from a
 * sandbox — file paths and env var names only, never values.
 */
export interface SandboxScrubPreview {
  files: string[];
  envVars: string[];
}

export function sandboxScrubPreviewFromWire(
  w: Record<string, unknown>,
): SandboxScrubPreview {
  return {
    files: (w["files"] ?? []) as string[],
    envVars: (w["env_vars"] ?? []) as string[],
  };
}

// ---------- helpers ----------

function omitUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
