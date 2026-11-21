import {
  type AgentCredentialRef,
  type CreateRigRequest,
  type RemoteRigService,
  type MountedSecret,
  type RemoteRig,
  type ResolvedAgentCredential,
} from "./types.js";
import {
  omitUndefined,
  str,
  num,
  bool,
  nullableStr,
  mapArray,
  optionalStr,
  optionalNum,
  optionalBool,
  optionalStrArray,
  optionalArray,
  optionalObject,
} from "../internal/wire.js";
import { normalizeRef, refFieldName } from "../internal/resource-ref.js";
import type { ResourceRef } from "../resource-ref.js";

/**
 * The account goes out as `cloud_account_id`, `cloud_account_name`, or
 * `cloud_account_ref`, by its reference's kind.
 */
export function createRigRequestToWire(
  r: CreateRigRequest,
): Record<string, unknown> {
  const wire = omitUndefined({
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
    host_id: r.hostId,
  });
  if (r.cloudAccount !== undefined) {
    const ref = normalizeRef(r.cloudAccount, "cloudAccount");
    wire[refFieldName("cloud_account", ref)] = ref.value;
  }
  return wire;
}

/**
 * The inverse of {@link createRigRequestToWire}, for a create body the server
 * echoes back, such as a job step's `rig_create`. Fields the SDK does not
 * model are dropped.
 */
export function createRigRequestFromWire(
  w: Record<string, unknown>,
): CreateRigRequest {
  const record = (v: unknown) =>
    typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, string>)
      : undefined;
  return omitUndefined({
    name: optionalStr(w["name"]),
    provider: optionalStr(w["provider"]),
    repoUrl: optionalStr(w["repo_url"]),
    autoStopInterval: optionalNum(w["auto_stop_interval"]),
    autoDeleteInterval: optionalNum(w["auto_delete_interval"]),
    envVars: record(w["env_vars"]),
    secretEnvVars: record(w["secret_env_vars"]),
    preset: optionalStr(w["preset"]),
    size: optionalStr(w["size"]),
    // Keep an explicit null: it opts out of the default snapshot.
    snapshot: w["snapshot"] === null ? null : optionalStr(w["snapshot"]),
    setupScriptText: optionalStr(w["setup_script_text"]),
    agentCredentials: Array.isArray(w["agent_credentials"])
      ? (w["agent_credentials"] as AgentCredentialRef[])
      : undefined,
    branch: optionalStr(w["branch"]),
    newBranchName: optionalStr(w["new_branch_name"]),
    githubAuthMode: optionalStr(w["github_auth_mode"]),
    hostId: optionalStr(w["host_id"]),
    cloudAccount: cloudAccountRefFromWire(w),
  }) as CreateRigRequest;
}

/** Reads whichever of `cloud_account_ref`, `_name`, and `_id` is set. */
function cloudAccountRefFromWire(
  w: Record<string, unknown>,
): ResourceRef | undefined {
  const ref = optionalStr(w["cloud_account_ref"]);
  if (ref !== undefined) return ref;
  const name = optionalStr(w["cloud_account_name"]);
  if (name !== undefined) return { ref: name, by: "name" };
  const id = optionalStr(w["cloud_account_id"]);
  if (id !== undefined) return { ref: id, by: "id" };
  return undefined;
}

export function remoteRigServiceFromWire(
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

export function mountedSecretFromWire(
  w: Record<string, unknown>,
): MountedSecret {
  return {
    name: str(w["name"]),
    scope: str(w["scope"]),
    managed: bool(w["managed"]),
    credentialType: nullableStr(w["credential_type"]),
    provider: nullableStr(w["provider"]),
  };
}

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
    cloudAccount:
      optionalObject(w["cloud_account"], (c) => ({
        id: str(c["id"]),
        name: str(c["name"]),
      })) ?? null,
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
    resolvedAgentCredentials: w["resolved_agent_credentials"] as
      | ResolvedAgentCredential[]
      | undefined,
    createdBy: optionalObject(w["created_by"], (c) => ({
      name: nullableStr(c["name"]),
      email: nullableStr(c["email"]),
    })),
    origin: optionalStr(w["origin"]),
    hostId: optionalStr(w["host_id"]),
    hostname: optionalStr(w["hostname"]),
    agentCwd: optionalStr(w["agent_cwd"]),
    sshKeyStatus: optionalStr(w["ssh_key_status"]),
  };
}
