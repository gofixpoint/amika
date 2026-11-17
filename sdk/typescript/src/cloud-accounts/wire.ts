import {
  type CloudAccount,
  type CreateCloudAccountRequest,
  type UpdateCloudAccountRequest,
} from "./types.js";
import { bool, omitUndefined, str } from "../internal/wire.js";

export function createCloudAccountRequestToWire(
  r: CreateCloudAccountRequest,
): Record<string, unknown> {
  return omitUndefined({
    provider: r.provider,
    name: r.name,
    api_key: r.apiKey,
    is_default: r.isDefault,
  });
}

export function updateCloudAccountRequestToWire(
  r: UpdateCloudAccountRequest,
): Record<string, unknown> {
  return omitUndefined({
    name: r.name,
    api_key: r.apiKey,
    is_default: r.isDefault,
  });
}

export function cloudAccountFromWire(w: Record<string, unknown>): CloudAccount {
  return {
    id: str(w["id"]),
    provider: str(w["provider"]),
    name: str(w["name"]),
    isDefault: bool(w["is_default"]),
    createdAt: str(w["created_at"]),
    updatedAt: str(w["updated_at"]),
  };
}
