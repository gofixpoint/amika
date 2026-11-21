/**
 * Service URLs through boat hosted ports (https://docs.boat.dev/hosting.md).
 *
 * `POST /sandboxes/{id}/host` publishes a port at
 * `https://<subdomain>-<port>.on.boat.dev`. We keep boat's default, a
 * protected port: the URL answers only with its `?_token=` (once, then a
 * cookie). Hosting a port again returns the same URL and token, so a
 * refresh does not end open sessions.
 *
 * boat's API cannot unhost a port or list hosted ports, so route reconcile
 * only hosts the ports it needs; a port no service uses stays hosted (still
 * behind its token) until the sandbox stops.
 */
import { z } from "zod";
import type { RefreshUrlsResult, SandboxService } from "../../provider";
import type { BoatConfig } from "../config";
import { requestJson, sandboxPath } from "./client";

/** Hosted port URLs are HTTPS on the default port. */
const PUBLIC_HTTPS_PORT = 443;

/** Ports boat keeps for itself. */
const RESERVED_PORTS = new Set([22, 6080, 8090, 8911]);

/** boat tokens do not expire, and hosting again keeps them. */
export const BOAT_URL_TTL_S = 30 * 24 * 60 * 60;

const hostedSchema = z.object({ url: z.string() });

function checkService(service: SandboxService): void {
  if (service.protocol !== "tcp") {
    throw new Error(
      `boat hosts HTTP ports only; service "${service.name}" uses ${service.protocol}`,
    );
  }
  const port = service.containerPort;
  if (RESERVED_PORTS.has(port) || (port >= 47984 && port <= 48010)) {
    throw new Error(`boat reserves port ${port}; service "${service.name}"`);
  }
}

async function hostPort(
  config: BoatConfig,
  sandboxId: string,
  service: SandboxService,
): Promise<string> {
  const hosted = await requestJson(
    config,
    hostedSchema,
    "POST",
    sandboxPath(sandboxId, "/host"),
    // Hosting is idempotent: the same port gets the same URL.
    {
      json: { port: service.containerPort, title: `amika:${service.name}` },
      idempotent: true,
    },
  );
  return hosted.url;
}

/** Host each service's port and return its token URL. */
export async function refreshBoatUrls(
  config: BoatConfig,
  sandboxId: string,
  services: SandboxService[],
): Promise<RefreshUrlsResult> {
  const urls = new Map<number, string>();
  const refreshed: SandboxService[] = [];
  for (const service of services) {
    checkService(service);
    let url = urls.get(service.containerPort);
    if (url === undefined) {
      url = await hostPort(config, sandboxId, service);
      urls.set(service.containerPort, url);
    }
    refreshed.push({ ...service, url, hostPort: PUBLIC_HTTPS_PORT });
  }
  return { services: refreshed };
}

/** Host every desired port. See the module comment for why none is removed. */
export async function syncBoatRoutes(
  config: BoatConfig,
  sandboxId: string,
  desired: SandboxService[],
): Promise<void> {
  const seen = new Set<number>();
  for (const service of desired) {
    checkService(service);
    if (seen.has(service.containerPort)) continue;
    seen.add(service.containerPort);
    await hostPort(config, sandboxId, service);
  }
}
