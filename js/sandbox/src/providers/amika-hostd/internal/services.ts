/**
 * Service URLs for amika-hostd machines.
 *
 * hostd publishes each service's guest port when it creates the machine and
 * routes `/rigs/<machine>/services/<name>/...` to it, forwarding HTTP and
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
import {
  machinePath,
  machineSchema,
  type SmolClient,
} from "../../smol/provider";

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
          url: `${origin}/rigs/${id}/services/${encodeURIComponent(routes[i].name)}/`,
        })),
      };
    },
    /**
     * smolvm publishes ports only when a machine is created, so there are no
     * routes to add or remove later. A route to a port that was not published
     * could never work, so reconciling to one fails rather than recording a
     * dead URL.
     */
    syncRoutes: async (id: string, desired: SandboxService[]) => {
      // As at create: hostd routes HTTP and TCP upgrades, never UDP.
      if (desired.some((service) => service.protocol !== "tcp")) {
        throw new SandboxProviderUnsupportedError("amika-hostd", "services");
      }
      const { ports = [] } = await client.json(machinePath(id), machineSchema);
      const published = new Set(ports.map((port) => port.guest));
      const missing = desired
        .map((service) => service.containerPort)
        .filter((port) => !published.has(port));
      if (missing.length) {
        throw new Error(
          `amika-hostd publishes service ports only at create; machine ${id} does not publish ${[...new Set(missing)].join(", ")}`,
        );
      }
    },
  };
}

/**
 * The name hostd routes each service by, in input order. A service is
 * routed by its own name, except that a service declaring several ports
 * keeps its name for the lowest one and gets `<name>-<port>` for the rest,
 * since hostd needs one name per port.
 */
export function hostdServiceRoutes(
  services: SandboxService[],
): { name: string; port: number }[] {
  const lowest = new Map<string, number>();
  for (const { name, containerPort } of services) {
    lowest.set(
      name,
      Math.min(lowest.get(name) ?? containerPort, containerPort),
    );
  }
  return services.map(({ name, containerPort }) => ({
    name:
      lowest.get(name) === containerPort ? name : `${name}-${containerPort}`,
    port: containerPort,
  }));
}
