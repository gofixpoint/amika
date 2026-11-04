/**
 * Instabox provider (https://instabox.sh): Linux VMs ("machines") driven by
 * the Instabox REST API through the small client in `./internal/client.ts`.
 *
 * - A sandbox boots from a template (`agent-browser`, `ci`, ...), from a
 *   snapshot id (`sn_…`), or from the name of one of the account's
 *   snapshots (for example an image imported with `instabox snapshot
 *   import`).
 * - The machine user is `user`, with home `/data/home` on the persistent
 *   disk and passwordless `sudo`.
 * - `stop` is a cold stop. Instabox also pauses idle machines by itself;
 *   commands, files, and SSH wake a machine that paused itself.
 * - One command runs at most 10 minutes (an Instabox limit).
 */
import type { InstaboxConfig } from "./config";
import { instaboxCapabilities } from "./capabilities";
import { defineProvider } from "../shared/define-provider";
import { execInstabox } from "./internal/exec";
import {
  createInstaboxSandbox,
  deleteInstaboxSandbox,
  getInstaboxSandboxState,
  INSTABOX_HOME_DIR,
  listInstaboxSandboxes,
  mapInstaboxSandboxState,
  readInstaboxFile,
  startInstaboxSandbox,
  stopInstaboxSandbox,
  writeInstaboxFile,
} from "./internal/operations";
import {
  INSTABOX_URL_TTL_S,
  refreshInstaboxUrls,
  syncInstaboxRoutes,
} from "./internal/services";
import { mintInstaboxSshAccess, revokeInstaboxSshAccess } from "./internal/ssh";
import {
  captureInstaboxSnapshot,
  deleteInstaboxSnapshot,
  getInstaboxSnapshotByName,
  waitForInstaboxSnapshotReady,
} from "./internal/snapshot-operations";

export { openInstaboxAdapter } from "./internal/adapter";

export default defineProvider(
  instaboxCapabilities,
  (config: InstaboxConfig) => ({
    name: "instabox",
    signedUrlTtlSeconds: INSTABOX_URL_TTL_S,
    userHomeDir: INSTABOX_HOME_DIR,

    sandbox: {
      create: (ctx, input) => createInstaboxSandbox(ctx, config, input),
      delete: (id) => deleteInstaboxSandbox(config, id),
      start: (id, interval) => startInstaboxSandbox(config, id, interval),
      stop: (id) => stopInstaboxSandbox(config, id),
      getState: (id) => getInstaboxSandboxState(config, id),
      mapState: mapInstaboxSandboxState,
    },

    // No `cloneRepo`: Instabox has no clone API, so provisioning runs `git`
    // over the adapter.

    exec: {
      stdin: true,
      run: (id, command, opts) => execInstabox(config, id, command, opts),
      stream: async (id, command, handlers) => {
        await execInstabox(config, id, command, {}, handlers);
      },
    },

    files: {
      read: (id, path, opts) => readInstaboxFile(config, id, path, opts),
      write: (id, path, content) =>
        writeInstaboxFile(config, id, path, content),
    },

    ssh: {
      mint: (id, minutes) => mintInstaboxSshAccess(config, id, minutes),
      revoke: (id, token) => revokeInstaboxSshAccess(config, id, token),
    },

    services: {
      refreshUrls: (id, services) => refreshInstaboxUrls(config, id, services),
      syncRoutes: (id, desired) => syncInstaboxRoutes(config, id, desired),
    },

    listing: { list: () => listInstaboxSandboxes(config) },

    snapshots: {
      // The by-name lookup scans the list, which includes `pending`
      // snapshots, so the default `findSnapshot` (= `getSnapshot`) is right.
      getSnapshot: (name) => getInstaboxSnapshotByName(config, name),
      deleteSnapshot: (name, id) => deleteInstaboxSnapshot(config, name, id),
      waitForSnapshotActive: (name, id) =>
        waitForInstaboxSnapshotReady(config, name, id),
      capture: (id, name) => captureInstaboxSnapshot(config, id, name),
      // Instabox has no container env spec; env vars live in files the
      // scrub can remove, so every machine is scrub-safe.
      isEnvScrubbable: () => Promise.resolve(true),
    },
  }),
);
