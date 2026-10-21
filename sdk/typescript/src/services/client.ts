import { type HTTPClient } from "../internal/http.js";
import {
  type Services,
  type ListServicesOptions,
  type RigServiceResource,
  type RigServiceRequest,
  type ServiceLookup,
} from "./types.js";
import { API_BASE_PATH } from "../internal/constants.js";
import {
  normalizeRef,
  pickRef,
  queryString,
  refFieldName,
  nonBlank,
  pathSegment,
  refPathSegment,
  setRefSelector,
} from "../internal/resource-ref.js";
import { mapArray } from "../internal/wire.js";
import { type RigRef } from "../resource-ref.js";
import { rigServiceResourceFromWire, rigServiceRequestToWire } from "./wire.js";

export function createServices(http: HTTPClient): Services {
  return new ServicesClient(http);
}

/**
 * `/rigs/{rig}/services[/{service}]` plus its query. The rig is the parent
 * here, so its selector is the namespaced `sandbox_by` (server default `ref`,
 * so a plain string sends none); `by` belongs to the service.
 */
function servicePath(
  rig: RigRef,
  service?: { ref: string; by: ServiceLookup },
): string {
  const ref = normalizeRef(rig, "rig");
  const params = new URLSearchParams();
  if (service) params.set("by", service.by);
  setRefSelector(params, "sandbox_by", ref);
  const tail = service ? `/${pathSegment(service.ref, "service")}` : "";
  return `${API_BASE_PATH}/rigs/${refPathSegment(ref)}/services${tail}${queryString(params)}`;
}

class ServicesClient implements Services {
  constructor(private readonly http: HTTPClient) {}
  async list(options?: ListServicesOptions): Promise<RigServiceResource[]> {
    // An empty deprecated rigRef keeps its old meaning in a filter: none.
    const rig = pickRef("rig", options?.rig, nonBlank(options?.rigRef));
    const params = new URLSearchParams();
    // The org-wide list filters with the server's mutually exclusive
    // sandbox_id / sandbox_name / sandbox_ref query fields.
    if (rig) params.set(refFieldName("sandbox", rig), rig.value);
    const envelope = await this.http.doJSON<{ items?: unknown[] }>(
      "GET",
      `${API_BASE_PATH}/rig-services${queryString(params)}`,
    );
    return mapArray(envelope?.items, rigServiceResourceFromWire);
  }

  async create(
    rig: RigRef,
    req: RigServiceRequest,
  ): Promise<RigServiceResource> {
    const path = servicePath(rig);
    const data = await this.http.doJSON<Record<string, unknown>>(
      "POST",
      path,
      rigServiceRequestToWire(req),
    );
    return rigServiceResourceFromWire(data ?? {});
  }

  async replace(
    rig: RigRef,
    serviceRef: string,
    req: RigServiceRequest,
    by: ServiceLookup = "name",
  ): Promise<RigServiceResource> {
    const path = servicePath(rig, { ref: serviceRef, by });
    const data = await this.http.doJSON<Record<string, unknown>>(
      "PUT",
      path,
      rigServiceRequestToWire(req),
    );
    return rigServiceResourceFromWire(data ?? {});
  }

  async delete(rig: RigRef, serviceRef: string): Promise<void> {
    await this.http.doJSON(
      "DELETE",
      servicePath(rig, { ref: serviceRef, by: "name" }),
    );
  }
}
