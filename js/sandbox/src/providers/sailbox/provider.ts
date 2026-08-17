import { DEFAULT_HOME_DIR } from "../../constants";
import type { SnapshotIdResolver } from "../provider";
import { defineProvider } from "../shared/define-provider";
import { sailboxCapabilities } from "./capabilities";
import type { SailboxConfig } from "./config";
import {
  createSailboxSandbox,
  deleteSailboxSandbox,
  executeSailboxCommand,
  getSailboxSandboxState,
  listSailboxSandboxes,
  mapSailboxSandboxState,
  readSailboxFile,
  refreshSailboxUrls,
  SAILBOX_URL_TTL_S,
  startSailboxSandbox,
  stopSailboxSandbox,
  streamSailboxCommandLogs,
  syncSailboxRoutes,
  writeSailboxFile,
} from "./internal/operations";
import {
  captureSailboxCheckpoint,
  deleteSailboxCheckpoint,
  getSailboxCheckpoint,
  waitForSailboxCheckpointActive,
} from "./internal/snapshots";

export { openSailboxAdapter } from "./internal/operations";

export interface SailboxProviderConfig {
  config: SailboxConfig;
  resolveSnapshotId: SnapshotIdResolver;
}

export default defineProvider(
  sailboxCapabilities,
  ({ config, resolveSnapshotId }: SailboxProviderConfig) => ({
    name: "sailbox",
    signedUrlTtlSeconds: SAILBOX_URL_TTL_S,
    userHomeDir: DEFAULT_HOME_DIR,
    sandbox: {
      create: (ctx, input) => createSailboxSandbox(ctx, config, input),
      delete: (id) => deleteSailboxSandbox(config, id),
      start: (id, autoStopInterval) =>
        startSailboxSandbox(config, id, autoStopInterval),
      stop: (id) => stopSailboxSandbox(config, id),
      getState: (id) => getSailboxSandboxState(config, id),
      mapState: mapSailboxSandboxState,
    },
    exec: {
      stdin: true,
      run: (id, command, opts) =>
        executeSailboxCommand(config, id, command, opts),
      stream: (id, command, handlers) =>
        streamSailboxCommandLogs(config, id, command, handlers),
    },
    files: {
      read: (id, path) => readSailboxFile(config, id, path),
      write: (id, path, content) => writeSailboxFile(config, id, path, content),
    },
    services: {
      refreshUrls: (id, services) => refreshSailboxUrls(config, id, services),
      syncRoutes: (id, desired) => syncSailboxRoutes(config, id, desired),
    },
    listing: { list: () => listSailboxSandboxes(config) },
    snapshots: {
      getSnapshot: (name) => getSailboxCheckpoint(resolveSnapshotId, name),
      deleteSnapshot: () => deleteSailboxCheckpoint(),
      waitForSnapshotActive: (name, id) =>
        waitForSailboxCheckpointActive(resolveSnapshotId, name, id),
      capture: (id, name) => captureSailboxCheckpoint(config, id, name),
      isEnvScrubbable: () => Promise.resolve(true),
    },
  }),
);
