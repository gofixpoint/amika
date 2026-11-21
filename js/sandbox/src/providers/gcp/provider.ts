/**
 * GCP provider: Google Compute Engine VMs in an org's own project, driven by
 * the Compute Engine REST API (`./internal/client.ts`) and, for commands and
 * files, SSH (`./internal/ssh.ts`).
 *
 * - A sandbox boots from a disk image: Ubuntu 24.04 by default, a full
 *   image path, or an image this provider captured.
 * - The VM user is `amika`, home `/home/amika`, with passwordless `sudo`
 *   from Google's guest agent.
 * - `stop` powers the VM off; its disk stays. Compute Engine has no idle
 *   timer.
 * - There are no service URLs: Compute Engine has no port routing.
 */
import type { GcpConfig } from "./config";
import { gcpCapabilities } from "./capabilities";
import { defineProvider } from "../shared/define-provider";
import { gcpTarget } from "./internal/client";
import {
  execGcpCommand,
  readGcpFileBytes,
  streamGcpCommand,
  writeGcpFileWithParents,
} from "./internal/exec";
import {
  createGcpSandbox,
  deleteGcpSandbox,
  GCP_HOME_DIR,
  getGcpSandboxState,
  listGcpSandboxes,
  mapGcpSandboxState,
  startGcpSandbox,
  stopGcpSandbox,
} from "./internal/operations";
import {
  captureGcpSnapshot,
  deleteGcpSnapshot,
  getGcpSnapshot,
  waitForGcpSnapshotReady,
} from "./internal/snapshot-operations";

export { openGcpAdapter } from "./internal/adapter";

/** Signed URLs do not apply (no services); the contract needs a value. */
const GCP_URL_TTL_S = 3600;

export default defineProvider(gcpCapabilities, (config: GcpConfig) => {
  const target = gcpTarget(config);
  return {
    name: "gcp",
    signedUrlTtlSeconds: GCP_URL_TTL_S,
    userHomeDir: GCP_HOME_DIR,

    sandbox: {
      create: (ctx, input) => createGcpSandbox(ctx, target, input),
      delete: (id) => deleteGcpSandbox(target, id),
      start: (id) => startGcpSandbox(target, id),
      stop: (id) => stopGcpSandbox(target, id),
      getState: (id) => getGcpSandboxState(target, id),
      mapState: mapGcpSandboxState,
    },

    exec: {
      stdin: true,
      run: (id, command, opts) => execGcpCommand(target, id, command, opts),
      stream: (id, command, handlers) =>
        streamGcpCommand(target, id, command, handlers),
    },

    files: {
      read: (id, path, opts) => readGcpFileBytes(target, id, path, opts),
      write: (id, path, content) =>
        writeGcpFileWithParents(target, id, path, content),
    },

    listing: { list: () => listGcpSandboxes(target) },

    snapshots: {
      // An image is readable by name from the moment its insert is
      // accepted (`PENDING`), so the default `findSnapshot` is right.
      getSnapshot: (name) => getGcpSnapshot(target, name),
      deleteSnapshot: (name, id) => deleteGcpSnapshot(target, name, id),
      waitForSnapshotActive: (name, id) =>
        waitForGcpSnapshotReady(target, name, id),
      capture: (id, name) => captureGcpSnapshot(target, id, name),
      // Compute Engine has no env spec; env vars live in files the scrub
      // can remove.
      isEnvScrubbable: () => Promise.resolve(true),
    },
  };
});
