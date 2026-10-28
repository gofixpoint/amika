/**
 * Service URLs for amika-hostd machines.
 *
 * hostd publishes each service's guest port when it creates the machine, or
 * when a later `syncRoutes` names a port it does not publish yet, and routes
 * to it by name, forwarding HTTP and WebSocket upgrades (see
 * `js/amika-hostd/src/internal/services.ts`), on two routes:
 *
 * - `/v0beta1/rigs/<machine>/previews/<name>/...`, a preview: an address
 *   with no credential in it, which a browser opens after logging in to the
 *   host through Amika (`@amika/service-auth`). Every service but amikad
 *   gets one. It needs the host to be reached at an https origin of its own
 *   (`isBrowserLoginOrigin`); on any other host, hostd answers the preview
 *   by telling the browser to register such an address and upgrade
 *   amika-hostd.
 * - `/v0beta1/rigs/<machine>/services/<name>/...`, which needs the host's
 *   secret key in `X-Amika-Hostd-Key` (`HOSTD_SERVICE_KEY_HEADER`), or a
 *   service token for `curl` and scripts. amikad keeps this URL: the control
 *   plane derives its SSH, status and terminal dials from it and sends the
 *   key, and the CLI's keyless SSH WebSocket must be exactly
 *   `.../services/amikad/v1/ssh-sessions`.
 */
import {
  SandboxProviderUnsupportedError,
  type RefreshUrlsResult,
} from "../../provider";
import type { SandboxService } from "../../../types";
import { machinePath, type SmolClient } from "../../smol/provider";
import { previewPath } from "@amika/service-auth/credentials";

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
 * How long the control plane keeps a service's URL before deriving it again.
 * A preview URL carries no credential and never expires, so this only bounds
 * how long a URL that no longer matches the host's address (a host that
 * moved) is served.
 */
export const HOSTD_SERVICE_URL_TTL_S = 12 * 60 * 60;

/** amikad's service name and guest port, as Amika registers them. */
const AMIKAD_SERVICE = "amikad";
const AMIKAD_PORT = 60999;

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
        services: services.map((service, i) => {
          const { name } = routes[i];
          const path =
            name === AMIKAD_SERVICE
              ? `${HOSTD_RIGS_PATH}/${id}/services/${encodeURIComponent(name)}/`
              : previewPath(HOSTD_RIGS_PATH, id, name);
          return { ...service, url: `${origin}${path}` };
        }),
      };
    },
    /**
     * Replace hostd's name-to-port map with `desired`, so services added,
     * renamed or removed after create route (or stop routing) by name.
     * hostd publishes a port the rig does not publish yet first, and refuses
     * (409) when its smolvm is too old to, rather than record a dead URL.
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
 * name no URL can carry (an empty one, and `.` and `..`, which are dot
 * segments even percent-encoded). `amikad` is reserved for amikad's own
 * port: hostd never serves it a preview, so on any other port it would get
 * no URL a browser can open.
 */
export function hostdServiceRoutes(
  services: SandboxService[],
): { name: string; port: number }[] {
  const ports = new Map<string, number>();
  for (const { name, containerPort } of services) {
    if (name === "" || name === "." || name === "..") {
      throw new Error(
        `amika-hostd cannot route a service named ${JSON.stringify(name)}`,
      );
    }
    if (name === AMIKAD_SERVICE && containerPort !== AMIKAD_PORT) {
      throw new Error(
        `amika-hostd reserves the service name "${AMIKAD_SERVICE}" for port ${AMIKAD_PORT}; rename the service on port ${containerPort}`,
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
