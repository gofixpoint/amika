import { type LegacyShape } from "../internal/types.js";
import type { RigRef } from "../resource-ref.js";

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
  /**
   * Only this rig's services. A plain string matches the rig's ID or name;
   * `{ ref, by: "id" | "name" }` pins one. Omit to list every service in the
   * organization. An unknown rig throws AmikaHTTPError (404).
   */
  rig?: RigRef;
  /**
   * @deprecated Use {@link ListServicesOptions.rig}; a string there behaves
   * the same (ID or name). A non-empty `rig` takes precedence.
   */
  rigRef?: string;
}
/** How a service reference is resolved within a rig. */
export type ServiceLookup = "name" | "id" | "ref";

/** Services operations available on AmikaClient. */
export interface Services {
  /** List services across your organization, optionally limited to one rig. */
  list(options?: ListServicesOptions): Promise<RigServiceResource[]>;

  /**
   * Expose a port on a rig. A plain string `rig` matches its ID or name;
   * `{ ref, by }` pins one. Rejects invalid or reserved ports before making a
   * request.
   */
  create(rig: RigRef, req: RigServiceRequest): Promise<RigServiceResource>;

  /**
   * Fully replace a service configuration on a rig (see {@link RigRef}). `by`
   * selects how serviceRef is matched within the rig: it defaults to name; use
   * id or ref for other lookups. Validates the port before sending.
   */
  replace(
    rig: RigRef,
    serviceRef: string,
    req: RigServiceRequest,
    by?: ServiceLookup,
  ): Promise<RigServiceResource>;

  /** Delete the service with this name on a rig (see {@link RigRef}). */
  delete(rig: RigRef, serviceRef: string): Promise<void>;
}
