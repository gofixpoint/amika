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
import { idRef, pickRef, refFieldName } from "../internal/resource-ref.js";

export function agentSessionSendRequestToWire(
  r: AgentSessionSendRequest,
): Record<string, unknown> {
  const out: Record<string, unknown> = { message: r.message };
  // The first non-empty of rig, rigId, sandboxId wins, so an empty canonical
  // spelling falls through to a legacy one rather than shadowing it. The
  // deprecated rigId/sandboxId are IDs: the server's sandbox_id field matches
  // by ID only.
  const rig = pickRef("rig", r.rig, idRef(r.rigId), idRef(r.sandboxId));
  if (r.agent !== undefined) out["agent"] = r.agent;
  if (r.model !== undefined) out["model"] = r.model;
  if (r.effort !== undefined) out["effort"] = r.effort;
  if (r.sessionId !== undefined) out["session_id"] = r.sessionId;
  // At most one of sandbox_id / sandbox_name / sandbox_ref.
  if (rig) out[refFieldName("sandbox", rig)] = rig.value;
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
