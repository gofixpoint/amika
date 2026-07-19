import { AmikaError, AmikaHTTPError, extractAgentAuthError } from "@/errors";
import { HTTPClient } from "@/http";
import { StaticTokenSource, type TokenSource } from "@/token";
import {
  createSandboxAndWait as createSandboxAndWaitWorkflow,
  runAgent as runAgentWorkflow,
  type RunAgentRequest,
  type RunAgentResult,
  type WorkflowOptions,
  withSandbox as withSandboxWorkflow,
} from "@/workflows";
import {
  type WaitOptions,
  waitForSandboxState,
} from "@/wait";
import {
  type AgentSendRequest,
  type AgentSendResponse,
  agentSendRequestToWire,
  agentSendResponseFromWire,
  type CreateProviderSecretRequest,
  type CreateSandboxRequest,
  type CreateSandboxSnapshotRequest,
  createSandboxSnapshotRequestToWire,
  type CreateSecretRequest,
  type CreateSessionRequest,
  createSandboxRequestToWire,
  createSessionRequestToWire,
  type ProviderSecretListItem,
  type ProviderSecretSummary,
  type RemoteSandbox,
  remoteSandboxFromWire,
  type RevokeSSHRequest,
  type SandboxScrubPreview,
  sandboxScrubPreviewFromWire,
  type SandboxSnapshot,
  sandboxSnapshotFromWire,
  type Secret,
  type Session,
  sessionFromWire,
  type SSHInfo,
  sshInfoFromWire,
  type UpdateSecretRequest,
  type UpdateSessionRequest,
  updateSessionRequestToWire,
} from "@/types";

const API_BASE_PATH = "/api/v0beta1";

const DEFAULT_TIMEOUT_MS = 30_000;
const AGENT_SEND_TIMEOUT_MS = 10 * 60 * 1000;

export type { RunAgentRequest, RunAgentResult, WorkflowOptions, WaitOptions };

export interface AmikaClientOptions {
  baseUrl: string;
  /** Static access token. Mutually exclusive with `tokenSource`. */
  accessToken?: string;
  /** Custom token source. Mutually exclusive with `accessToken`. */
  tokenSource?: TokenSource;
  /** Override `fetch` for testing or runtime polyfills. */
  fetch?: typeof fetch;
}

/**
 * AmikaClient calls the remote Amika API with a bearer token. Mirrors Go's
 * `apiclient.Client` 1:1 — method names, inputs, return shapes, and HTTP
 * behavior (timeouts, polling intervals, 404 handling) all match.
 */
export class AmikaClient {
  private readonly http: HTTPClient;

  constructor(options: AmikaClientOptions) {
    const tokenSource = resolveTokenSource(options);
    this.http = new HTTPClient({
      baseUrl: options.baseUrl,
      tokenSource,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      fetch: options.fetch,
    });
  }

  // ---------- Sandboxes ----------

  async listSandboxes(): Promise<RemoteSandbox[]> {
    const data =
      (await this.http.doJSON<unknown[]>(
        "GET",
        `${API_BASE_PATH}/sandboxes`,
      )) ?? [];
    return data.map((item) =>
      remoteSandboxFromWire(item as Record<string, unknown>),
    );
  }

  async createSandbox(req: CreateSandboxRequest): Promise<RemoteSandbox> {
    const data = await this.http.doJSON<Record<string, unknown>>(
      "POST",
      `${API_BASE_PATH}/sandboxes`,
      createSandboxRequestToWire(req),
    );
    return remoteSandboxFromWire(data ?? {});
  }

  async getSandbox(name: string): Promise<RemoteSandbox> {
    const data = await this.http.doJSON<Record<string, unknown>>(
      "GET",
      `${API_BASE_PATH}/sandboxes/${encodeURIComponent(name)}`,
    );
    return remoteSandboxFromWire(data ?? {});
  }

  /**
   * Create a sandbox and poll until it reaches a ready state. Combines
   * {@link createSandbox} and {@link waitForSandbox}.
   */
  createSandboxAndWait(
    req: CreateSandboxRequest,
    wait?: WaitOptions,
  ): Promise<RemoteSandbox> {
    return createSandboxAndWaitWorkflow(this, req, wait);
  }

  /**
   * Create a sandbox, wait until ready, run `fn`, then delete the sandbox
   * (best-effort). Re-throws errors from `fn` after cleanup.
   */
  withSandbox<T>(
    req: CreateSandboxRequest,
    fn: (sandbox: RemoteSandbox) => Promise<T>,
    options?: WorkflowOptions,
  ): Promise<T> {
    return withSandboxWorkflow(this, req, fn, options);
  }

  /**
   * Provision a sandbox, send one agent message, and optionally delete the
   * sandbox when finished.
   */
  runAgent(req: RunAgentRequest, options?: WorkflowOptions): Promise<RunAgentResult> {
    return runAgentWorkflow(this, req, options);
  }

  /**
   * Polls `getSandbox(name)` every 3 seconds until the sandbox reaches a
   * ready state (`active`, `running`, `started`) or `failed`. No client-side
   * timeout by default — matches Go's `WaitForSandbox`.
   */
  waitForSandbox(name: string, options?: WaitOptions): Promise<RemoteSandbox> {
    return waitForSandboxState(
      (n) => this.getSandbox(n),
      name,
      ["active", "running", "started"],
      "sandbox provisioning failed",
      options,
    );
  }

  async getSSH(name: string): Promise<SSHInfo> {
    const data = await this.http.doJSON<Record<string, unknown>>(
      "POST",
      `${API_BASE_PATH}/sandboxes/${encodeURIComponent(name)}/ssh`,
    );
    return sshInfoFromWire(data ?? {});
  }

  async revokeSSH(name: string, token: string): Promise<void> {
    const body: RevokeSSHRequest = { token };
    await this.http.doJSON(
      "DELETE",
      `${API_BASE_PATH}/sandboxes/${encodeURIComponent(name)}/ssh`,
      body,
    );
  }

  async startSandbox(name: string): Promise<void> {
    await this.http.doJSON(
      "POST",
      `${API_BASE_PATH}/sandboxes/${encodeURIComponent(name)}/start`,
    );
  }

  waitForSandboxStart(
    name: string,
    options?: WaitOptions,
  ): Promise<RemoteSandbox> {
    return waitForSandboxState(
      (n) => this.getSandbox(n),
      name,
      ["active", "running", "started"],
      "sandbox start failed",
      options,
    );
  }

  async stopSandbox(name: string): Promise<void> {
    await this.http.doJSON(
      "POST",
      `${API_BASE_PATH}/sandboxes/${encodeURIComponent(name)}/stop`,
    );
  }

  waitForSandboxStop(
    name: string,
    options?: WaitOptions,
  ): Promise<RemoteSandbox> {
    return waitForSandboxState(
      (n) => this.getSandbox(n),
      name,
      ["stopped"],
      "sandbox stop failed",
      options,
    );
  }

  async deleteSandbox(name: string): Promise<void> {
    await this.http.doJSON(
      "DELETE",
      `${API_BASE_PATH}/sandboxes/${encodeURIComponent(name)}`,
    );
  }

  // ---------- Secrets ----------

  async listSecrets(): Promise<Secret[]> {
    const data =
      (await this.http.doJSON<Secret[]>("GET", `${API_BASE_PATH}/secrets`)) ??
      [];
    return data;
  }

  async createSecret(req: CreateSecretRequest): Promise<void> {
    await this.http.doJSON("POST", `${API_BASE_PATH}/secrets`, req);
  }

  async updateSecret(id: string, req: UpdateSecretRequest): Promise<void> {
    await this.http.doJSON("PUT", `${API_BASE_PATH}/secrets/${id}`, req);
  }

  // ---------- Provider secrets ----------

  async createProviderSecret(
    provider: string,
    req: CreateProviderSecretRequest,
  ): Promise<ProviderSecretSummary> {
    const data = await this.http.doJSON<ProviderSecretSummary>(
      "POST",
      `${API_BASE_PATH}/secrets/${provider}`,
      req,
    );
    return data ?? { id: "", name: "", scope: "" };
  }

  async listProviderSecrets(
    provider: string,
  ): Promise<ProviderSecretListItem[]> {
    const data =
      (await this.http.doJSON<ProviderSecretListItem[]>(
        "GET",
        `${API_BASE_PATH}/secrets/${provider}`,
      )) ?? [];
    return data;
  }

  async deleteProviderSecret(provider: string, id: string): Promise<void> {
    await this.http.doJSON(
      "DELETE",
      `${API_BASE_PATH}/secrets/${provider}/${id}`,
    );
  }

  // ---------- Agent send ----------

  /**
   * Send a message to an agent inside a remote sandbox. The endpoint is
   * synchronous: it blocks until the agent finishes, so a longer per-request
   * timeout (10 minutes) is used in place of the default 30 seconds.
   */
  async agentSend(
    sandboxName: string,
    req: AgentSendRequest,
  ): Promise<AgentSendResponse> {
    try {
      const data = await this.http.doJSON<Record<string, unknown>>(
        "POST",
        `${API_BASE_PATH}/sandboxes/${encodeURIComponent(sandboxName)}/agent-send`,
        agentSendRequestToWire(req),
        { timeoutMs: AGENT_SEND_TIMEOUT_MS },
      );
      return agentSendResponseFromWire(data ?? {});
    } catch (err) {
      const authErr = extractAgentAuthError(err);
      if (authErr) {
        throw new AmikaError(
          `remote agent-send: agent failed to authenticate with its AI provider: ${authErr}\n\nthe sandbox agent's API credentials may have expired or been revoked; recreate the sandbox or update its API keys to restore access`,
        );
      }
      throw err;
    }
  }

  // ---------- Sessions ----------

  async createSession(
    sandboxName: string,
    req: CreateSessionRequest,
  ): Promise<Session> {
    const data = await this.http.doJSON<Record<string, unknown>>(
      "POST",
      `${API_BASE_PATH}/sandboxes/${encodeURIComponent(sandboxName)}/sessions`,
      createSessionRequestToWire(req),
    );
    return sessionFromWire(data ?? {});
  }

  async listSessions(sandboxName: string): Promise<Session[]> {
    const envelope = await this.http.doJSON<{
      sessions?: Record<string, unknown>[];
    }>(
      "GET",
      `${API_BASE_PATH}/sandboxes/${encodeURIComponent(sandboxName)}/sessions`,
    );
    const sessions = envelope?.sessions ?? [];
    return sessions.map((s) => sessionFromWire(s));
  }

  /** Returns null if no session exists (HTTP 404). */
  async getLatestSession(sandboxName: string): Promise<Session | null> {
    try {
      const data = await this.http.doJSON<Record<string, unknown>>(
        "GET",
        `${API_BASE_PATH}/sandboxes/${encodeURIComponent(sandboxName)}/sessions/latest`,
      );
      return sessionFromWire(data ?? {});
    } catch (err) {
      if (err instanceof AmikaHTTPError && err.statusCode === 404) return null;
      throw err;
    }
  }

  async getSession(sandboxName: string, sessionId: string): Promise<Session> {
    const data = await this.http.doJSON<Record<string, unknown>>(
      "GET",
      `${API_BASE_PATH}/sandboxes/${encodeURIComponent(sandboxName)}/sessions/${encodeURIComponent(sessionId)}`,
    );
    return sessionFromWire(data ?? {});
  }

  async updateSession(
    sandboxName: string,
    sessionId: string,
    req: UpdateSessionRequest,
  ): Promise<Session> {
    const data = await this.http.doJSON<Record<string, unknown>>(
      "PATCH",
      `${API_BASE_PATH}/sandboxes/${encodeURIComponent(sandboxName)}/sessions/${encodeURIComponent(sessionId)}`,
      updateSessionRequestToWire(req),
    );
    return sessionFromWire(data ?? {});
  }

  // ---------- Sandbox snapshots ----------

  /**
   * List sandbox-captured snapshots for the caller's org. Both filters are
   * optional; omit them to list every snapshot.
   */
  async listSandboxSnapshots(filters?: {
    repositoryId?: string;
    sourceSandboxId?: string;
  }): Promise<SandboxSnapshot[]> {
    const params = new URLSearchParams();
    if (filters?.repositoryId)
      params.set("repository_id", filters.repositoryId);
    if (filters?.sourceSandboxId)
      params.set("source_sandbox_id", filters.sourceSandboxId);
    const qs = params.toString();
    const path = `${API_BASE_PATH}/sandbox-snapshots${qs ? `?${qs}` : ""}`;
    const envelope = await this.http.doJSON<{
      items?: Record<string, unknown>[];
    }>("GET", path);
    const items = envelope?.items ?? [];
    return items.map((item) => sandboxSnapshotFromWire(item));
  }

  /**
   * Start capturing a snapshot from a running sandbox. The endpoint returns
   * 202 Accepted with the snapshot in the `capturing` state; poll
   * {@link listSandboxSnapshots} until it reaches `active` or `failed`.
   */
  async createSandboxSnapshot(
    req: CreateSandboxSnapshotRequest,
  ): Promise<SandboxSnapshot> {
    const data = await this.http.doJSON<Record<string, unknown>>(
      "POST",
      `${API_BASE_PATH}/sandbox-snapshots`,
      createSandboxSnapshotRequestToWire(req),
    );
    return sandboxSnapshotFromWire(data ?? {});
  }

  /**
   * Preview which injected secrets a scrub-and-delete snapshot would remove
   * from a sandbox (file paths + env var names only, no values). `sandboxRef`
   * is a name or id; the server resolves id first, then name.
   */
  async getSandboxScrubPreview(
    sandboxRef: string,
  ): Promise<SandboxScrubPreview> {
    const params = new URLSearchParams({ sandbox: sandboxRef, by: "ref" });
    const data = await this.http.doJSON<Record<string, unknown>>(
      "GET",
      `${API_BASE_PATH}/sandbox-snapshots/scrub-preview?${params.toString()}`,
    );
    return sandboxScrubPreviewFromWire(data ?? {});
  }

  /**
   * Delete a sandbox snapshot referenced by name or id (the server resolves
   * id first, then name).
   */
  async deleteSandboxSnapshot(ref: string): Promise<void> {
    await this.http.doJSON(
      "DELETE",
      `${API_BASE_PATH}/sandbox-snapshots/${encodeURIComponent(ref)}?by=ref`,
    );
  }
}

function resolveTokenSource(options: AmikaClientOptions): TokenSource {
  if (options.tokenSource && options.accessToken !== undefined) {
    throw new Error(
      "AmikaClient: pass either accessToken or tokenSource, not both",
    );
  }
  if (options.tokenSource) return options.tokenSource;
  if (options.accessToken !== undefined)
    return new StaticTokenSource(options.accessToken);
  throw new Error("AmikaClient: accessToken or tokenSource is required");
}
