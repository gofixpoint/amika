import {
  type RigServiceResource,
  type RigServiceRequest,
  type ServiceAuth,
} from "./types.js";
import { nullableStr, str, num, nullableNum } from "../internal/wire.js";
import { validateServicePort } from "../internal/ports.js";

const SERVICE_AUTH_MODES: readonly ServiceAuth[] = [
  "organization",
  "owner",
  "public",
];

/** The server's `auth`, or `organization` where a server does not report one. */
function serviceAuth(value: unknown): ServiceAuth {
  return SERVICE_AUTH_MODES.includes(value as ServiceAuth)
    ? (value as ServiceAuth)
    : "organization";
}

export function rigServiceResourceFromWire(
  w: Record<string, unknown>,
): RigServiceResource {
  return {
    id: nullableStr(w["id"]),
    rigId: str(w["sandbox_id"]),
    sandboxId: str(w["sandbox_id"]),
    name: str(w["name"]),
    port: num(w["port"]),
    urlScheme: nullableStr(w["url_scheme"]),
    protocol: str(w["protocol"]),
    url: nullableStr(w["url"]),
    hostPort: nullableNum(w["host_port"]),
    source: str(w["source"]),
    kind: str(w["kind"]),
    auth: serviceAuth(w["auth"]),
    preserveHost: w["preserve_host"] === true,
    createdAt: nullableStr(w["created_at"]),
    updatedAt: nullableStr(w["updated_at"]),
  };
}

/**
 * Validation lives here rather than in the two client methods so that every
 * path to the wire goes through it, including any future one.
 */
export function rigServiceRequestToWire(
  r: RigServiceRequest,
): Record<string, unknown> {
  validateServicePort(r.port);
  // Each access field goes only when set, so the server's default applies
  // to a request that names neither.
  return {
    name: r.name,
    port: r.port,
    url_scheme: r.urlScheme,
    ...(r.auth === undefined ? {} : { auth: r.auth }),
    ...(r.preserveHost === undefined ? {} : { preserve_host: r.preserveHost }),
  };
}
