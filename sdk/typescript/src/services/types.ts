import { type LegacyShape } from "../internal/types.js";

/**
 * One service on a rig, as returned by the /rig-services endpoints.
 * It unifies rows from the `sandbox_services` table with legacy jsonb entries:
 * `source` discriminates ("table" or "legacy") and `kind` is "system" or
 * "user". A legacy or not-yet-provisioned service has a null `url`/`urlScheme`.
 *
 * Contains more detail than the abbreviated service metadata in `rig.services`.
 */
export interface RigServiceResource {
  /** Resource identifier assigned by the server. */
  id: string | null;
  /** Canonical spelling; mirrors {@link RigServiceResource.sandboxId}. */
  rigId: string;
  /** Rig ID using the existing API-compatible field name. */
  sandboxId: string;
  /** Resource name. */
  name: string;
  /** Container port to expose. Must be an integer from 1 to 65535, excluding 60899 through 60999. */
  port: number;
  /** URL scheme for the exposed HTTP service. */
  urlScheme: string | null;
  /** Transport protocol reported by the server. */
  protocol: string;
  /** Published service URL; null where no URL is available. */
  url: string | null;
  /** Port exposed by the host or provider. */
  hostPort: number | null;
  /** Service-record origin, commonly table or legacy. */
  source: string;
  /** Service category, commonly system or user. */
  kind: string;
  /** Creation timestamp returned by the server. */
  createdAt: string | null;
  /** Last-update timestamp returned by the server. */
  updatedAt: string | null;
}

/** @deprecated Use {@link RigServiceResource}. */
export type SandboxServiceResource = LegacyShape<RigServiceResource, "rigId">;

/** Request body for creating (POST) or replacing (PUT) a rig service. */
export interface RigServiceRequest {
  /** Resource name. */
  name: string;
  /** Container port from 1 to 65535, excluding the reserved range 60899 through 60999. Validated before sending. */
  port: number;
  /** URL scheme for the exposed HTTP service. */
  urlScheme: "http" | "https";
}

/** @deprecated Use {@link RigServiceRequest}. */
export type SandboxServiceRequest = RigServiceRequest;

/** Filters for listing published services. */
export interface ListServicesOptions {
  /** Rig name or ID; omit to list every service in the organization. */
  rigRef?: string;
}
/** How a service reference is resolved within a rig. */
export type ServiceLookup = "name" | "id" | "ref";

/** Services operations available on AmikaClient. */
export interface Services {
  /** List services across your organization, optionally limited to one rig by name or ID. */
  list(options?: ListServicesOptions): Promise<RigServiceResource[]>;

  /** Expose a port on the rig named by rigRef. Rejects invalid or reserved ports before making a request. */
  create(rigRef: string, req: RigServiceRequest): Promise<RigServiceResource>;

  /** Fully replace a service configuration. by defaults to name; use id or ref for other lookups. Validates the port before sending. */
  replace(
    rigRef: string,
    serviceRef: string,
    req: RigServiceRequest,
    by?: ServiceLookup,
  ): Promise<RigServiceResource>;

  /** Delete the service identified by its name within the rig named by rigRef. */
  delete(rigRef: string, serviceRef: string): Promise<void>;
}
