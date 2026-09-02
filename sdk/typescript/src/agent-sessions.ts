// Types and stream handling for the `/agent-sessions` endpoints — the chat
// surface behind `amika send` and `amika sessions list|show`. Mirrors the Go
// types in go/internal/apiclient/client.go; see src/types.ts for the
// nullability convention.

import { AmikaError } from "@/errors";
import { readSSEFrames } from "@/sse";
import {
  bool,
  mapArray,
  nullableStr,
  num,
  optionalBool,
  optionalNum,
  optionalObject,
  optionalStr,
  str,
} from "@/types";

/**
 * Request body for POST /api/v0beta1/agent-sessions. Only `message` is
 * required: `sessionId` continues an existing chat, `sandboxId` routes into a
 * specific sandbox, and `repoUrl` is used only when a sandbox has to be
 * created behind the scenes.
 */
export interface AgentSessionSendRequest {
  message: string;
  agent?: string;
  sessionId?: string;
  sandboxId?: string;
  newSession?: boolean;
  repoUrl?: string;
}

export function agentSessionSendRequestToWire(
  r: AgentSessionSendRequest,
): Record<string, unknown> {
  const out: Record<string, unknown> = { message: r.message };
  if (r.agent !== undefined) out["agent"] = r.agent;
  if (r.sessionId !== undefined) out["session_id"] = r.sessionId;
  if (r.sandboxId !== undefined) out["sandbox_id"] = r.sandboxId;
  if (r.newSession !== undefined) out["new_session"] = r.newSession;
  if (r.repoUrl !== undefined) out["repo_url"] = r.repoUrl;
  return out;
}

/**
 * Token and cost accounting for one turn. Every field is optional — Claude
 * reports the full set, Codex currently reports none.
 */
export interface AgentSessionUsage {
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  durationMs?: number;
  numTurns?: number;
}

function agentSessionUsageFromWire(
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

/**
 * Response of POST /api/v0beta1/agent-sessions. `sessionId` is the durable
 * chat id to pass back as `sessionId` to continue the chat.
 */
export interface AgentSessionSendResponse {
  sessionId: string;
  sandboxId: string;
  agent: string;
  response: string;
  isError: boolean;
  isNewSession: boolean;
  createdSandbox: boolean;
  usage?: AgentSessionUsage;
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

/**
 * One row of the agent-sessions list. `sandboxName`, `preview`, `model`,
 * `effort`, and `endedAt` are nullable: a chat can outlive the sandbox whose
 * name it shows, carry no user message to preview, run at the agent CLI's own
 * model and effort, and still be running.
 */
export interface AgentSessionSummary {
  sessionId: string;
  sandboxId: string;
  sandboxName: string | null;
  agent: string;
  status: string;
  preview: string | null;
  model: string | null;
  effort: string | null;
  startedAt: string;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
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

/**
 * One turn in a chat transcript. `isError` marks an assistant turn the agent
 * reported as failed; it is absent on user turns and on transcripts that
 * predate per-turn error tracking.
 */
export interface AgentSessionMessage {
  role: string;
  content: string;
  timestamp: string;
  isError?: boolean;
}

function agentSessionMessageFromWire(
  w: Record<string, unknown>,
): AgentSessionMessage {
  return {
    role: str(w["role"]),
    content: str(w["content"]),
    timestamp: str(w["timestamp"]),
    isError: optionalBool(w["is_error"]),
  };
}

/** An {@link AgentSessionSummary} plus the chat's full transcript. */
export interface AgentSessionDetail extends AgentSessionSummary {
  messages: AgentSessionMessage[];
}

export function agentSessionDetailFromWire(
  w: Record<string, unknown>,
): AgentSessionDetail {
  return {
    ...agentSessionSummaryFromWire(w),
    messages: mapArray(w["messages"], agentSessionMessageFromWire),
  };
}

/**
 * One page of chats plus the total matching the query. `total` exceeds
 * `sessions.length` when the page cuts the list short; report that rather than
 * presenting a truncated list as the whole of it.
 */
export interface ListAgentSessionsResponse {
  sessions: AgentSessionSummary[];
  total: number;
}

export function listAgentSessionsResponseFromWire(
  w: Record<string, unknown>,
): ListAgentSessionsResponse {
  return {
    sessions: mapArray(w["sessions"], agentSessionSummaryFromWire),
    total: num(w["total"]),
  };
}

/**
 * Progress callbacks for {@link AmikaClient.sendAgentSessionStream}. Both are
 * optional. `onStatus` reports lifecycle milestones (`creating_sandbox` /
 * `sandbox_ready`, the latter carrying the sandbox id); `onDelta` receives
 * agent reply text as it is produced.
 *
 * A handler may return a promise, and the reader awaits it before reading the
 * next frame. Deltas therefore reach an async handler in order, and one that
 * throws or rejects fails the send instead of becoming an unhandled rejection.
 * A slow handler backpressures the stream, which is the right trade for output
 * that must not interleave.
 *
 * The return type is `unknown` rather than `void | Promise<void>` so that a
 * concise arrow body still type-checks: `(text) => process.stdout.write(text)`
 * returns a boolean, and a union return type would reject it.
 */
export interface AgentSessionStreamHandlers {
  onStatus?: (phase: string, sandboxId: string) => unknown;
  onDelta?: (text: string) => unknown;
}

/**
 * Consume the send SSE stream, dispatching `status`/`delta` frames to the
 * handlers and returning the terminal `done` result.
 *
 * A completed turn wins over an `error` frame: `done` carries the persisted
 * result, so if both somehow arrive the send succeeded and reporting the error
 * would discard a real session id.
 */
export async function readAgentSessionStream(
  body: ReadableStream<Uint8Array>,
  handlers: AgentSessionStreamHandlers,
): Promise<AgentSessionSendResponse> {
  let streamError = "";

  stream: for await (const frame of readSSEFrames(body)) {
    switch (frame.event) {
      case "status": {
        if (!handlers.onStatus) break;
        // Cosmetic progress only, so an unparseable frame is ignored.
        const parsed = tryParse(frame.data);
        if (parsed) {
          await handlers.onStatus(
            str(parsed["phase"]),
            str(parsed["sandbox_id"]),
          );
        }
        break;
      }
      case "delta": {
        // A delta carries reply text, so an unparseable one is lost output.
        // Fail loudly rather than silently returning a truncated reply.
        const parsed = tryParse(frame.data);
        if (!parsed) {
          // Truncated trailing frame: the connection was cut mid-delta, which
          // is a lost stream, not corrupt output. Stop and report it as such.
          if (!frame.terminated) break stream;
          throw new AmikaError(
            "remote agent-session send: parsing delta frame failed",
          );
        }
        const text = str(parsed["text"]);
        if (text !== "" && handlers.onDelta) await handlers.onDelta(text);
        break;
      }
      case "done": {
        const parsed = tryParse(frame.data);
        if (!parsed) {
          if (!frame.terminated) break stream;
          throw new AmikaError(
            "remote agent-session send: parsing done frame failed",
          );
        }
        // `done` is terminal: stop reading so a later frame cannot discard a
        // completed turn's result.
        return agentSessionSendResponseFromWire(parsed);
      }
      case "error": {
        const parsed = tryParse(frame.data);
        // Same reasoning as delta/done: a cut mid-frame is a lost stream, not
        // a new error. Without this, a truncated error frame overwrites an
        // earlier real message with the generic fallback.
        if (!parsed && !frame.terminated) break stream;
        streamError = optionalStr(parsed?.["error"]) || "stream error";
        break;
      }
    }
  }

  if (streamError !== "") {
    throw new AmikaError(`remote agent-session send: ${streamError}`);
  }
  // No terminal frame. The likeliest cause is the server's own request ceiling
  // (300s) cutting the stream mid-turn, but a clean close with a malformed
  // final frame lands here too and the two are indistinguishable from here, so
  // name both. Either way the turn may have completed and persisted, so point
  // at the session list rather than implying the work was lost.
  throw new AmikaError(
    "remote agent-session send: stream ended without a result " +
      "(the server may have hit its request time limit, or the final frame " +
      "was truncated or malformed; check listAgentSessions() for the session)",
  );
}

function tryParse(data: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
