/**
 * Service URLs for amika-hostd machines.
 *
 * hostd publishes each service's guest port when it creates the machine and
 * serves it at `/services/<machine>/<port>/<token>/`, forwarding HTTP and
 * WebSocket upgrades (see `js/amika-hostd/src/internal/services.ts`). The
 * token is signed here with the daemon's secret key, so the URL is the only
 * credential a caller needs and the secret key never leaves the control plane.
 * This is what backs no-relay SSH: the `amikad` service URL is where the Amika
 * CLI opens its SSH WebSocket.
 */
import { createHmac } from "node:crypto";
import type { RefreshUrlsResult } from "../../provider";
import type { SandboxService } from "../../../types";
import {
  machinePath,
  machineSchema,
  type SmolClient,
} from "../../smol/provider";

/** Signed service URLs stay valid for 24 hours, as Daytona's and E2B's do. */
export const HOSTD_SERVICE_URL_TTL_S = 24 * 60 * 60;

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
      const expiresAt = Math.floor(Date.now() / 1000) + HOSTD_SERVICE_URL_TTL_S;
      return {
        services: services.map((service) => ({
          ...service,
          url: `${origin}/services/${id}/${service.containerPort}/${signHostdServiceToken(secretKey, id, service.containerPort, expiresAt)}/`,
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
 * The token for one machine port, valid until `expiresAt` (Unix seconds):
 * `<expiresAt>.<base64url HMAC-SHA256>`. Mirrors `signServiceToken` in
 * `@amika/hostd`, which verifies it; the two must stay identical.
 */
export function signHostdServiceToken(
  secretKey: string,
  machine: string,
  port: number,
  expiresAt: number,
): string {
  const mac = createHmac("sha256", secretKey)
    .update(`amika-hostd-service:v1\n${machine}\n${port}\n${expiresAt}`)
    .digest("base64url");
  return `${expiresAt}.${mac}`;
}
