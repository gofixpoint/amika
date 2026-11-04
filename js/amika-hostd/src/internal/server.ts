/** Open and close the daemon's HTTP listener. */
import type { IncomingMessage, Server } from "node:http";
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
import type { MachineRuntime } from "./machine-runtime.js";
import type { RuntimeRouter } from "./runtime-router.js";
import {
  RUNTIME_KINDS,
  capabilitiesOf,
  hostArch,
  type MachineFacts,
} from "./runtimes.js";
import { openSnapshotStore, SnapshotConflictError } from "./snapshot-store.js";
import { startCapture } from "./snapshots.js";

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

/** What the daemon needs to take and keep snapshots on this host. */
export interface SnapshotOptions {
  directory: string;
  indexFile: string;
  /** The `smolvm` binary a pack runs through. */
  smolvm: string;
  /** smolvm's environment; never carries the daemon's keys. */
  env: NodeJS.ProcessEnv;
  err?: (line: string) => void;
  /** Abandons a capture in flight once the daemon is stopping. */
  signal?: AbortSignal;
}

/** Resolve once the port is bound, or reject if it cannot be (e.g. in use). */
/**
 * The app and the upgrade handler, which both transports serve.
 *
 * Lifted out so a tunnel is the same daemon reached a different way. A
 * second assembly here would be a second set of routes and a second
 * upgrade policy, and the one that drifted would be the one nobody was
 * looking at -- which for the upgrade handler means an authorization
 * rule that holds on one transport and not the other.
 */
export function buildHandlers(
  config: HostdConfigWith<"secretKey">,
  runtime: MachineRuntime,
  {
    servicesFile,
    hiddenMachines,
    pullingImages,
    smolvmLogFile,
    snapshots,
    machine = unknownMachine,
  }: {
    servicesFile?: string;
    hiddenMachines?: () => ReadonlySet<string>;
    /** Images pre-pull is caching now (see `AppDeps`). */
    pullingImages?: () => ReadonlySet<string>;
    /** The log of the smolvm this daemon started (see `AppConfig`). */
    smolvmLogFile?: string;
    snapshots?: SnapshotOptions;
    /** This machine, which the `bare_metal` runtime reports. */
    machine?: () => MachineFacts;
  } = {},
): {
  app: ReturnType<typeof createApp>;
  upgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
  /**
   * Every upgraded connection, for shutdown to cut.
   *
   * Returned rather than kept here, because closing is the caller's: a
   * listener drains its own server, and a tunnel's connections belong to
   * the attachment they arrived on.
   */
  tunnels: Set<Duplex>;
} {
  const registry = servicesFile
    ? fileServiceRegistry(servicesFile)
    : memoryServiceRegistry();
  const app = createApp(
    {
      secretKey: config.secretKey,
      runtimes: () => config.runtimes,
      capabilities: () => capabilitiesOf(config.runtimes, hostArch(), machine),
      configPath: config.configPath,
      requestTimeoutMs: config.smolRequestTimeoutMs,
      smolvmLogFile,
      amikaUrl: config.apiUrl,
    },
    runtime,
    {
      registry,
      hiddenMachines,
      pullingImages,
      snapshots: snapshotSupport(runtime, snapshots),
    },
  );
  const tunnels = new Set<Duplex>();
  const upgrade = createUpgradeHandler(
    config.secretKey,
    runtime,
    registry,
    tunnels,
    undefined,
    { amikaUrl: config.apiUrl },
  );
  return { app, upgrade, tunnels };
}

export function startServer(
  config: HostdConfigWith<"secretKey">,
  runtime: MachineRuntime,
  {
    shutdownGraceMs = SHUTDOWN_GRACE_MS,
    servicesFile,
    hiddenMachines,
    pullingImages,
    smolvmLogFile,
    snapshots,
    machine,
  }: {
    shutdownGraceMs?: number;
    /** This machine, which the `bare_metal` runtime reports. */
    machine?: () => MachineFacts;
    /** Persists service names across restarts; in memory without one. */
    servicesFile?: string;
    /** Machines left out of the machine list (see `AppDeps`). */
    hiddenMachines?: () => ReadonlySet<string>;
    /** Images pre-pull is caching now (see `AppDeps`). */
    pullingImages?: () => ReadonlySet<string>;
    /** The log of the smolvm this daemon started (see `AppConfig`). */
    smolvmLogFile?: string;
    /**
     * Where snapshots are kept and how they are packed. Only a daemon
     * running its own smolvm can supply this: a pack is a subprocess of
     * that binary. Without it the daemon serves no snapshot routes.
     */
    snapshots?: SnapshotOptions;
  } = {},
): Promise<RunningServer> {
  const { app, upgrade, tunnels } = buildHandlers(config, runtime, {
    servicesFile,
    hiddenMachines,
    pullingImages,
    smolvmLogFile,
    snapshots,
    machine,
  });
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

/**
 * Bind the store and the capture together for the app, or nothing when this
 * daemon cannot pack (no smolvm of its own).
 */
/** For a daemon given no `machine`, which then cannot report `bare_metal`. */
function unknownMachine(): MachineFacts {
  throw new Error("amika-hostd was not told what this machine is");
}

function snapshotSupport(
  runtime: MachineRuntime,
  options: SnapshotOptions | undefined,
) {
  if (!options) return undefined;
  const { directory, indexFile, ...capture } = options;
  const store = openSnapshotStore({ directory, indexFile });
  return {
    store,
    capture: async (rig: string, name: string) => {
      // Only smol packs a rig into a snapshot (spec 028: none on Lume yet).
      const owner =
        "runtimeOf" in runtime
          ? (runtime as RuntimeRouter).runtimeOf(rig)
          : undefined;
      if (owner !== undefined && !RUNTIME_KINDS[owner].snapshots) {
        throw new SnapshotConflictError(
          `rig ${rig} runs on ${owner}, which takes no snapshots`,
        );
      }
      await startCapture({ rig, name }, { runtime, store, ...capture });
    },
  };
}
