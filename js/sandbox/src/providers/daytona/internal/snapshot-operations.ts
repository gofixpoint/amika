/**
 * Snapshot management operations wrapping the Daytona SDK's snapshot service.
 *
 * Each function creates a fresh Daytona client, consistent with the
 * per-operation pattern used in operations.ts.
 */
import { DaytonaError, type Daytona } from "@daytonaio/sdk";
import {
  SANDBOX_ENV_SECRETS_EXCLUDED_LABEL,
  SANDBOX_ENV_SECRETS_EXCLUDED_VALUE,
} from "../../../constants";
import type { DaytonaConfig } from "../config";
import { createDaytonaClient } from "./client";
import { captureVmSandboxSnapshot, isVmSandbox } from "./vm";
import { startDockerForSnapshot, stopDockerForSnapshot } from "./configure";

type SnapshotService = Daytona["snapshot"];
type DaytonaSnapshot = Awaited<ReturnType<SnapshotService["get"]>>;
type PaginatedDaytonaSnapshots = Awaited<ReturnType<SnapshotService["list"]>>;

export interface CreateSnapshotInput {
  name: string;
  image: string;
  entrypoint?: string[];
  regionId?: string;
}

export async function createDaytonaSnapshot(
  config: DaytonaConfig,
  input: CreateSnapshotInput,
): Promise<DaytonaSnapshot> {
  const daytona = createDaytonaClient(config);
  return daytona.snapshot.create({
    name: input.name,
    image: input.image,
    entrypoint: input.entrypoint,
    regionId: input.regionId,
  });
}

export async function listDaytonaSnapshots(
  config: DaytonaConfig,
  page?: number,
  limit?: number,
): Promise<PaginatedDaytonaSnapshots> {
  const daytona = createDaytonaClient(config);
  return daytona.snapshot.list(page, limit);
}

export async function getDaytonaSnapshot(
  config: DaytonaConfig,
  snapshotName: string,
): Promise<DaytonaSnapshot> {
  const daytona = createDaytonaClient(config);
  return daytona.snapshot.get(snapshotName);
}

/**
 * Look up a snapshot by name, tolerating one that is still registering: uses
 * the list-scan fallback so a snapshot present in the list but not yet
 * addressable by a bare `get` is still found. Returns null when genuinely
 * absent. Use this (over `getDaytonaSnapshot`) when "does any snapshot occupy
 * this name?" must account for in-flight captures.
 */
export async function findDaytonaSnapshot(
  config: DaytonaConfig,
  snapshotName: string,
): Promise<DaytonaSnapshot | null> {
  const daytona = createDaytonaClient(config);
  return (await findDaytonaSnapshotByName(daytona, snapshotName)) ?? null;
}

export async function deleteDaytonaSnapshot(
  config: DaytonaConfig,
  snapshotName: string,
): Promise<void> {
  const daytona = createDaytonaClient(config);
  // Locate via the list-scan fallback rather than a bare get: a snapshot that
  // is still registering (e.g. a large capture that activated after our wait
  // timed out, leaving the row `failed`) can be absent from the by-name
  // lookup yet present in the list. A bare get would 404 here and the caller
  // would drop its record, leaving the snapshot to finish into an orphan the
  // listing can't reconcile. The scan finds and deletes it instead. A truly
  // absent snapshot is a no-op (already gone — callers then clean up refs).
  const snapshot = await findDaytonaSnapshotByName(daytona, snapshotName);
  if (!snapshot) return;
  await daytona.snapshot.delete(snapshot);
}

export async function activateDaytonaSnapshot(
  config: DaytonaConfig,
  snapshotName: string,
): Promise<DaytonaSnapshot> {
  const daytona = createDaytonaClient(config);
  const snapshot = await daytona.snapshot.get(snapshotName);
  return daytona.snapshot.activate(snapshot);
}

/**
 * Per-call timeout for `sandbox.createSnapshot`, in seconds.
 * The SDK default is 60s, which is far too tight for real sandboxes —
 * snapshotting a coder-sized image with node_modules / build caches
 * regularly takes several minutes, and captures exceeding 5 minutes
 * have been observed in practice. 15 minutes covers those while still
 * surfacing a genuinely stuck job.
 */
const SANDBOX_SNAPSHOT_TIMEOUT_S = 15 * 60;

/**
 * Capture a snapshot of a running Daytona sandbox (the spec-018 raw capture
 * primitive — scrubbing, if any, has already happened above in core).
 *
 * A `linux-vm` source is snapshotted *cold* via the api-client: the VM is
 * stopped, snapshotted with memory excluded, then restarted when the caller
 * keeps the source. A hot memory snapshot would resume a frozen network stack
 * on restore and break egress — see `captureVmSandboxSnapshot`. The snapshot
 * inherits the source's `linux-vm` class, so a sandbox later booted from it is
 * itself a VM. Branch on the sandbox's real class, not `useVm`: a container
 * created before the flag was enabled is still a container and takes the
 * container-snapshot path below.
 *
 * Container captures go through `sandbox.createSnapshot` on the ordinary
 * client. This used to require a client pinned to the `experimental` target,
 * the only one exposing the capture endpoint while
 * `_experimental_createSnapshot` was the sole entry point; the SDK graduated
 * the method in 0.202.0 and it is now served on the regular targets.
 *
 * Dropping that pinned client is safe because the capture request never
 * carried a target to begin with: it addresses the sandbox by id, and the
 * snapshot lands in the source sandbox's own region. `DaytonaConfig.target`
 * reaches only `daytona.create()` and the `regionId` default for
 * image-derived snapshots, neither of which is on this path.
 *
 * `keepSourceRunning: false` is delete-INTENT, not a guarantee: activation can
 * time out or the delete can fail, after which the source is retained and
 * released out of band. It therefore only relaxes keep-alive where a
 * retained source stays recoverable — the VM branch skips the power-restart (a
 * stopped VM is user-restartable via Start), while the container branch
 * ALWAYS restores dind in `finally`: a retained source must never come back
 * with Docker quiesced. The quiesce itself (stop dockerd before the capture
 * freezes the filesystem) only runs on the destructive path — a kept-alive
 * container capture snapshots hot, exactly as before.
 */
export async function captureDaytonaSandboxSnapshot(
  config: DaytonaConfig,
  providerSandboxId: string,
  snapshotName: string,
  opts: { keepSourceRunning: boolean },
): Promise<void> {
  if (config.useVm && (await isVmSandbox(config, providerSandboxId))) {
    await captureVmSandboxSnapshot(
      config,
      providerSandboxId,
      snapshotName,
      SANDBOX_SNAPSHOT_TIMEOUT_S,
      opts.keepSourceRunning,
    );
    return;
  }

  const daytona = createDaytonaClient(config);
  const sandbox = await daytona.get(providerSandboxId);
  const capture = () =>
    sandbox.createSnapshot(snapshotName, SANDBOX_SNAPSHOT_TIMEOUT_S);

  if (opts.keepSourceRunning) {
    await capture();
    return;
  }

  // Destructive container path: stop the Docker daemon and quiesce
  // /var/lib/docker just before capture. A dind snapshot taken with dockerd
  // live bakes in mid-flight overlay mounts / network state that stall dockerd
  // recovery on restore, tripping the image hook's 30s readiness wait when a
  // sandbox boots from this snapshot. No-op on non-dind sandboxes.
  await stopDockerForSnapshot(sandbox);
  try {
    await capture();
  } finally {
    // The capture has frozen the filesystem, so restarting the live daemon no
    // longer affects the snapshot. Bring Docker back unconditionally: if the
    // capture threw — or it succeeded but the caller's durability wait later
    // times out — the source sandbox is kept and restored to `active`, and
    // must not be left with its containers down. On the normal success path
    // the caller deletes the sandbox right after, so this is a harmless
    // fire-and-forget no-op.
    await startDockerForSnapshot(sandbox);
  }
}

/**
 * How long to wait for a freshly captured sandbox snapshot to become
 * `active`, in seconds. `sandbox.createSnapshot` resolves when the
 * *sandbox* finishes its capture phase; the snapshot itself registers and
 * activates asynchronously in the configured region afterward (image push +
 * validation), which for large filesystems takes minutes more — and the
 * snapshot may not even be addressable by name until that completes, so
 * the window has to cover the full push, not just a state transition.
 */
const SANDBOX_SNAPSHOT_ACTIVE_TIMEOUT_S = 10 * 60;

/**
 * How long to wait for a *reactivated* snapshot to return to `active`, in
 * seconds. Shorter than {@link SANDBOX_SNAPSHOT_ACTIVE_TIMEOUT_S}: reactivation
 * restores an already-built snapshot rather than pushing a freshly captured
 * image, and the wait runs inline inside `createDaytonaSandbox` (ahead of the
 * sandbox create), so it must stay well within the create budget.
 */
const SNAPSHOT_REACTIVATE_TIMEOUT_S = 5 * 60;

/** Poll cadence for `waitForDaytonaSnapshotActive`. */
const SNAPSHOT_ACTIVE_POLL_INTERVAL_MS = 2_000;

/** Page size for the list-scan fallback in `findDaytonaSnapshotByName`. */
const SNAPSHOT_LIST_PAGE_SIZE = 100;

/**
 * Look up `snapshotName` by direct name lookup, falling back to scanning
 * the paginated snapshot list. A freshly captured sandbox snapshot can be
 * invisible to the by-name lookup while it is still registering/building,
 * yet already present in the list — the fallback both finds it earlier
 * and lets the caller report its in-flight state instead of a bare 404.
 */
async function findDaytonaSnapshotByName(
  daytona: Daytona,
  snapshotName: string,
): Promise<DaytonaSnapshot | undefined> {
  try {
    return await daytona.snapshot.get(snapshotName);
  } catch (err) {
    if (!(err instanceof DaytonaError && err.statusCode === 404)) {
      throw err;
    }
  }
  for (let page = 1; ; page++) {
    const result = await daytona.snapshot.list(page, SNAPSHOT_LIST_PAGE_SIZE);
    const hit = result.items.find((s) => s.name === snapshotName);
    if (hit) {
      return hit;
    }
    if (page >= (result.totalPages ?? 1)) {
      return undefined;
    }
  }
}

/**
 * Block until `snapshotName` reaches the `active` state in the configured
 * region. Tolerates the snapshot being missing while polling — a snapshot
 * captured from a sandbox surfaces only some time after
 * `sandbox.createSnapshot` returns. Throws as soon as Daytona
 * reports a terminal failure (`error` / `build_failed`), or when the
 * timeout elapses without activation.
 *
 * Callers use this to gate destructive follow-ups (deleting the source
 * sandbox) on the snapshot actually being durable: deleting the sandbox
 * while its snapshot is still registering can kill the snapshot.
 */
export async function waitForDaytonaSnapshotActive(
  config: DaytonaConfig,
  snapshotName: string,
  timeoutS: number = SANDBOX_SNAPSHOT_ACTIVE_TIMEOUT_S,
): Promise<DaytonaSnapshot> {
  const daytona = createDaytonaClient(config);
  const deadline = Date.now() + timeoutS * 1000;
  for (;;) {
    const snapshot = await findDaytonaSnapshotByName(daytona, snapshotName);
    if (snapshot?.state === "active") {
      return snapshot;
    }
    if (snapshot?.state === "error" || snapshot?.state === "build_failed") {
      throw new Error(
        `Snapshot "${snapshotName}" entered terminal state "${snapshot.state}"` +
          (snapshot.errorReason ? `: ${snapshot.errorReason}` : ""),
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Snapshot "${snapshotName}" did not become active within ${timeoutS}s ` +
          (snapshot
            ? `(last state: "${snapshot.state}")`
            : "(never appeared in the snapshot list)"),
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, SNAPSHOT_ACTIVE_POLL_INTERVAL_MS),
    );
  }
}

/**
 * Ensure a snapshot is usable before a sandbox is booted from it, reactivating
 * it if Daytona has let it lapse.
 *
 * Daytona flips a snapshot to `inactive` after ~2 weeks without use
 * (https://www.daytona.io/docs/en/snapshots/), and `daytona.create({ snapshot })`
 * then rejects with "Snapshot <name> is inactive" rather than reactivating it —
 * reactivation is a separate, explicit step. So do it here: on an `inactive`
 * snapshot, activate it and wait for it to return to `active`, then let the
 * caller create from it.
 *
 * Best-effort and additive: a snapshot that is already `active` (the common
 * path) is a no-op, and an *API* failure to read the snapshot's state — a
 * missing snapshot (404) or a transient error — is swallowed so this never
 * turns a create that would have worked into a failure. `daytona.create`
 * remains the authority on a genuinely bad snapshot. A non-API error (e.g. an
 * unexpected client shape) still propagates rather than being masked, matching
 * the `instanceof DaytonaError` handling elsewhere in this module. Only a
 * positively-observed `inactive` state triggers work; an activation that then
 * fails does propagate (the create would have failed anyway).
 *
 * @returns whether the snapshot had to be reactivated (for logging/observability).
 */
export async function ensureDaytonaSnapshotActive(
  config: DaytonaConfig,
  snapshotName: string,
): Promise<boolean> {
  const daytona = createDaytonaClient(config);
  let snapshot: DaytonaSnapshot;
  try {
    snapshot = await daytona.snapshot.get(snapshotName);
  } catch (err) {
    // Swallow only the SDK's own API errors (missing/transient) so creation is
    // never blocked by a failed state read; anything else is a real bug and
    // should surface.
    if (err instanceof DaytonaError) return false;
    throw err;
  }
  if (snapshot.state !== "inactive") {
    return false;
  }
  await activateDaytonaSnapshot(config, snapshotName);
  // Reactivation only restores an already-built snapshot from cold storage, so
  // it gets a tighter bound than a fresh capture's image push
  // (`SANDBOX_SNAPSHOT_ACTIVE_TIMEOUT_S`): this wait runs inline in
  // `createDaytonaSandbox` ahead of the create itself, so an over-long wait
  // would stack on top of the create timeout.
  await waitForDaytonaSnapshotActive(
    config,
    snapshotName,
    SNAPSHOT_REACTIVATE_TIMEOUT_S,
  );
  return true;
}

/**
 * Whether a sandbox was created with secrets kept out of its container env
 * (marked by a label at create time). Sandboxes created before that change
 * have secrets baked into their container spec, which a snapshot cannot
 * scrub — so "snapshot and delete" must be refused for them.
 */
export async function isSandboxEnvScrubbable(
  config: DaytonaConfig,
  providerSandboxId: string,
): Promise<boolean> {
  const daytona = createDaytonaClient(config);
  const sandbox = await daytona.get(providerSandboxId);
  return (
    sandbox.labels?.[SANDBOX_ENV_SECRETS_EXCLUDED_LABEL] ===
    SANDBOX_ENV_SECRETS_EXCLUDED_VALUE
  );
}

function isDaytonaNotFound(err: unknown): boolean {
  return err instanceof DaytonaError && err.statusCode === 404;
}

/**
 * Create an image-derived snapshot, treating an already-existing name as
 * success: create is idempotent, so a concurrent/earlier registration of the
 * same name resolves to `null` rather than an error.
 */
export async function createDaytonaImageSnapshot(
  config: DaytonaConfig,
  input: CreateSnapshotInput,
): Promise<DaytonaSnapshot | null> {
  try {
    return await createDaytonaSnapshot(config, input);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("already exists") || message.includes("409")) {
      return null;
    }
    throw err;
  }
}

/** Get a snapshot by name, mapping Daytona's 404 to `null`. */
export async function getDaytonaSnapshotOrNull(
  config: DaytonaConfig,
  snapshotName: string,
): Promise<DaytonaSnapshot | null> {
  try {
    return await getDaytonaSnapshot(config, snapshotName);
  } catch (err) {
    if (isDaytonaNotFound(err)) return null;
    throw err;
  }
}

/** Delete a snapshot by name; one that is already gone is a no-op. */
export async function deleteDaytonaSnapshotIfExists(
  config: DaytonaConfig,
  snapshotName: string,
): Promise<void> {
  try {
    await deleteDaytonaSnapshot(config, snapshotName);
  } catch (err) {
    if (isDaytonaNotFound(err)) return;
    throw err;
  }
}
