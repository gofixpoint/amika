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
  type CreateSecretRequest,
  type CreateSessionRequest,
  createSandboxRequestToWire,
  createSessionRequestToWire,
  type ProviderSecretListItem,
  type ProviderSecretSummary,
  type RemoteSandbox,
  remoteSandboxFromWire,
  type RevokeSSHRequest,
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
