import { type LegacyShape } from "../internal/types.js";

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
 *   await client.rigs.create({ repoUrl });
 *
 *   // Authenticated: server picks the default Claude credential.
 *   await client.rigs.create({
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
  /** Optional rig name; omission lets the server choose one. */
  name?: string;
  /** Optional provider override. Omit to use the server configuration. */
  provider?: string;
  /** Repository clone URL. The SDK does not auto-detect a local Git checkout. */
  repoUrl?: string;
  /** Automatic stop interval in minutes. Omit to use server defaults; provider support is validated by the server. */
  autoStopInterval?: number;
  /** Automatic deletion interval in minutes after stopping. Omit to use server defaults; provider support is validated by the server. */
  autoDeleteInterval?: number;
  /** Literal environment variables to inject, keyed by variable name. */
  envVars?: Record<string, string>;
  /** Stored secret names to inject, keyed by environment-variable name. Values identify secrets, not their contents. */
  secretEnvVars?: Record<string, string>;
  /** Environment preset name. Omit to use server or repository defaults. */
  preset?: string;
  /** Provider-supported rig size. Omit to use server or repository defaults. */
  size?: string;
  /**
   * Snapshot to fork the new rig from, given as its org-stripped slug
   * (e.g. `amika-mono-base`). Capture one with `client.snapshots.create`.
   *
   * Tri-state, matching the server's `snapshot` param:
   *   - a slug  -> boot from that snapshot
   *   - `null`  -> explicitly opt out of the repo-level default snapshot
   *   - omitted -> keep the full default chain (repo default, else preset/size)
   */
  snapshot?: string | null;
  /** Setup-script contents to run in the rig. The SDK does not read a local script file. */
  setupScriptText?: string;
  /** Credential selectors, at most one per agent kind. Omission injects no agent credentials; see AgentCredentialRef. */
  agentCredentials?: AgentCredentialRef[];
  /** Git branch to check out or create according to server behavior. */
  branch?: string;
  /** New branch to create, optionally based on branch. */
  newBranchName?: string;
  /** GitHub authentication mode supported by the server, such as pat or app_token. Omit to use its default. */
  githubAuthMode?: string;
}

/** @deprecated Use {@link CreateRigRequest}. */
export type CreateSandboxRequest = CreateRigRequest;

/** Outcome of selecting one agent credential while creating a rig. */
export interface ResolvedAgentCredential {
  /** Kind of agent, credential, or service represented by this entry. */
  kind: string;
  /** Credential-selection outcome, commonly resolved or skipped. Additional server values are preserved. */
  outcome: "resolved" | "skipped" | string;
  /** Resource name. */
  name?: string;
  /** Credential type reported by the server. */
  type?: string;
  /** Origin of this entry, as reported by the server. */
  source?: string;
  /** Explanation when credential selection was skipped. */
  reason?: string;
}

/**
 * One named service exposed by a rig: a published port with an optional
 * generated URL. Wire keys are camelCase here, unlike the rest of the API.
 */
export interface RemoteRigService {
  /** Resource name. */
  name: string;
  /** Published service URL; empty when no URL is available. */
  url: string;
  /** Port exposed by the host or provider. */
  hostPort: number;
  /** Port served inside the rig. */
  containerPort: number;
  /** Transport protocol reported by the server. */
  protocol: string;
}

/** @deprecated Use {@link RemoteRigService}, the service metadata in rig.services. */
export type RemoteSandboxService = RemoteRigService;

/**
 * One secret a rig carries, by name and scope. The API deliberately
 * returns no value and no vault handle. `managed` distinguishes a credential
 * Amika manages for a provider from a plain user-defined secret; it is the
 * discriminator rather than a null `credentialType`, which a managed entry is
 * allowed to have.
 */
export interface MountedSecret {
  /** Resource name. */
  name: string;
  /** Ownership scope, such as user or org. */
  scope: string;
  /** Whether Amika manages this credential for a provider. */
  managed: boolean;
  /** Credential type, if known. Use managed to distinguish managed credentials. */
  credentialType: string | null;
  /** Infrastructure or credential provider reported by the server. */
  provider: string | null;
}

/**
 * Mirrors the API's Sandbox schema (the `Sandbox` component in
 * /api/openapi.json), the response of the /rigs endpoints.
 *
 * `providerRigId`, `rigPreset`, and `rigSize` are the canonical spellings of
 * the three fields the schema still names after sandboxes. Each is decoded
 * from the same wire key as its `sandbox*` twin and carries the same value, so
 * either name reads the field.
 */
export interface RemoteRig {
  /** Resource identifier assigned by the server. */
  id: string;
  /** User associated with this resource; null where the API has no user. */
  userId: string | null;
  /** Organization that owns this resource. */
  orgId: string;
  /** Resource name. */
  name: string;
  /** Infrastructure or credential provider reported by the server. */
  provider: string | null;
  /** Canonical spelling; mirrors {@link RemoteRig.providerSandboxId}. */
  providerRigId: string | null;
  /** Legacy spelling of providerRigId; carries the same value. */
  providerSandboxId: string | null;
  /** Provider console URL, or null when unavailable. */
  providerUrl: string | null;
  /** OpenCode web interface URL, or null when unavailable. */
  amikaOpencodeWeb: string | null;
  /** Repository name, or null when this rig has no repository. */
  repoName: string | null;
  /** Repository host, or null when unavailable. */
  repoProvider: string | null;
  /** Repository identifier, or null when unavailable. */
  repoId: string | null;
  /** Repository clone URL. */
  repoUrl: string | null;
  /** Git branch selected for the rig. */
  branch: string | null;
  /** Checked-out Git commit, or null when unavailable. */
  commitHash: string | null;
  /** Snapshot slug used to create another rig. */
  snapshot: string | null;
  /** Current lower-level session-record ID, or null when none is selected. */
  currentSessionId: string | null;
  /** Abbreviated published-service metadata. Use client.services.list for full service records. */
  services: RemoteRigService[];
  /** Creation timestamp returned by the server. */
  createdAt: string;
  /** Last-update timestamp returned by the server. */
  updatedAt: string;

  /** Display name of the base snapshot, when available. */
  snapshotName?: string;
  /** Canonical spelling; mirrors {@link RemoteRig.sandboxPreset}. */
  rigPreset?: string;
  /** Legacy spelling of rigPreset; carries the same value. */
  sandboxPreset?: string;
  /** Canonical spelling; mirrors {@link RemoteRig.sandboxSize}. */
  rigSize?: string;
  /** Legacy spelling of rigSize; carries the same value. */
  sandboxSize?: string;
  /** GitHub authentication mode reported by the server. */
  githubAuthMode?: string;
  /** Whether GitHub credentials were provisioned in the rig. */
  githubCredentialProvisioned?: boolean;
  /** Server-reported failure details, when available. */
  errorMessage?: string;
  /** Raw provisioning state reported by the server. Use rig.wait() to check readiness. */
  state: string;
  /** Current lifecycle status reported by the server. */
  status: string;
  /** Setup-script status, such as ok or setup-failed. rig.wait() checks this by default. */
  setupStatus?: string;
  /** Expiration timestamp for temporary service URLs, when returned. */
  urlsExpireAt?: string;
  /** Names of secrets injected into the rig; values are never returned. */
  secretNames?: string[];
  /** Metadata describing injected secrets, without their values. */
  mountedSecrets?: MountedSecret[];
  /** Credential-selection outcomes for the agent kinds requested at creation. */
  resolvedAgentCredentials?: ResolvedAgentCredential[];
  /** Creator details, when the server can resolve them. */
  createdBy?: RemoteRigCreator;
  /** How the rig was created, when reported by the server. */
  origin?: string;
  /** BYOC host machine identifier, when returned by the server. */
  hostId?: string;
  /** DNS hostname of the rig. Older servers may omit it. */
  hostname?: string;
  /** Working directory used for agent execution. */
  agentCwd?: string;
  /** SSH-key provisioning status, when returned by the server. */
  sshKeyStatus?: string;
}

/** @deprecated Use {@link RemoteRig}. */
export type RemoteSandbox = LegacyShape<RemoteRig, "providerRigId">;

/**
 * The human who created a remote rig. Either field may be null if the
 * server could not resolve the user (deleted account, API-key principal, or
 * noop auth mode).
 */
export interface RemoteRigCreator {
  /** Creator display name, or null when unavailable. */
  name: string | null;
  /** Creator email address, or null when unavailable. */
  email: string | null;
}

/** @deprecated Use {@link RemoteRigCreator}. */
export type RemoteSandboxCreator = RemoteRigCreator;
