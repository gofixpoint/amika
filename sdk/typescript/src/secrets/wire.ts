import { type Secret } from "./types.js";
import { str, nullableStr } from "../internal/wire.js";

export function secretFromWire(w: Record<string, unknown>): Secret {
  return {
    id: str(w["id"]),
    orgId: str(w["org_id"]),
    userId: str(w["user_id"]),
    name: str(w["name"]),
    description: nullableStr(w["description"]),
    scope: str(w["scope"]),
    createdAt: str(w["created_at"]),
    updatedAt: str(w["updated_at"]),
  };
}
