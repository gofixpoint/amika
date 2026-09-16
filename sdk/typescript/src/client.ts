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
  type CreateRigRequest,
  type CreateRigSnapshotRequest,
  createRigRequestToWire,
  createRigSnapshotRequestToWire,
  type CreateSecretRequest,
  type CreateSessionRequest,
  createSessionRequestToWire,
  mapArray,
  type ProviderSecretListItem,
  type ProviderSecretSummary,
  type RemoteRepository,
  remoteRepositoryFromWire,
  type RemoteRig,
  remoteRigFromWire,
  type RigScrubPreview,
  rigScrubPreviewFromWire,
  type RigServiceRequest,
  type RigServiceResource,
  rigServiceRequestToWire,
  rigServiceResourceFromWire,
  type RigSnapshot,
  rigSnapshotFromWire,
  type Secret,
  secretFromWire,
  type Session,
  sessionFromWire,
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
 *
 * `rig` is the canonical product term. Every `*Rig*` method below is the real
 * implementation; the `*Sandbox*` method beside it is a deprecated alias that
 * forwards to it unchanged, so both spellings hit the same endpoint and return
 * the same object. The server mounts `/rigs`, `/rig-services`, and
 * `/rig-snapshots` alongside their `sandbox` originals, so the requests the
 * SDK issues are rig-named throughout.
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

  // ---------- Rigs ----------

  async listRigs(): Promise<RemoteRig[]> {
    const data = await this.http.doJSON<unknown[]>(
      "GET",
      `${API_BASE_PATH}/rigs`,
    );
    return mapArray(data, remoteRigFromWire);
  }

  async createRig(req: CreateRigRequest): Promise<RemoteRig> {
    const data = await this.http.doJSON<Record<string, unknown>>(
      "POST",
      `${API_BASE_PATH}/rigs`,
      createRigRequestToWire(req),
    );
    return remoteRigFromWire(data ?? {});
  }

  async getRig(name: string): Promise<RemoteRig> {
    const data = await this.http.doJSON<Record<string, unknown>>(
      "GET",
      `${API_BASE_PATH}/rigs/${encodeURIComponent(name)}`,
    );
    return remoteRigFromWire(data ?? {});
  }

  /**
   * Polls `getRig(name)` every 3 seconds until the rig reaches a ready state
   * (`active`, `running`, `started`) or `failed`. No client-side timeout —
   * matches Go's `WaitForSandbox`.
   */
  waitForRig(name: string): Promise<RemoteRig> {
    return waitForRigState(
      (n) => this.getRig(n),
      name,
      ["active", "running", "started"],
      "rig provisioning failed",
    );
  }

  async startRig(name: string): Promise<void> {
    await this.http.doJSON(
      "POST",
      `${API_BASE_PATH}/rigs/${encodeURIComponent(name)}/start`,
    );
  }

  waitForRigStart(name: string): Promise<RemoteRig> {
    return waitForRigState(
      (n) => this.getRig(n),
      name,
      ["active", "running", "started"],
      "rig start failed",
    );
  }

  async stopRig(name: string): Promise<void> {
    await this.http.doJSON(
      "POST",
      `${API_BASE_PATH}/rigs/${encodeURIComponent(name)}/stop`,
    );
  }

  waitForRigStop(name: string): Promise<RemoteRig> {
    return waitForRigState(
      (n) => this.getRig(n),
      name,
      ["stopped"],
      "rig stop failed",
    );
  }

  async deleteRig(name: string): Promise<void> {
    await this.http.doJSON(
      "DELETE",
      `${API_BASE_PATH}/rigs/${encodeURIComponent(name)}`,
    );
  }

  /** @deprecated Use {@link AmikaClient.listRigs}. */
  listSandboxes(): Promise<RemoteRig[]> {
    return this.listRigs();
  }

  /** @deprecated Use {@link AmikaClient.createRig}. */
  createSandbox(req: CreateRigRequest): Promise<RemoteRig> {
    return this.createRig(req);
  }

  /** @deprecated Use {@link AmikaClient.getRig}. */
  getSandbox(name: string): Promise<RemoteRig> {
    return this.getRig(name);
  }

  /** @deprecated Use {@link AmikaClient.waitForRig}. */
  waitForSandbox(name: string): Promise<RemoteRig> {
    return this.waitForRig(name);
  }

  /** @deprecated Use {@link AmikaClient.startRig}. */
  startSandbox(name: string): Promise<void> {
    return this.startRig(name);
  }

  /** @deprecated Use {@link AmikaClient.waitForRigStart}. */
  waitForSandboxStart(name: string): Promise<RemoteRig> {
    return this.waitForRigStart(name);
  }

  /** @deprecated Use {@link AmikaClient.stopRig}. */
  stopSandbox(name: string): Promise<void> {
    return this.stopRig(name);
  }

  /** @deprecated Use {@link AmikaClient.waitForRigStop}. */
  waitForSandboxStop(name: string): Promise<RemoteRig> {
    return this.waitForRigStop(name);
  }

  /** @deprecated Use {@link AmikaClient.deleteRig}. */
  deleteSandbox(name: string): Promise<void> {
    return this.deleteRig(name);
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

  // ---------- Rig services ----------

  /**
   * List live services for the caller's org. `rigRef` is an optional
   * name-or-id filter; omit it to list every service in the org.
   */
  async listRigServices(rigRef?: string): Promise<RigServiceResource[]> {
    const params = new URLSearchParams();
    // The query key is the server's, which still spells it `sandbox_ref`.
    if (rigRef) params.set("sandbox_ref", rigRef);
    const qs = params.toString();
    const envelope = await this.http.doJSON<{ items?: unknown[] }>(
      "GET",
      `${API_BASE_PATH}/rig-services${qs ? `?${qs}` : ""}`,
    );
    return mapArray(envelope?.items, rigServiceResourceFromWire);
  }

  /**
   * Create a service on the rig referenced by name or id (the server
   * resolves id first, then name).
   */
  async createRigService(
    rigRef: string,
    req: RigServiceRequest,
  ): Promise<RigServiceResource> {
    const data = await this.http.doJSON<Record<string, unknown>>(
      "POST",
      `${API_BASE_PATH}/rigs/${encodeURIComponent(rigRef)}/services`,
      rigServiceRequestToWire(req),
    );
    return rigServiceResourceFromWire(data ?? {});
  }

  /**
   * Fully replace the service identified by `serviceRef` within a rig.
   * `by` selects how `serviceRef` is resolved and defaults to `name`.
   */
  async putRigService(
    rigRef: string,
    serviceRef: string,
    req: RigServiceRequest,
    by: "name" | "id" | "ref" = "name",
  ): Promise<RigServiceResource> {
    const params = new URLSearchParams({ by });
    const data = await this.http.doJSON<Record<string, unknown>>(
      "PUT",
      `${API_BASE_PATH}/rigs/${encodeURIComponent(rigRef)}/services/${encodeURIComponent(serviceRef)}?${params.toString()}`,
      rigServiceRequestToWire(req),
    );
    return rigServiceResourceFromWire(data ?? {});
  }

  /** Delete the service with the given name within a rig. */
  async deleteRigService(rigRef: string, serviceRef: string): Promise<void> {
    await this.http.doJSON(
      "DELETE",
      `${API_BASE_PATH}/rigs/${encodeURIComponent(rigRef)}/services/${encodeURIComponent(serviceRef)}?by=name`,
    );
  }

  /** @deprecated Use {@link AmikaClient.listRigServices}. */
  listSandboxServices(sandboxRef?: string): Promise<RigServiceResource[]> {
    return this.listRigServices(sandboxRef);
  }

  /** @deprecated Use {@link AmikaClient.createRigService}. */
  createSandboxService(
    sandboxRef: string,
    req: RigServiceRequest,
  ): Promise<RigServiceResource> {
    return this.createRigService(sandboxRef, req);
  }

  /** @deprecated Use {@link AmikaClient.putRigService}. */
  putSandboxService(
    sandboxRef: string,
    serviceRef: string,
    req: RigServiceRequest,
    by: "name" | "id" | "ref" = "name",
  ): Promise<RigServiceResource> {
    return this.putRigService(sandboxRef, serviceRef, req, by);
  }

  /** @deprecated Use {@link AmikaClient.deleteRigService}. */
  deleteSandboxService(sandboxRef: string, serviceRef: string): Promise<void> {
    return this.deleteRigService(sandboxRef, serviceRef);
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
   * Send a message to an agent inside a remote rig. The endpoint is
   * synchronous: it blocks until the agent finishes, so a longer per-request
   * timeout (10 minutes) is used in place of the default 30 seconds.
   */
  async agentSend(
    rigName: string,
    req: AgentSendRequest,
  ): Promise<AgentSendResponse> {
    try {
      const data = await this.http.doJSON<Record<string, unknown>>(
        "POST",
        `${API_BASE_PATH}/rigs/${encodeURIComponent(rigName)}/agent-send`,
        agentSendRequestToWire(req),
        { timeoutMs: AGENT_SEND_TIMEOUT_MS },
      );
      return agentSendResponseFromWire(data ?? {});
    } catch (err) {
      const authErr = extractAgentAuthError(err);
      if (authErr) {
        throw new AmikaError(
          `remote agent-send: agent failed to authenticate with its AI provider: ${authErr}\n\nthe rig agent's API credentials may have expired or been revoked; recreate the rig or update its API keys to restore access`,
        );
      }
      throw err;
    }
  }

  // ---------- Sessions ----------

  async createSession(
    rigName: string,
    req: CreateSessionRequest,
  ): Promise<Session> {
    const data = await this.http.doJSON<Record<string, unknown>>(
      "POST",
      `${API_BASE_PATH}/rigs/${encodeURIComponent(rigName)}/sessions`,
      createSessionRequestToWire(req),
    );
    return sessionFromWire(data ?? {});
  }

  async listSessions(rigName: string): Promise<Session[]> {
    const envelope = await this.http.doJSON<{
      sessions?: Record<string, unknown>[];
    }>("GET", `${API_BASE_PATH}/rigs/${encodeURIComponent(rigName)}/sessions`);
    const sessions = envelope?.sessions ?? [];
    return sessions.map((s) => sessionFromWire(s));
  }

  /** Returns null if no session exists (HTTP 404). */
  async getLatestSession(rigName: string): Promise<Session | null> {
    try {
      const data = await this.http.doJSON<Record<string, unknown>>(
        "GET",
        `${API_BASE_PATH}/rigs/${encodeURIComponent(rigName)}/sessions/latest`,
      );
      return sessionFromWire(data ?? {});
    } catch (err) {
      if (err instanceof AmikaHTTPError && err.statusCode === 404) return null;
      throw err;
    }
  }

  async getSession(rigName: string, sessionId: string): Promise<Session> {
    const data = await this.http.doJSON<Record<string, unknown>>(
      "GET",
      `${API_BASE_PATH}/rigs/${encodeURIComponent(rigName)}/sessions/${encodeURIComponent(sessionId)}`,
    );
    return sessionFromWire(data ?? {});
  }

  async updateSession(
    rigName: string,
    sessionId: string,
    req: UpdateSessionRequest,
  ): Promise<Session> {
    const data = await this.http.doJSON<Record<string, unknown>>(
      "PATCH",
      `${API_BASE_PATH}/rigs/${encodeURIComponent(rigName)}/sessions/${encodeURIComponent(sessionId)}`,
      updateSessionRequestToWire(req),
    );
    return sessionFromWire(data ?? {});
  }

  // ---------- Rig snapshots ----------

  /**
   * List rig-captured snapshots for the caller's org. Both filters are
   * optional; omit them to list every snapshot.
   */
  async listRigSnapshots(filters?: {
    repositoryId?: string;
    /** Source rig id. `sourceSandboxId` is the legacy spelling. */
    sourceRigId?: string;
    sourceSandboxId?: string;
  }): Promise<RigSnapshot[]> {
    const params = new URLSearchParams();
    if (filters?.repositoryId)
      params.set("repository_id", filters.repositoryId);
    const sourceRigId = filters?.sourceRigId ?? filters?.sourceSandboxId;
    // The query key is the server's, which still spells it `source_sandbox_id`.
    if (sourceRigId) params.set("source_sandbox_id", sourceRigId);
    const qs = params.toString();
    const path = `${API_BASE_PATH}/rig-snapshots${qs ? `?${qs}` : ""}`;
    const envelope = await this.http.doJSON<{
      items?: Record<string, unknown>[];
    }>("GET", path);
    const items = envelope?.items ?? [];
    return items.map((item) => rigSnapshotFromWire(item));
  }

  /**
   * Start capturing a snapshot from a running rig. The endpoint returns
   * 202 Accepted with the snapshot in the `capturing` state; poll
   * {@link listRigSnapshots} until it reaches `active` or `failed`.
   */
  async createRigSnapshot(req: CreateRigSnapshotRequest): Promise<RigSnapshot> {
    const data = await this.http.doJSON<Record<string, unknown>>(
      "POST",
      `${API_BASE_PATH}/rig-snapshots`,
      createRigSnapshotRequestToWire(req),
    );
    return rigSnapshotFromWire(data ?? {});
  }

  /**
   * Fetch a single snapshot by name or id (the server resolves id first, then
   * name).
   */
  async getRigSnapshot(ref: string): Promise<RigSnapshot> {
    const data = await this.http.doJSON<Record<string, unknown>>(
      "GET",
      `${API_BASE_PATH}/rig-snapshots/${encodeURIComponent(ref)}?by=ref`,
    );
    return rigSnapshotFromWire(data ?? {});
  }

  /**
   * Poll {@link getRigSnapshot} every 3 seconds until the snapshot reaches
   * a terminal state. Returns it once `active`; throws `AmikaError` if it ends
   * up `failed`. No client-side timeout — matches Go's
   * `WaitForSandboxSnapshot`.
   */
  async waitForRigSnapshot(ref: string): Promise<RigSnapshot> {
    for (;;) {
      const snapshot = await this.getRigSnapshot(ref);
      if (snapshot.state === "active") return snapshot;
      if (snapshot.state === "failed") {
        throw new AmikaError(
          snapshot.errorMessage || "rig snapshot capture failed",
        );
      }
      await sleep(WAIT_POLL_INTERVAL_MS);
    }
  }

  /**
   * Preview which injected secrets a scrub-and-delete snapshot would remove
   * from a rig (file paths + env var names only, no values). `rigRef`
   * is a name or id; the server resolves id first, then name.
   */
  async getRigScrubPreview(rigRef: string): Promise<RigScrubPreview> {
    // The query key is the server's, which still spells it `sandbox`.
    const params = new URLSearchParams({ sandbox: rigRef, by: "ref" });
    const data = await this.http.doJSON<Record<string, unknown>>(
      "GET",
      `${API_BASE_PATH}/rig-snapshots/scrub-preview?${params.toString()}`,
    );
    return rigScrubPreviewFromWire(data ?? {});
  }

  /**
   * Delete a rig snapshot referenced by name or id (the server resolves
   * id first, then name).
   */
  async deleteRigSnapshot(ref: string): Promise<void> {
    await this.http.doJSON(
      "DELETE",
      `${API_BASE_PATH}/rig-snapshots/${encodeURIComponent(ref)}?by=ref`,
    );
  }

  /** @deprecated Use {@link AmikaClient.listRigSnapshots}. */
  listSandboxSnapshots(filters?: {
    repositoryId?: string;
    sourceSandboxId?: string;
  }): Promise<RigSnapshot[]> {
    return this.listRigSnapshots(filters);
  }

  /** @deprecated Use {@link AmikaClient.createRigSnapshot}. */
  createSandboxSnapshot(req: CreateRigSnapshotRequest): Promise<RigSnapshot> {
    return this.createRigSnapshot(req);
  }

  /** @deprecated Use {@link AmikaClient.getRigSnapshot}. */
  getSandboxSnapshot(ref: string): Promise<RigSnapshot> {
    return this.getRigSnapshot(ref);
  }

  /** @deprecated Use {@link AmikaClient.waitForRigSnapshot}. */
  waitForSandboxSnapshot(ref: string): Promise<RigSnapshot> {
    return this.waitForRigSnapshot(ref);
  }

  /** @deprecated Use {@link AmikaClient.getRigScrubPreview}. */
  getSandboxScrubPreview(sandboxRef: string): Promise<RigScrubPreview> {
    return this.getRigScrubPreview(sandboxRef);
  }

  /** @deprecated Use {@link AmikaClient.deleteRigSnapshot}. */
  deleteSandboxSnapshot(ref: string): Promise<void> {
    return this.deleteRigSnapshot(ref);
  }

  // ---------- Agent sessions ----------

  /**
   * Send a message to a coding agent, creating a rig behind the scenes
   * when the chat has none, or routing to an existing rig or session. The
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

async function waitForRigState(
  getRig: (name: string) => Promise<RemoteRig>,
  name: string,
  readyStates: readonly string[],
  failMsg: string,
): Promise<RemoteRig> {
  // Match Go: no client-side timeout, just poll until terminal state.
  for (;;) {
    const rig = await getRig(name);
    if (rig.state === "failed") {
      throw new AmikaError(rig.errorMessage || failMsg);
    }
    if (readyStates.includes(rig.state)) return rig;
    await sleep(WAIT_POLL_INTERVAL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
