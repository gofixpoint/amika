import { E2B_HOME_DIR, type E2bConfig } from "./config";
import { e2bCapabilities } from "./capabilities";
import type { SnapshotIdResolver } from "../provider";
import { defineProvider } from "../shared/define-provider";
import {
  createE2bSandbox,
  deleteE2bSandbox,
  E2B_URL_TTL_S,
  executeE2bCommand,
  getE2bSandboxState,
  listE2bSandboxes,
  mapE2bSandboxState,
  readE2bFile,
  refreshE2bUrls,
  startE2bSandbox,
  stopE2bSandbox,
  streamE2bCommand,
  syncE2bRoutes,
  writeE2bFile,
} from "./internal/operations";
import {
  captureE2bSnapshot,
  deleteE2bSnapshotByName,
  getE2bSnapshotByName,
  waitForE2bSnapshotActive,
} from "./internal/snapshot-operations";

export { openE2bAdapter } from "./internal/operations";

export interface E2bProviderConfig {
  config: E2bConfig;
  resolveSnapshotId: SnapshotIdResolver;
}

export default defineProvider(
  e2bCapabilities,
  ({ config, resolveSnapshotId }: E2bProviderConfig) => ({
    name: "e2b",
    signedUrlTtlSeconds: E2B_URL_TTL_S,
    userHomeDir: E2B_HOME_DIR,
    sandbox: {
      create: (ctx, input) => createE2bSandbox(ctx, config, input),
      delete: (id) => deleteE2bSandbox(config, id),
      start: (id, interval) => startE2bSandbox(config, id, interval),
      stop: (id) => stopE2bSandbox(config, id),
      getState: (id) => getE2bSandboxState(config, id),
      mapState: mapE2bSandboxState,
    },
    exec: {
      stdin: true,
      run: (id, command, opts) => executeE2bCommand(config, id, command, opts),
      stream: (id, command, handlers) =>
        streamE2bCommand(config, id, command, handlers),
    },
    files: {
      read: (id, path) => readE2bFile(config, id, path),
      write: (id, path, content) => writeE2bFile(config, id, path, content),
    },
    services: {
      refreshUrls: (id, services) => refreshE2bUrls(config, id, services),
      syncRoutes: syncE2bRoutes,
    },
    listing: { list: () => listE2bSandboxes(config) },
    snapshots: {
      getSnapshot: (name) => getE2bSnapshotByName(config, name),
      deleteSnapshot: (name, id) =>
        deleteE2bSnapshotByName(resolveSnapshotId, config, name, id),
      waitForSnapshotActive: (name, id) =>
        waitForE2bSnapshotActive(resolveSnapshotId, config, name, id),
      capture: (id, name) => captureE2bSnapshot(config, id, name),
      isEnvScrubbable: () => Promise.resolve(true),
    },
  }),
);
