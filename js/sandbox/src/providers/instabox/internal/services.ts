/**
 * Service URLs through Instabox ports (https://instabox.sh/docs/ports.md).
 *
 * We publish each service port as a **private** port: its URL answers only
 * requests that carry the port's token (`?_token=ibp_…` once, then a cookie,
 * or `Authorization: Bearer`). Instabox keeps only a hash of the token, so it
 * shows the token only when it makes one. To return a working URL, every
 * refresh asks for a new token (`rotateToken`). That ends the old token and
 * its connections.
 *
 * Ports we publish get a name with the {@link PORT_NAME_PREFIX} prefix.
 * Route reconcile removes only those, never a port a user published.
 */
import { z } from "zod";
import type { RefreshUrlsResult, SandboxService } from "../../provider";
import type { InstaboxConfig } from "../config";
import { isNotFound, machinePath, requestJson, requestVoid } from "./client";

/** Marks ports Amika owns. */
export const PORT_NAME_PREFIX = "amika:";

/** Port URLs are HTTPS on the default port. */
const PUBLIC_HTTPS_PORT = 443;

/**
 * Instabox port tokens do not expire. Each refresh rotates the token and
 * ends open sessions, so refresh rarely.
 */
export const INSTABOX_URL_TTL_S = 30 * 24 * 60 * 60;

const portSchema = z.object({
  port: z.number(),
  name: z.string().nullish(),
  url: z.string(),
  access: z.string().optional(),
  tokenUrl: z.string().nullish(),
});
const portListSchema = z.object({ ports: z.array(portSchema) });

function portName(service: SandboxService): string {
  // Instabox allows names up to 100 characters.
  return `${PORT_NAME_PREFIX}${service.name}`.slice(0, 100);
}

function checkService(service: SandboxService): void {
  if (service.protocol !== "tcp") {
    throw new Error(
      `Instabox publishes HTTP ports only; service "${service.name}" uses ${service.protocol}`,
    );
  }
}

/** Publish `port` as a private port. With `rotate`, return its token URL. */
async function publishPrivatePort(
  config: InstaboxConfig,
  machineId: string,
  service: SandboxService,
  rotate: boolean,
): Promise<z.infer<typeof portSchema>> {
  return requestJson(
    config,
    portSchema,
    "POST",
    machinePath(machineId, "/ports"),
    {
      // The key keeps a retry from rotating the token twice.
      idempotent: true,
      json: {
        port: service.containerPort,
        name: portName(service),
        access: "private",
        ...(rotate ? { rotateToken: true } : {}),
      },
    },
  );
}

/** Publish each service's port and return a fresh token URL for it. */
export async function refreshInstaboxUrls(
  config: InstaboxConfig,
  machineId: string,
  services: SandboxService[],
): Promise<RefreshUrlsResult> {
  // One token per port: services on the same port share it.
  const urls = new Map<number, string>();
  const refreshed: SandboxService[] = [];
  for (const service of services) {
    checkService(service);
    let url = urls.get(service.containerPort);
    if (url === undefined) {
      const port = await publishPrivatePort(config, machineId, service, true);
      if (!port.tokenUrl) {
        throw new Error(
          `Instabox did not return a token URL for port ${service.containerPort}`,
        );
      }
      url = port.tokenUrl;
      urls.set(service.containerPort, url);
    }
    refreshed.push({ ...service, url, hostPort: PUBLIC_HTTPS_PORT });
  }
  return { services: refreshed };
}

/**
 * Make the machine's Amika-owned ports match `desired`: unpublish the ones
 * no desired service uses, publish the missing ones. A port that is already
 * published keeps its token.
 */
export async function syncInstaboxRoutes(
  config: InstaboxConfig,
  machineId: string,
  desired: SandboxService[],
): Promise<void> {
  for (const service of desired) checkService(service);
  const desiredPorts = new Map(desired.map((s) => [s.containerPort, s]));
  const { ports } = await requestJson(
    config,
    portListSchema,
    "GET",
    machinePath(machineId, "/ports"),
  );

  for (const port of ports) {
    if (!port.name?.startsWith(PORT_NAME_PREFIX)) continue;
    if (desiredPorts.has(port.port)) continue;
    try {
      await requestVoid(
        config,
        "DELETE",
        machinePath(machineId, `/ports/${port.port}`),
      );
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  const published = new Set(ports.map((p) => p.port));
  for (const [port, service] of desiredPorts) {
    if (published.has(port)) continue;
    await publishPrivatePort(config, machineId, service, false);
  }
}
