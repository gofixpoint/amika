/**
 * Service URLs for amika-hostd machines.
 *
 * hostd publishes each service's guest port when it creates the machine and
 * routes to it by name, forwarding HTTP and WebSocket upgrades (see
 * `js/amika-hostd/src/internal/services.ts`), on two routes:
 *
 * - `/v0beta1/rigs/<machine>/service-links/<name>/<expiry>.<signature>/...`,
 *   a signed service link (`../service-links.ts`). This is the URL every
 *   service gets, so a browser, curl or webhook can open it with no header.
 *   The control plane mints a new one once `signedUrlTtlSeconds` has
 *   passed, and each link outlives that by a day.
 * - `/v0beta1/rigs/<machine>/services/<name>/...`, which needs the host's
 *   secret key in `X-Amika-Hostd-Key` (`HOSTD_SERVICE_KEY_HEADER`). amikad
 *   keeps this URL: the control plane derives its SSH, status and terminal
 *   dials from it and sends the key, and the CLI's keyless SSH WebSocket
 *   must be exactly `.../services/amikad/v1/ssh-sessions`.
 */
import {
  SandboxProviderUnsupportedError,
  type RefreshUrlsResult,
} from "../../provider";
import type { SandboxService } from "../../../types";
import { machinePath, type SmolClient } from "../../smol/provider";
import { serviceLinkPath, signServiceLink } from "../service-links";

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
 * How long the control plane serves a service link before it mints a new
 * one. Half the link's life, so the oldest link it can hand out still has
 * the other half left.
 */
export const HOSTD_SERVICE_URL_TTL_S = 12 * 60 * 60;

/**
 * How long a link stays valid once minted: twice the control plane's TTL, so
 * a link served at the end of that window still works for twelve hours. A
 * day in total, as e2b and Daytona URLs last.
 *
 * The link's path is its credential, and a copy of it keeps working wherever
 * it lands -- browser history, a Slack message (which fetches the link
 * itself to build a preview), an error report. Nothing can revoke one
 * individually, so its life is the only bound on a leak, which is why this
 * is a day rather than the two it once was.
 */
export const HOSTD_SERVICE_LINK_LIFETIME_S = 2 * HOSTD_SERVICE_URL_TTL_S;

/** amikad's service name and guest port, as Amika registers them. */
const AMIKAD_SERVICE = "amikad";
const AMIKAD_PORT = 60999;

export function hostdServices(
  apiUrl: string,
  secretKey: string,
  client: SmolClient,
) {
  const origin = apiUrl.replace(/\/$/, "");
  return {
    refreshUrls: async (
      id: string,
      services: SandboxService[],
    ): Promise<RefreshUrlsResult> => {
      machinePath(id);
      const routes = hostdServiceRoutes(services);
      const expiresAt =
        Math.floor(Date.now() / 1000) + HOSTD_SERVICE_LINK_LIFETIME_S;
      return {
        services: await Promise.all(
          services.map(async (service, i) => {
            const name = routes[i].name;
            if (name === AMIKAD_SERVICE && routes[i].port === AMIKAD_PORT) {
              return {
                ...service,
                url: `${origin}${HOSTD_RIGS_PATH}/${id}/services/${encodeURIComponent(name)}/`,
              };
            }
            const token = await signServiceLink(secretKey, {
              rig: id,
              service: name,
              expiresAt,
            });
            return {
              ...service,
              url: `${origin}${serviceLinkPath(HOSTD_RIGS_PATH, id, name, token)}`,
            };
          }),
        ),
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
