/**
 * Service URLs for amika-hostd machines.
 *
 * hostd publishes each service's guest port when it creates the machine and
 * routes `/v0beta1/rigs/<machine>/services/<name>/...` to it, forwarding HTTP and
 * WebSocket upgrades (see `js/amika-hostd/src/internal/services.ts`). Those
 * routes are reached only by the control plane, which presents the host's
 * secret key in `X-Amika-Hostd-Key` (`HOSTD_SERVICE_KEY_HEADER`), so a URL is
 * no credential by itself and never expires.
 */
import {
  SandboxProviderUnsupportedError,
  type RefreshUrlsResult,
} from "../../provider";
import type { SandboxService } from "../../../types";
import { machinePath, type SmolClient } from "../../smol/provider";

/**
 * The versioned hostd API this provider speaks. hostd lists the versions it
 * serves in `GET /health` (`apis`); its unversioned Smol-compatible
 * `/api/v1/machines` remains only for control planes on older providers.
 */
export const HOSTD_API_VERSION = "v0beta1";
export const HOSTD_RIGS_PATH = `/${HOSTD_API_VERSION}/rigs`;

/** The header carrying the host's secret key on service routes. */
export const HOSTD_SERVICE_KEY_HEADER = "X-Amika-Hostd-Key";

/**
 * Service URLs do not expire; a long TTL keeps the control plane from
 * refreshing them for nothing.
 */
export const HOSTD_SERVICE_URL_TTL_S = 365 * 24 * 60 * 60;

export function hostdServices(apiUrl: string, client: SmolClient) {
  const origin = apiUrl.replace(/\/$/, "");
  return {
    refreshUrls: async (
      id: string,
      services: SandboxService[],
    ): Promise<RefreshUrlsResult> => {
      machinePath(id);
      const routes = hostdServiceRoutes(services);
      return {
        services: services.map((service, i) => ({
          ...service,
          url: `${origin}${HOSTD_RIGS_PATH}/${id}/services/${encodeURIComponent(routes[i].name)}/`,
        })),
      };
    },
    /**
     * Replace hostd's name-to-port map with `desired`, so services added,
     * renamed or removed after create route (or stop routing) by name.
     * smolvm publishes ports only at create, so hostd refuses a port it did
     * not publish rather than record a dead URL.
     */
    syncRoutes: async (id: string, desired: SandboxService[]) => {
      // As at create: hostd routes HTTP and TCP upgrades, never UDP.
      if (desired.some((service) => service.protocol !== "tcp")) {
        throw new SandboxProviderUnsupportedError("amika-hostd", "services");
      }
      const routes = hostdServiceRoutes(desired);
      await client.discard(`${machinePath(id)}/services`, "PUT", {
        services: [...new Map(routes.map((r) => [r.name, r])).values()],
      });
    },
  };
}

/**
 * The name hostd routes each service by, in input order: the service's own
 * name, so a route never changes when other services do. hostd routes one
 * port per name, so a service declaring several ports is refused, as is a
 * name no URL can carry (`.` and `..` are dot segments, even
 * percent-encoded).
 */
export function hostdServiceRoutes(
  services: SandboxService[],
): { name: string; port: number }[] {
  const ports = new Map<string, number>();
  for (const { name, containerPort } of services) {
    if (name === "." || name === "..") {
      throw new Error(
        `amika-hostd cannot route a service named ${JSON.stringify(name)}`,
      );
    }
    const port = ports.get(name);
    if (port !== undefined && port !== containerPort) {
      throw new Error(
        `amika-hostd routes one port per service name; ${JSON.stringify(name)} declares ${port} and ${containerPort}`,
      );
    }
    ports.set(name, containerPort);
  }
  return services.map(({ name, containerPort }) => ({
    name,
    port: containerPort,
  }));
}
