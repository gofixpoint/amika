/** Open and close the daemon's HTTP listener. */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createApp } from "../app.js";
import type { HostdConfigWith } from "./config.js";

export interface RunningServer {
  port: number;
  /**
   * Stop accepting connections and resolve once open ones have drained,
   * cutting off any still open after the shutdown grace period.
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
  { shutdownGraceMs = SHUTDOWN_GRACE_MS }: { shutdownGraceMs?: number } = {},
): Promise<RunningServer> {
  const app = createApp({
    secretKey: config.secretKey,
    apiUrl: config.smolApiUrl,
    requestTimeoutMs: config.smolRequestTimeoutMs,
  });
  return new Promise((resolve, reject) => {
    // Only the default `http.Server` is used, never HTTP/2.
    const server = serve({
      fetch: app.fetch,
      hostname: config.host,
      port: config.port,
    }) as Server;
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
          }),
      });
    });
  });
}
