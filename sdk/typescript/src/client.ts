import {
  type AgentSessionDetail,
  agentSessionDetailFromWire,
  type AgentSessionSendRequest,
  type AgentSessionSendResponse,
  agentSessionSendRequestToWire,
  agentSessionSendResponseFromWire,
  type AgentSessionStreamHandlers,
  type ListAgentSessionsResponse,
  listAgentSessionsResponseFromWire,
  readAgentSessionStream,
} from "@/agent-sessions";
import { AmikaError, AmikaHTTPError, extractAgentAuthError } from "@/errors";
import { HTTPClient } from "@/http";
import { StaticTokenSource, type TokenSource } from "@/token";
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
  mapArray,
  type ProviderSecretListItem,
  type ProviderSecretSummary,
  type RemoteRepository,
  remoteRepositoryFromWire,
  type RemoteSandbox,
  remoteSandboxFromWire,
  type RevokeSSHRequest,
  type SandboxScrubPreview,
  sandboxScrubPreviewFromWire,
  type SandboxServiceRequest,
  type SandboxServiceResource,
  sandboxServiceRequestToWire,
  sandboxServiceResourceFromWire,
  type SandboxSnapshot,
  sandboxSnapshotFromWire,
  type Secret,
  secretFromWire,
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
const WAIT_POLL_INTERVAL_MS = 3_000;

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
    const data = await this.http.doJSON<unknown[]>(
      "GET",
      `${API_BASE_PATH}/sandboxes`,
    );
    return mapArray(data, remoteSandboxFromWire);
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
   * Polls `getSandbox(name)` every 3 seconds until the sandbox reaches a
   * ready state (`active`, `running`, `started`) or `failed`. No client-side
   * timeout — matches Go's `WaitForSandbox`.
   */
  waitForSandbox(name: string): Promise<RemoteSandbox> {
    return waitForSandboxState(
      (n) => this.getSandbox(n),
      name,
      ["active", "running", "started"],
      "sandbox provisioning failed",
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

  waitForSandboxStart(name: string): Promise<RemoteSandbox> {
    return waitForSandboxState(
      (n) => this.getSandbox(n),
      name,
      ["active", "running", "started"],
      "sandbox start failed",
    );
  }

  async stopSandbox(name: string): Promise<void> {
    await this.http.doJSON(
      "POST",
      `${API_BASE_PATH}/sandboxes/${encodeURIComponent(name)}/stop`,
    );
  }

  waitForSandboxStop(name: string): Promise<RemoteSandbox> {
    return waitForSandboxState(
      (n) => this.getSandbox(n),
      name,
      ["stopped"],
      "sandbox stop failed",
    );
  }

  async deleteSandbox(name: string): Promise<void> {
    await this.http.doJSON(
      "DELETE",
      `${API_BASE_PATH}/sandboxes/${encodeURIComponent(name)}`,
    );
  }

  // ---------- Repositories ----------

  /** List the repositories the caller's org knows about. */
  async listRepositories(): Promise<RemoteRepository[]> {
    const data = await this.http.doJSON<unknown[]>(
      "GET",
      `${API_BASE_PATH}/repositories`,
    );
    return mapArray(data, remoteRepositoryFromWire);
  }

  // ---------- Sandbox services ----------

  /**
   * List live services for the caller's org. `sandboxRef` is an optional
   * name-or-id filter; omit it to list every service in the org.
   */
  async listSandboxServices(
    sandboxRef?: string,
  ): Promise<SandboxServiceResource[]> {
    const params = new URLSearchParams();
    if (sandboxRef) params.set("sandbox_ref", sandboxRef);
    const qs = params.toString();
    const envelope = await this.http.doJSON<{ items?: unknown[] }>(
      "GET",
      `${API_BASE_PATH}/sandbox-services${qs ? `?${qs}` : ""}`,
    );
    return mapArray(envelope?.items, sandboxServiceResourceFromWire);
  }

  /**
   * Create a service on the sandbox referenced by name or id (the server
   * resolves id first, then name).
   */
  async createSandboxService(
    sandboxRef: string,
    req: SandboxServiceRequest,
  ): Promise<SandboxServiceResource> {
    const data = await this.http.doJSON<Record<string, unknown>>(
      "POST",
      `${API_BASE_PATH}/sandboxes/${encodeURIComponent(sandboxRef)}/services`,
      sandboxServiceRequestToWire(req),
    );
    return sandboxServiceResourceFromWire(data ?? {});
  }

  /**
   * Fully replace the service identified by `serviceRef` within a sandbox.
   * `by` selects how `serviceRef` is resolved and defaults to `name`.
   */
  async putSandboxService(
    sandboxRef: string,
    serviceRef: string,
    req: SandboxServiceRequest,
    by: "name" | "id" | "ref" = "name",
  ): Promise<SandboxServiceResource> {
    const params = new URLSearchParams({ by });
    const data = await this.http.doJSON<Record<string, unknown>>(
      "PUT",
      `${API_BASE_PATH}/sandboxes/${encodeURIComponent(sandboxRef)}/services/${encodeURIComponent(serviceRef)}?${params.toString()}`,
      sandboxServiceRequestToWire(req),
    );
    return sandboxServiceResourceFromWire(data ?? {});
  }

  /** Delete the service with the given name within a sandbox. */
  async deleteSandboxService(
    sandboxRef: string,
    serviceRef: string,
  ): Promise<void> {
    await this.http.doJSON(
      "DELETE",
      `${API_BASE_PATH}/sandboxes/${encodeURIComponent(sandboxRef)}/services/${encodeURIComponent(serviceRef)}?by=name`,
    );
  }

  // ---------- Secrets ----------

  async listSecrets(): Promise<Secret[]> {
    const data = await this.http.doJSON<unknown[]>(
      "GET",
      `${API_BASE_PATH}/secrets`,
    );
    return mapArray(data, secretFromWire);
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
   * Fetch a single snapshot by name or id (the server resolves id first, then
   * name).
   */
  async getSandboxSnapshot(ref: string): Promise<SandboxSnapshot> {
    const data = await this.http.doJSON<Record<string, unknown>>(
      "GET",
      `${API_BASE_PATH}/sandbox-snapshots/${encodeURIComponent(ref)}?by=ref`,
    );
    return sandboxSnapshotFromWire(data ?? {});
  }

  /**
   * Poll {@link getSandboxSnapshot} every 3 seconds until the snapshot reaches
   * a terminal state. Returns it once `active`; throws `AmikaError` if it ends
   * up `failed`. No client-side timeout — matches Go's
   * `WaitForSandboxSnapshot`.
   */
  async waitForSandboxSnapshot(ref: string): Promise<SandboxSnapshot> {
    for (;;) {
      const snapshot = await this.getSandboxSnapshot(ref);
      if (snapshot.state === "active") return snapshot;
      if (snapshot.state === "failed") {
        throw new AmikaError(
          snapshot.errorMessage || "sandbox snapshot capture failed",
        );
      }
      await sleep(WAIT_POLL_INTERVAL_MS);
    }
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

  // ---------- Agent sessions ----------

  /**
   * Send a message to a coding agent, creating a sandbox behind the scenes
   * when the chat has none, or routing to an existing sandbox or session. The
   * endpoint is synchronous, so it uses the same 10-minute timeout as
   * {@link agentSend}.
   *
   * Unlike {@link agentSend}, a provider auth failure comes back as a normal
   * response with `isError` set and the agent CLI's own message in `response`,
   * not as an HTTP error.
   */
  async sendAgentSession(
    req: AgentSessionSendRequest,
  ): Promise<AgentSessionSendResponse> {
    const data = await this.http.doJSON<Record<string, unknown>>(
      "POST",
      `${API_BASE_PATH}/agent-sessions`,
      agentSessionSendRequestToWire(req),
      { timeoutMs: AGENT_SEND_TIMEOUT_MS },
    );
    return agentSessionSendResponseFromWire(data ?? {});
  }

  /**
   * The streaming counterpart to {@link sendAgentSession}: forwards `status`
   * and `delta` frames to `handlers` as they arrive and resolves with the same
   * response the buffered endpoint returns.
   *
   * The effective time limit is the server's (a 300s request ceiling), which
   * is lower than the client's 10 minutes: it ends the stream first, without a
   * terminal frame, and the client timeout only guards a connection that hangs
   * past even that.
   */
  async sendAgentSessionStream(
    req: AgentSessionSendRequest,
    handlers: AgentSessionStreamHandlers = {},
  ): Promise<AgentSessionSendResponse> {
    const { body, release } = await this.http.openStream(
      "POST",
      `${API_BASE_PATH}/agent-sessions/stream`,
      agentSessionSendRequestToWire(req),
      { timeoutMs: AGENT_SEND_TIMEOUT_MS },
    );
    try {
      return await readAgentSessionStream(body, handlers);
    } finally {
      release();
    }
  }

  /**
   * List the org's agent-session chats, newest first. Omitting `limit` leaves
   * the server's default page size (50) in place. The response's `total`
   * exceeds `sessions.length` when the page cuts the list short.
   */
  async listAgentSessions(limit?: number): Promise<ListAgentSessionsResponse> {
    const qs = limit && limit > 0 ? `?limit=${limit}` : "";
    const data = await this.http.doJSON<Record<string, unknown>>(
      "GET",
      `${API_BASE_PATH}/agent-sessions${qs}`,
    );
    return listAgentSessionsResponseFromWire(data ?? {});
  }

  /** Fetch one agent-session chat with its message history. */
  async getAgentSession(sessionId: string): Promise<AgentSessionDetail> {
    const data = await this.http.doJSON<Record<string, unknown>>(
      "GET",
      `${API_BASE_PATH}/agent-sessions/${encodeURIComponent(sessionId)}`,
    );
    return agentSessionDetailFromWire(data ?? {});
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

async function waitForSandboxState(
  getSandbox: (name: string) => Promise<RemoteSandbox>,
  name: string,
  readyStates: readonly string[],
  failMsg: string,
): Promise<RemoteSandbox> {
  // Match Go: no client-side timeout, just poll until terminal state.
  for (;;) {
    const sb = await getSandbox(name);
    if (sb.state === "failed") {
      throw new AmikaError(sb.errorMessage || failMsg);
    }
    if (readyStates.includes(sb.state)) return sb;
    await sleep(WAIT_POLL_INTERVAL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
