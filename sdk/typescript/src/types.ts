// CamelCase TS mirrors of the Go SDK types in internal/apiclient/client.go.
// Each request/response has explicit toWire/fromWire mappers to translate
// between the SDK's camelCase developer surface and the snake_case JSON wire
// format the server expects.

// ---------- Sandboxes ----------

/** Selects which credential of a given kind the server should inject into a sandbox. */
export interface AgentCredentialRef {
  kind: string;
  name?: string;
  type?: "oauth" | "api_key";
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

// ---------- helpers ----------

function omitUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
