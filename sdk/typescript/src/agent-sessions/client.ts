import { type HTTPClient } from "../internal/http.js";
import {
  type AgentSessions,
  type AgentSessionSendRequest,
  type AgentSessionSendResponse,
  type AgentSessionStreamHandlers,
  type ListAgentSessionsOptions,
  type ListAgentSessionsResponse,
  type AgentSession,
} from "./types.js";
import { API_BASE_PATH, AGENT_SEND_TIMEOUT_MS } from "../internal/constants.js";
import {
  agentSessionSendRequestToWire,
  agentSessionSendResponseFromWire,
  listAgentSessionsResponseFromWire,
  agentSessionDetailFromWire,
} from "./wire.js";
import { readAgentSessionStream } from "./stream.js";
import {
  nonBlank,
  pickRef,
  queryString,
  setRefSelector,
} from "../internal/resource-ref.js";
import { createAgentSessionResource } from "./resource.js";

export function createAgentSessions(http: HTTPClient): AgentSessions {
  return new AgentSessionsClient(http);
}

class AgentSessionsClient implements AgentSessions {
  constructor(private readonly http: HTTPClient) {}
  async send(req: AgentSessionSendRequest): Promise<AgentSessionSendResponse> {
    const data = await this.http.doJSON<Record<string, unknown>>(
      "POST",
      `${API_BASE_PATH}/agent-sessions`,
      agentSessionSendRequestToWire(req),
      { timeoutMs: AGENT_SEND_TIMEOUT_MS },
    );
    return agentSessionSendResponseFromWire(data ?? {});
  }

  async sendStream(
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

  async list(
    options?: ListAgentSessionsOptions,
  ): Promise<ListAgentSessionsResponse> {
    const params = new URLSearchParams();
    const limit = options?.limit;
    if (limit && limit > 0) params.set("limit", String(limit));
    // A referenced rig in the query: its value in `sandbox` plus the
    // namespaced `sandbox_by` selector, which the server defaults to ref.
    // An empty deprecated rigRef keeps its old meaning in a filter: none.
    const rig = pickRef("rig", options?.rig, nonBlank(options?.rigRef));
    if (rig) {
      params.set("sandbox", rig.value);
      setRefSelector(params, "sandbox_by", rig);
    }
    const qs = queryString(params);
    const data = await this.http.doJSON<Record<string, unknown>>(
      "GET",
      `${API_BASE_PATH}/agent-sessions${qs}`,
    );
    return listAgentSessionsResponseFromWire(data ?? {});
  }

  async get(sessionId: string): Promise<AgentSession> {
    const data = await this.http.doJSON<Record<string, unknown>>(
      "GET",
      `${API_BASE_PATH}/agent-sessions/${encodeURIComponent(sessionId)}`,
    );
    return createAgentSessionResource(
      agentSessionDetailFromWire(data ?? {}),
      this,
    );
  }
}
