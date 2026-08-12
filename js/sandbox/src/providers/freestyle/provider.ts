/**
 * Freestyle provider definition: binds a {@link FreestyleConfig} and plugs the
 * operation helpers in this directory into the capability namespaces.
 *
 * ⚠️ EXPERIMENTAL — not production-ready. Daytona (VM) is the primary,
 * supported provider; Freestyle is a work in progress and may not fully work
 * (provisioning, snapshots, SSH, and preview URLs are all subject to change and
 * are not exercised as thoroughly as Daytona). Prefer Daytona for anything that
 * must work reliably.
 *
 * Freestyle supports capturing snapshots from a running sandbox (the "Take
 * Snapshot" flow) but does NOT back the org-level control plane: image-derived
 * snapshots and docker registries stay Daytona-only (`dockerRegistries` and
 * `snapshots.createImageSnapshot` are omitted → unsupported). Streaming is
 * unsupported (`vm.exec` buffers), so `exec.stream` is omitted. Its presets are
 * pre-made VM snapshots supplied via config and cloned on create.
 */
import type { FreestyleConfig } from "./config";
import { defineProvider } from "../shared/define-provider";
import { DEFAULT_HOME_DIR } from "../../constants";
import { freestyleCapabilities } from "./capabilities";
import {
  createFreestyleSandbox,
  deleteFreestyleSandbox,
  executeFreestyleCommand,
  FREESTYLE_URL_TTL_S,
  getFreestyleSandboxState,
  listFreestyleSandboxes,
  mapFreestyleSandboxState,
  readFreestyleFile,
  writeFreestyleFile,
  refreshFreestyleUrls,
  syncFreestyleRoutes,
  startFreestyleSandbox,
  stopFreestyleSandbox,
} from "./internal/operations";
import {
  captureFreestyleSandboxSnapshot,
  deleteFreestyleSnapshotByName,
  getFreestyleSnapshotByName,
  waitForFreestyleSnapshotActive,
} from "./internal/snapshot-operations";
import {
  createFreestyleSshAccess,
  revokeFreestyleSshAccess,
} from "./internal/ssh";

// Provider-root re-exports of the server-side surface the registry wires up.
// The implementations live in `internal/`; routing them through `provider.ts`
// keeps the folder root as the provider's only public entry.
export { openFreestyleAdapter } from "./internal/operations";

export default defineProvider(
  freestyleCapabilities,
  (config: FreestyleConfig) => ({
    name: "freestyle",
    signedUrlTtlSeconds: FREESTYLE_URL_TTL_S,
    userHomeDir: DEFAULT_HOME_DIR,

    sandbox: {
      create: (ctx, input) => createFreestyleSandbox(ctx, config, input),
      delete: (id) => deleteFreestyleSandbox(config, id),

      start: (id, autoStopInterval) =>
        startFreestyleSandbox(config, id, autoStopInterval),
      stop: (id) => stopFreestyleSandbox(config, id),
      getState: (id) => getFreestyleSandboxState(config, id),
      mapState: mapFreestyleSandboxState,
    },

    // No `cloneRepo` override: Freestyle has no first-class git primitive, so
    // `Sandbox.git` is `null` and the provisioning layer clones by running
    // shell `git` over the adapter exec port.

    // `vm.exec` buffers (no incremental output), so `stream` is omitted and
    // `exec.streaming` derives to false.
    exec: {
      stdin: true,
      run: (id, command, opts) =>
        executeFreestyleCommand(config, id, command, opts),
    },

    files: {
      read: (id, filePath) => readFreestyleFile(config, id, filePath),
      write: (id, filePath, content) =>
        writeFreestyleFile(config, id, filePath, content),
    },

    ssh: {
      // SSH rides on Freestyle's identity/token system via the
      // `vm-ssh.freestyle.sh` gateway; see `./internal/ssh` for the mint/revoke details
      // and the expiry caveat.
      mint: (id, expiresInMinutes) =>
        createFreestyleSshAccess(config, id, expiresInMinutes),
      // Freestyle revokes by the identity/token ids encoded in `token` at mint
      // time (the token string can't be mapped back to its id), not the
      // sandbox id.
      revoke: (_id, token) => revokeFreestyleSshAccess(config, token),
    },

    services: {
      refreshUrls: (id, services) => refreshFreestyleUrls(config, id, services),
      syncRoutes: (id, desired) => syncFreestyleRoutes(config, id, desired),
    },

    listing: {
      list: () => listFreestyleSandboxes(config),
    },

    snapshots: {
      // The by-name lookup is a list scan that already tolerates a
      // still-registering snapshot, so the default `findSnapshot` →
      // `getSnapshot` fallback is exactly right.
      getSnapshot: (name) => getFreestyleSnapshotByName(config, name),
      deleteSnapshot: (name) => deleteFreestyleSnapshotByName(config, name),
      waitForSnapshotActive: (name) =>
        waitForFreestyleSnapshotActive(config, name),
      // Freestyle snapshots the RUNNING VM either way (a stopped-VM snapshot
      // 500s, KAPRO-482), so `keepSourceRunning` needs no branching: the
      // capture never stops the source, and the destructive caller deletes it
      // afterward.
      capture: (id, snapshotName) =>
        captureFreestyleSandboxSnapshot(config, id, snapshotName),
      // Freestyle never bakes Amika secrets into an un-scrubbable container
      // env spec — injected env vars live only in `/etc/environment`, which
      // the scrub removes — so every Freestyle sandbox is scrub-safe.
      isEnvScrubbable: () => Promise.resolve(true),
    },
  }),
);
