/**
 * Runtime provider (https://withruntime.com): Firecracker microVMs
 * ("sandboxes") driven by the Runtime REST API through the small client in
 * `./internal/client.ts`.
 *
 * - A sandbox boots Runtime's default image (Ubuntu 24.04), or an image
 *   version this provider captured.
 * - Runtime logs in as `runtime`. Commands and files run as the `amika` rig
 *   user, home `/home/amika`, through `sudo` (`../shared/rig-user.ts`).
 * - `stop` pauses the sandbox and `start` resumes it. Runtime also pauses
 *   an idle sandbox, and any command wakes it.
 */
import type { RuntimeConfig } from "./config";
import { runtimeCapabilities } from "./capabilities";
import { defineProvider } from "../shared/define-provider";
import { rigUserOps, RIG_USER_HOME } from "../shared/rig-user";
import {
  createRuntimeSandbox,
  deleteRuntimeSandbox,
  getRuntimeSandboxState,
  listRuntimeSandboxes,
  mapRuntimeSandboxState,
  startRuntimeSandbox,
  stopRuntimeSandbox,
} from "./internal/operations";
import {
  refreshRuntimeUrls,
  RUNTIME_URL_TTL_S,
  syncRuntimeRoutes,
} from "./internal/services";
import { runtimeShell } from "./internal/shell";
import {
  captureRuntimeSnapshot,
  deleteRuntimeSnapshot,
  getRuntimeSnapshot,
  waitForRuntimeSnapshotReady,
} from "./internal/snapshot-operations";

export { openRuntimeAdapter } from "./internal/adapter";

export default defineProvider(runtimeCapabilities, (config: RuntimeConfig) => {
  const ops = (id: string) => rigUserOps(runtimeShell(config, id));
  return {
    name: "runtime",
    signedUrlTtlSeconds: RUNTIME_URL_TTL_S,
    userHomeDir: RIG_USER_HOME,

    sandbox: {
      create: (ctx, input) => createRuntimeSandbox(ctx, config, input),
      delete: (id) => deleteRuntimeSandbox(config, id),
      start: (id, interval) => startRuntimeSandbox(config, id, interval),
      stop: (id) => stopRuntimeSandbox(config, id),
      getState: (id) => getRuntimeSandboxState(config, id),
      mapState: mapRuntimeSandboxState,
    },

    exec: {
      stdin: true,
      run: (id, command, opts) => ops(id).exec(command, opts),
      stream: (id, command, handlers) => ops(id).stream(command, handlers),
    },

    files: {
      read: (id, path, opts) => ops(id).readFile(path, opts),
      write: (id, path, content) => ops(id).writeFile(path, content),
    },

    services: {
      refreshUrls: (id, services) => refreshRuntimeUrls(config, id, services),
      syncRoutes: (id, desired) => syncRuntimeRoutes(config, id, desired),
    },

    listing: { list: () => listRuntimeSandboxes(config) },

    snapshots: {
      getSnapshot: (name) => getRuntimeSnapshot(config, name),
      deleteSnapshot: (name, id) => deleteRuntimeSnapshot(config, name, id),
      waitForSnapshotActive: (name, id) =>
        waitForRuntimeSnapshotReady(config, name, id),
      capture: (id, name) => captureRuntimeSnapshot(config, id, name),
      // No env at create; env vars live in files the scrub can remove.
      isEnvScrubbable: () => Promise.resolve(true),
    },
  };
});
