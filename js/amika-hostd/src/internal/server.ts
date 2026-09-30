/** Open and close the daemon's HTTP listener. */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { serve } from "@hono/node-server";
import { createApp } from "../app.js";
import type { HostdConfigWith } from "./config.js";
import {
  fileServiceRegistry,
  memoryServiceRegistry,
} from "./service-registry.js";
import { createUpgradeHandler } from "./services.js";
import { SmolRuntime } from "./smol.js";

export interface RunningServer {
  port: number;
  /**
   * Stop accepting connections and resolve once open ones have drained,
   * cutting off any still open after the shutdown grace period. Service
   * tunnels (upgraded connections) end at once: they are long-lived by
   * design, so waiting on them would always run out the grace period.
   */
  close(): Promise<void>;
}

/**
 * How long shutdown waits for in-flight requests. Without a bound, one slow
 * client (even an unauthenticated one trickling headers) keeps the daemon
 * alive after `SIGTERM` until Node's 5-minute request timeout.
 */
export const SHUTDOWN_GRACE_MS = 5_000;

/** Resolve once the port is bound, or reject if it cannot be (e.g. in use). */
export function startServer(
  config: HostdConfigWith<"secretKey">,
  {
    shutdownGraceMs = SHUTDOWN_GRACE_MS,
    servicesFile,
  }: {
    shutdownGraceMs?: number;
    /** Persists service names across restarts; in memory without one. */
    servicesFile?: string;
  } = {},
): Promise<RunningServer> {
  const registry = servicesFile
    ? fileServiceRegistry(servicesFile)
    : memoryServiceRegistry();
  const runtimeConfig = {
    apiUrl: config.smolApiUrl,
    requestTimeoutMs: config.smolRequestTimeoutMs,
  };
  const app = createApp(
    {
      ...runtimeConfig,
      secretKey: config.secretKey,
      images: config.images,
      configPath: config.configPath,
    },
    fetch,
    { registry },
  );
  const tunnels = new Set<Duplex>();
  const upgrade = createUpgradeHandler(
    config.secretKey,
    new SmolRuntime(runtimeConfig),
    registry,
    tunnels,
  );
  return new Promise((resolve, reject) => {
    // Only the default `http.Server` is used, never HTTP/2.
    const server = serve({
      fetch: app.fetch,
      hostname: config.host,
      port: config.port,
    }) as Server;
    server.on("upgrade", upgrade);
    server.once("error", reject);
    server.once("listening", () => {
      server.off("error", reject);
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () =>
          new Promise((done, fail) => {
            const cutOff = setTimeout(
              () => server.closeAllConnections(),
              shutdownGraceMs,
            );
            server.close((error) => {
              clearTimeout(cutOff);
              if (error) fail(error);
              else done();
            });
            server.closeIdleConnections();
            for (const tunnel of tunnels) tunnel.destroy();
          }),
      });
    });
  });
}
