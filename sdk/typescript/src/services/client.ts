import { type HTTPClient } from "../internal/http.js";
import {
  type Services,
  type ListServicesOptions,
  type RigServiceResource,
  type RigServiceRequest,
  type ServiceLookup,
} from "./types.js";
import { API_BASE_PATH } from "../internal/constants.js";
import { mapArray } from "../internal/wire.js";
import { rigServiceResourceFromWire, rigServiceRequestToWire } from "./wire.js";

export function createServices(http: HTTPClient): Services {
  return new ServicesClient(http);
}

class ServicesClient implements Services {
  constructor(private readonly http: HTTPClient) {}
  async list(options?: ListServicesOptions): Promise<RigServiceResource[]> {
    const rigRef = options?.rigRef;
    const params = new URLSearchParams();
    // The query key is the server's, which still spells it `sandbox_ref`.
    if (rigRef) params.set("sandbox_ref", rigRef);
    const qs = params.toString();
    const envelope = await this.http.doJSON<{ items?: unknown[] }>(
      "GET",
      `${API_BASE_PATH}/rig-services${qs ? `?${qs}` : ""}`,
    );
    return mapArray(envelope?.items, rigServiceResourceFromWire);
  }

  async create(
    rigRef: string,
    req: RigServiceRequest,
  ): Promise<RigServiceResource> {
    const data = await this.http.doJSON<Record<string, unknown>>(
      "POST",
      `${API_BASE_PATH}/rigs/${encodeURIComponent(rigRef)}/services`,
      rigServiceRequestToWire(req),
    );
    return rigServiceResourceFromWire(data ?? {});
  }

  async replace(
    rigRef: string,
    serviceRef: string,
    req: RigServiceRequest,
    by: ServiceLookup = "name",
  ): Promise<RigServiceResource> {
    const params = new URLSearchParams({ by });
    const data = await this.http.doJSON<Record<string, unknown>>(
      "PUT",
      `${API_BASE_PATH}/rigs/${encodeURIComponent(rigRef)}/services/${encodeURIComponent(serviceRef)}?${params.toString()}`,
      rigServiceRequestToWire(req),
    );
    return rigServiceResourceFromWire(data ?? {});
  }

  async delete(rigRef: string, serviceRef: string): Promise<void> {
    await this.http.doJSON(
      "DELETE",
      `${API_BASE_PATH}/rigs/${encodeURIComponent(rigRef)}/services/${encodeURIComponent(serviceRef)}?by=name`,
    );
  }
}
