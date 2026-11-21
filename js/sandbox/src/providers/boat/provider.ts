/**
 * boat provider (https://boat.dev): Ubuntu VMs ("sandboxes") driven by the
 * boat REST API through the small client in `./internal/client.ts`.
 *
 * - A sandbox boots boat's base image (Ubuntu 24.04) or a saved snapshot.
 * - boat logs in as `user`. Commands and files run as the `amika` rig user,
 *   home `/home/amika`, through `sudo` (`../shared/rig-user.ts`).
 * - `stop` saves the disk and frees the machine; `start` resumes it.
 * - One command runs at most 10 minutes (a boat limit).
 */
import type { BoatConfig } from "./config";
import { boatCapabilities } from "./capabilities";
import { defineProvider } from "../shared/define-provider";
import { rigUserOps, RIG_USER_HOME } from "../shared/rig-user";
import {
  createBoatSandbox,
  deleteBoatSandbox,
  getBoatSandboxState,
  listBoatSandboxes,
  listBoatSizes,
  mapBoatSandboxState,
  startBoatSandbox,
  stopBoatSandbox,
} from "./internal/operations";
import {
  BOAT_URL_TTL_S,
  refreshBoatUrls,
  syncBoatRoutes,
} from "./internal/services";
import { boatShell } from "./internal/shell";
import {
  captureBoatSnapshot,
  deleteBoatSnapshot,
  getBoatSnapshot,
  waitForBoatSnapshotReady,
} from "./internal/snapshot-operations";

export { openBoatAdapter } from "./internal/adapter";

export default defineProvider(boatCapabilities, (config: BoatConfig) => {
  const ops = (id: string) => rigUserOps(boatShell(config, id));
  return {
    name: "boat",
    signedUrlTtlSeconds: BOAT_URL_TTL_S,
    userHomeDir: RIG_USER_HOME,

    sandbox: {
      create: (ctx, input) => createBoatSandbox(ctx, config, input),
      delete: (id) => deleteBoatSandbox(config, id),
      start: (id) => startBoatSandbox(config, id),
      stop: (id) => stopBoatSandbox(config, id),
      getState: (id) => getBoatSandboxState(config, id),
      mapState: mapBoatSandboxState,
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
      refreshUrls: (id, services) => refreshBoatUrls(config, id, services),
      syncRoutes: (id, desired) => syncBoatRoutes(config, id, desired),
    },

    listing: { list: () => listBoatSandboxes(config) },

    snapshots: {
      getSnapshot: (name) => getBoatSnapshot(config, name),
      deleteSnapshot: (name, id) => deleteBoatSnapshot(config, name, id),
      waitForSnapshotActive: (name, id) =>
        waitForBoatSnapshotReady(config, name, id),
      capture: (id, name) => captureBoatSnapshot(config, id, name),
      // `noEnv` keeps boat's env empty; env vars live in files the scrub
      // can remove.
      isEnvScrubbable: () => Promise.resolve(true),
    },

    account: { listSizes: () => listBoatSizes(config) },
  };
});
