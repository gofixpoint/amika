/**
 * Vercel provider definition: binds a {@link VercelConfig} (plus the injected
 * {@link SnapshotIdResolver}) and plugs the operation helpers in this directory
 * into the capability namespaces.
 *
 * ⚠️ EXPERIMENTAL — not production-ready. Daytona (VM) is the primary,
 * supported provider; Vercel is a work in progress and may not fully work
 * (provisioning, snapshots, and the resume/service behavior are all subject to
 * change and are not exercised as thoroughly as
 * Daytona). Prefer Daytona for anything that must work reliably.
 *
 * Capability shape (see `./capabilities`): per-sandbox lifecycle + exec + log
 * streaming + snapshots. Streaming is real (the SDK's incremental
 * `command.logs()`), unlike Freestyle. SSH is supplied by the generic
 * provider-exposed `amikad` service and therefore does not occupy this
 * provider-specific capability. Snapshots are captured from a
 * running sandbox via `sandbox.snapshot()` and addressed by their org-scoped
 * name through the injected name↔id resolver (Vercel snapshots are id-only;
 * see `./internal/snapshot-lookup`). Docker registries and image-derived snapshots stay
 * Daytona-only, so `dockerRegistries` and `snapshots.createImageSnapshot` are
 * omitted → unsupported.
 */
import type { VercelConfig } from "./config";
import { VERCEL_HOME_DIR } from "./config";
import type { SnapshotIdResolver } from "../provider";
import { SandboxProviderUnsupportedError } from "../provider";
import { defineProvider } from "../shared/define-provider";
import { vercelCapabilities } from "./capabilities";
import {
  createVercelSandbox,
  deleteVercelSandbox,
  executeVercelCommand,
  getVercelSandboxState,
  listVercelSandboxes,
  mapVercelSandboxState,
  openVercelAdapter,
  readVercelFile,
  writeVercelFile,
  writeVercelResumeContext,
  refreshVercelUrls,
  syncVercelRoutes,
  startVercelSandbox,
  stopVercelSandbox,
  streamVercelCommandLogs,
  VERCEL_URL_TTL_S,
} from "./internal/operations";
import {
  captureVercelSnapshot,
  removeVercelInjectedSecrets,
} from "./internal/snapshot-capture";
import {
  deleteVercelSnapshotByName,
  getVercelSnapshotByName,
  waitForVercelSnapshotActive,
} from "./internal/snapshot-lookup";

// Provider-root re-exports of the server-side surface consumers wire up. The
// implementations live in `internal/`; routing them through `provider.ts`
// keeps the folder root as the provider's only public entry.
export { openVercelAdapter } from "./internal/operations";

/**
 * What the Vercel factory binds: the {@link VercelConfig} plus the
 * {@link SnapshotIdResolver} the snapshot capability uses to resolve the
 * org-scoped name↔`snap_…` id mapping (Vercel snapshots are id-only). The
 * registry supplies both from its {@link SandboxProviderDeps}.
 */
export interface VercelProviderConfig {
  config: VercelConfig;
  resolveSnapshotId: SnapshotIdResolver;
}

export default defineProvider(
  vercelCapabilities,
  ({ config, resolveSnapshotId }: VercelProviderConfig) => ({
    name: "vercel",
    signedUrlTtlSeconds: VERCEL_URL_TTL_S,
    userHomeDir: VERCEL_HOME_DIR,

    sandbox: {
      create: (ctx, input) => createVercelSandbox(ctx, config, input),
      delete: (id) => deleteVercelSandbox(config, id),

      start: (id, autoStopInterval) =>
        startVercelSandbox(config, id, autoStopInterval),
      stop: (id) => stopVercelSandbox(config, id),
      getState: (id) => getVercelSandboxState(config, id),
      mapState: mapVercelSandboxState,
    },

    // No `cloneRepo` override: Vercel has no first-class git primitive, so
    // `Sandbox.git` is `null` and the provisioning layer clones by running
    // shell `git` over the adapter exec port.

    // A Vercel microVM restores its filesystem but NOT its processes on resume,
    // so the running services die; persist the context Vercel's `onResume`
    // (`restartVercelServicesOnResume`) reads to re-run the start hooks. Only
    // Vercel authors this — Daytona/Freestyle omit it (their processes survive a
    // stop/restart), so the concept never touches the shared contract.
    persistServiceRestartContext: async (id, context) => {
      const adapter = await openVercelAdapter(config, id);
      await writeVercelResumeContext(adapter, context);
    },

    // Streaming is real (the SDK's incremental `command.logs()`), so `stream`
    // is provided and `exec.streaming` derives to true.
    exec: {
      stdin: true,
      run: (id, command, opts) =>
        executeVercelCommand(config, id, command, opts),
      stream: (id, command, handlers) =>
        streamVercelCommandLogs(config, id, command, handlers),
    },

    files: {
      read: (id, filePath) => readVercelFile(config, id, filePath),
      write: (id, filePath, content) =>
        writeVercelFile(config, id, filePath, content),
    },

    services: {
      refreshUrls: (id, services) => refreshVercelUrls(config, id, services),
      syncRoutes: (id, desired) => syncVercelRoutes(config, id, desired),
    },

    listing: {
      list: () => listVercelSandboxes(config),
    },

    snapshots: {
      // Vercel snapshots are id-only: the by-name methods resolve the
      // org-scoped name→id mapping through the injected resolver before
      // hitting the id-keyed SDK (see `./internal/snapshot-lookup`). The resolver-backed
      // lookup surfaces a snapshot in any recorded state, so the default
      // `findSnapshot` → `getSnapshot` fallback resolves identically.
      getSnapshot: (name) =>
        getVercelSnapshotByName(resolveSnapshotId, config, name),
      deleteSnapshot: (name, providerSnapshotId) =>
        deleteVercelSnapshotByName(
          resolveSnapshotId,
          config,
          name,
          providerSnapshotId,
        ),
      waitForSnapshotActive: (name, providerSnapshotId) =>
        waitForVercelSnapshotActive(
          resolveSnapshotId,
          config,
          name,
          providerSnapshotId,
        ),
      // Non-destructive (keep-source) capture is unsupported: a sandbox is
      // created with `keepLastSnapshots: { count: 1 }`, so a kept-alive
      // source's next stop/idle auto-snapshot would evict a snapshot captured
      // here, and the SDK exposes no way to pin one. Only the destructive
      // delete-intent capture is offered (the caller deletes the source right
      // after, so no auto-snapshot can evict it); see `./internal/snapshot-capture`.
      capture: (id, _snapshotName, opts) => {
        if (opts.keepSourceRunning) {
          throw new SandboxProviderUnsupportedError("vercel", "capture");
        }
        return captureVercelSnapshot(config, id);
      },
      // The one provider-owned injected secret: the resume-context file,
      // written by Vercel's own create/resume hooks and carrying the source
      // sandbox's OpenCode server password. Removed here so the
      // core-synthesized scrub — which only knows the Amika target list —
      // can't leave it in a capture.
      removeInjectedSecrets: (id) => removeVercelInjectedSecrets(config, id),
      // Vercel never bakes Amika secrets into an un-scrubbable container env
      // spec — injected env vars live only in `/etc/environment`, which the
      // scrub removes — so every Vercel sandbox is scrub-safe.
      isEnvScrubbable: () => Promise.resolve(true),
    },
  }),
);
