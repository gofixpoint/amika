import {
  type Session,
  type CreateSessionRequest,
  type UpdateSessionRequest,
} from "./types.js";
import {
  str,
  nullableStr,
  optionalStr,
  omitUndefined,
} from "../internal/wire.js";

export function sessionFromWire(w: Record<string, unknown>): Session {
  return {
    id: str(w["id"]),
    sandboxId: str(w["sandbox_id"]),
    orgId: str(w["org_id"]),
    agentName: str(w["agent_name"]),
    status: str(w["status"]),
    startedAt: str(w["started_at"]),
    endedAt: nullableStr(w["ended_at"]),
    metadata: (w["metadata"] ?? {}) as Record<string, unknown>,
    preview: optionalStr(w["preview"]),
    createdAt: str(w["created_at"]),
    updatedAt: str(w["updated_at"]),
  };
}

export function createSessionRequestToWire(
  r: CreateSessionRequest,
): Record<string, unknown> {
  return omitUndefined({
    agent_name: r.agentName,
    metadata: r.metadata,
  });
}

export function updateSessionRequestToWire(
  r: UpdateSessionRequest,
): Record<string, unknown> {
  return omitUndefined({
    status: r.status,
    metadata: r.metadata,
  });
}
