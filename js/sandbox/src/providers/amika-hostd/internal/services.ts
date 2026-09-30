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
import { machinePath, type SmolClient } from "../../smol/provider";

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
 * The name hostd routes each service by, in input order. A service is
 * routed by its own name, except that a service declaring several ports
 * keeps its name for the lowest one and gets `<name>-<port>` for the rest,
 * since hostd needs one name per port. Throws for a name no URL can carry
 * (`.` and `..` are dot segments, even percent-encoded) and for two routes
 * that would share a name, e.g. `web` on 3001 and a service `web-3001`.
 */
export function hostdServiceRoutes(
  services: SandboxService[],
): { name: string; port: number }[] {
  const dotted = services.find((s) => s.name === "." || s.name === "..");
  if (dotted) {
    throw new Error(
      `amika-hostd cannot route a service named ${JSON.stringify(dotted.name)}`,
    );
  }
  const lowest = new Map<string, number>();
  for (const { name, containerPort } of services) {
    lowest.set(
      name,
      Math.min(lowest.get(name) ?? containerPort, containerPort),
    );
  }
  const routes = services.map(({ name, containerPort }) => ({
    name:
      lowest.get(name) === containerPort ? name : `${name}-${containerPort}`,
    port: containerPort,
  }));
  const ports = new Map<string, number>();
  for (const { name, port } of routes) {
    if ((ports.get(name) ?? port) !== port) {
      throw new Error(
        `amika-hostd would route two services as ${JSON.stringify(name)}; rename one`,
      );
    }
    ports.set(name, port);
  }
  return routes;
}
