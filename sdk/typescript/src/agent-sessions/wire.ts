import {
  type AgentSessionSendRequest,
  type AgentSessionUsage,
  type AgentSessionSendResponse,
  type AgentSessionSummary,
  type AgentSessionMessage,
  type AgentSessionDetail,
  type ListAgentSessionsResponse,
} from "./types.js";
import {
  optionalNum,
  str,
  bool,
  optionalObject,
  nullableStr,
  optionalBool,
  mapArray,
  num,
} from "../internal/wire.js";

export function agentSessionSendRequestToWire(
  r: AgentSessionSendRequest,
): Record<string, unknown> {
  const out: Record<string, unknown> = { message: r.message };
  // `||`, not `??`, matching the other two sites that accept both spellings: an
  // empty rig spelling falls through to the legacy one rather than shadowing it.
  // Preserves 0.11 for every input, which sent `sandbox_id` whenever it was set.
  const rigId = r.rigId || r.sandboxId;
  if (r.agent !== undefined) out["agent"] = r.agent;
  if (r.model !== undefined) out["model"] = r.model;
  if (r.effort !== undefined) out["effort"] = r.effort;
  if (r.sessionId !== undefined) out["session_id"] = r.sessionId;
  if (rigId !== undefined) out["sandbox_id"] = rigId;
  if (r.newSession !== undefined) out["new_session"] = r.newSession;
  if (r.repoUrl !== undefined) out["repo_url"] = r.repoUrl;
  return out;
}

export function agentSessionUsageFromWire(
  w: Record<string, unknown>,
): AgentSessionUsage {
  return {
    costUsd: optionalNum(w["cost_usd"]),
    inputTokens: optionalNum(w["input_tokens"]),
    outputTokens: optionalNum(w["output_tokens"]),
    cacheReadTokens: optionalNum(w["cache_read_tokens"]),
    cacheCreationTokens: optionalNum(w["cache_creation_tokens"]),
    durationMs: optionalNum(w["duration_ms"]),
    numTurns: optionalNum(w["num_turns"]),
  };
}

export function agentSessionSendResponseFromWire(
  w: Record<string, unknown>,
): AgentSessionSendResponse {
  return {
    sessionId: str(w["session_id"]),
    sandboxId: str(w["sandbox_id"]),
    agent: str(w["agent"]),
    response: str(w["response"]),
    isError: bool(w["is_error"]),
    isNewSession: bool(w["is_new_session"]),
    createdSandbox: bool(w["created_sandbox"]),
    // optionalObject rather than a bare typeof check: an array is also
    // `typeof "object"`, and would decode to an all-undefined usage object.
    usage: optionalObject(w["usage"], agentSessionUsageFromWire),
  };
}

export function agentSessionSummaryFromWire(
  w: Record<string, unknown>,
): AgentSessionSummary {
  return {
    sessionId: str(w["session_id"]),
    sandboxId: str(w["sandbox_id"]),
    sandboxName: nullableStr(w["sandbox_name"]),
    agent: str(w["agent"]),
    status: str(w["status"]),
    preview: nullableStr(w["preview"]),
    model: nullableStr(w["model"]),
    effort: nullableStr(w["effort"]),
    startedAt: str(w["started_at"]),
    endedAt: nullableStr(w["ended_at"]),
    createdAt: str(w["created_at"]),
    updatedAt: str(w["updated_at"]),
  };
}

export function agentSessionMessageFromWire(
  w: Record<string, unknown>,
): AgentSessionMessage {
  return {
    role: str(w["role"]),
    content: str(w["content"]),
    timestamp: str(w["timestamp"]),
    isError: optionalBool(w["is_error"]),
  };
}

export function agentSessionDetailFromWire(
  w: Record<string, unknown>,
): AgentSessionDetail {
  return {
    ...agentSessionSummaryFromWire(w),
    messages: mapArray(w["messages"], agentSessionMessageFromWire),
  };
}

export function listAgentSessionsResponseFromWire(
  w: Record<string, unknown>,
): ListAgentSessionsResponse {
  return {
    sessions: mapArray(w["sessions"], agentSessionSummaryFromWire),
    total: num(w["total"]),
  };
}
