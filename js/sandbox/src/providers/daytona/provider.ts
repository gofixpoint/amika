/**
 * Daytona provider definition: binds a {@link DaytonaConfig} and plugs the
 * operation helpers in this directory into the capability namespaces. Daytona
 * is the full-featured, control-plane provider — it backs every capability,
 * including the image-derived snapshots and docker registries no other
 * provider supports.
 */
import type { DaytonaConfig } from "./config";
import { defineProvider } from "../shared/define-provider";
import { DEFAULT_HOME_DIR } from "../../constants";
import { daytonaCapabilities } from "./capabilities";
import { SIGNED_URL_EXPIRY_S } from "./internal/types";
import {
  cloneDaytonaRepo,
  createDaytonaSandbox,
  createDaytonaSshAccess,
  deleteDaytonaSandbox,
  executeDaytonaCommand,
  getDaytonaSandboxState,
  listDaytonaSandboxes,
  mapDaytonaSandboxState,
  readSandboxFile,
  writeSandboxFile,
  refreshDaytonaUrls,
  revokeDaytonaSshAccess,
  startDaytonaSandbox,
  stopDaytonaSandbox,
  streamDaytonaCommandLogs,
} from "./internal/operations";
import {
  captureDaytonaSandboxSnapshot,
  createDaytonaImageSnapshot,
  deleteDaytonaSnapshotIfExists,
  findDaytonaSnapshot,
  getDaytonaSnapshotOrNull,
  isSandboxEnvScrubbable,
  waitForDaytonaSnapshotActive,
} from "./internal/snapshot-operations";
import {
  createDaytonaDockerRegistry,
  deleteDaytonaDockerRegistry,
  getDaytonaDockerRegistry,
  listDaytonaDockerRegistries,
} from "./internal/docker-registry";

// Provider-root re-exports of the server-side surface the registry wires up.
// The implementations live in `internal/`; routing them through `provider.ts`
// keeps the folder root as the provider's only public entry.
export { openDaytonaAdapter } from "./internal/operations";

export default defineProvider(daytonaCapabilities, (config: DaytonaConfig) => ({
  name: "daytona",
  signedUrlTtlSeconds: SIGNED_URL_EXPIRY_S,
  userHomeDir: DEFAULT_HOME_DIR,

  sandbox: {
    create: (ctx, input) => createDaytonaSandbox(ctx, config, input),
    delete: (id) => deleteDaytonaSandbox(config, id),

    // Daytona persists the auto-stop interval server-side (set at create), so
    // it does not need to be re-applied on start.
    start: (id) => startDaytonaSandbox(config, id),
    stop: (id) => stopDaytonaSandbox(config, id),
    getState: (id) => getDaytonaSandboxState(config, id),
    mapState: mapDaytonaSandboxState,
  },

  // Daytona clones via the SDK's native `git.clone` (no shell `git` needed).
  cloneRepo: (id, input) => cloneDaytonaRepo(config, id, input),

  exec: {
    stdin: true,
    run: (id, command, opts) =>
      executeDaytonaCommand(config, id, command, opts),
    stream: (id, command, handlers) =>
      streamDaytonaCommandLogs(config, id, command, handlers),
  },

  files: {
    read: (id, filePath) => readSandboxFile(config, id, filePath),
    write: (id, filePath, content) =>
      writeSandboxFile(config, id, filePath, content),
  },

  ssh: {
    // Narrow the SDK's access record to the minted contract — the raw response
    // carries extra metadata (record ids, timestamps) callers must not rely on.
    mint: async (id, expiresInMinutes) => {
      const access = await createDaytonaSshAccess(config, id, expiresInMinutes);
      return {
        token: access.token,
        sshDestination: access.sshDestination,
        expiresAt: access.expiresAt,
      };
    },
    revoke: (id, token) => revokeDaytonaSshAccess(config, id, token),
  },

  services: {
    refreshUrls: (id, services) => refreshDaytonaUrls(config, id, services),
    // Daytona serves signed preview URLs that self-expire at
    // `signedUrlTtlSeconds`; a deleted service simply stops being re-signed,
    // and the SDK exposes no port-unexpose primitive, so there is no route
    // state to reconcile. The old URL lapses on its own at the signature TTL.
    syncRoutes: () => Promise.resolve(),
  },

  listing: {
    list: () => listDaytonaSandboxes(config),
  },

  snapshots: {
    createImageSnapshot: (input) => createDaytonaImageSnapshot(config, input),
    getSnapshot: (name) => getDaytonaSnapshotOrNull(config, name),
    findSnapshot: (name) => findDaytonaSnapshot(config, name),
    deleteSnapshot: (name) => deleteDaytonaSnapshotIfExists(config, name),
    waitForSnapshotActive: (name) => waitForDaytonaSnapshotActive(config, name),
    capture: async (id, snapshotName, opts) => {
      await captureDaytonaSandboxSnapshot(config, id, snapshotName, opts);
      // Daytona boots snapshots by their org-scoped name, so there is no
      // separate bootable id to record.
      return { providerSnapshotId: null };
    },
    isEnvScrubbable: (id) => isSandboxEnvScrubbable(config, id),
  },

  dockerRegistries: {
    createRegistry: (input) => createDaytonaDockerRegistry(config, input),
    listRegistries: () => listDaytonaDockerRegistries(config),
    getRegistry: (registryId) => getDaytonaDockerRegistry(config, registryId),
    deleteRegistry: (registryId) =>
      deleteDaytonaDockerRegistry(config, registryId),
  },
}));
