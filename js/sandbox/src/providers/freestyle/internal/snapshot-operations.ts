/**
 * Snapshot operations against the Freestyle VM API.
 *
 * Freestyle captures a snapshot from a VM with `vm.snapshot({ name, ... })`,
 * which returns an opaque `snapshotId`; the *name* is an optional, mutable label
 * that is NOT a primary key. To slot into Amika's name-keyed snapshot model
 * (where the org-scoped name identifies the snapshot and every consumer
 * addresses snapshots by it), we always capture with the org-scoped name and
 * look snapshots up by scanning `vms.snapshots.list()` for that name. Names are
 * unique within Amika's usage (enforced by the caller plus name-reuse refusal),
 * so the scan resolves to a single snapshot in practice.
 *
 * Lookups/deletes are therefore O(account snapshot list) rather than a direct
 * get — acceptable for these infrequent control operations (capture, delete,
 * activation poll), and the list is the only by-name access the API offers.
 *
 * Snapshot deletion uses the `DELETE /v1/vms/snapshots/{id}` endpoint via the
 * SDK's public `fetch` (the typed `VmSnapshotsNamespace` surface in
 * freestyle@0.1.63 exposes only `list`/`get`; the delete route is present at
 * runtime but undeclared, so we call it through `fetch`, which resolves the
 * relative path against the base URL and attaches the API key).
 */
import { createFreestyleClient } from "./client";
import { getFreestyleSandboxState } from "./operations";
import type { CapturedSnapshot, ProviderSnapshot } from "../../provider";
import type { Freestyle } from "freestyle";
import type { FreestyleConfig } from "../config";
import { withStepContext } from "../../../util/errorutils";

// `VmSnapshot` is not a named export of `freestyle`; derive the record type from
// the client surface so we don't restate it (and stay pinned to the SDK shape).
type FreestyleVmSnapshot = Awaited<
  ReturnType<Freestyle["vms"]["snapshots"]["list"]>
>["snapshots"][number];

/**
 * How long to wait for a freshly captured Freestyle snapshot to reach `ready`,
 * in seconds. `vm.snapshot` returns once the capture is registered; the
 * snapshot then builds asynchronously, which for large filesystems takes
 * minutes. Mirrors the Daytona activation window so the background-capture
 * lifecycle behaves the same across providers.
 */
const FREESTYLE_SNAPSHOT_ACTIVE_TIMEOUT_S = 10 * 60;

/** Poll cadence for {@link waitForFreestyleSnapshotActive}. */
const FREESTYLE_SNAPSHOT_POLL_INTERVAL_MS = 2_000;

/**
 * Build the `vm.snapshot()` body for a user-generated snapshot.
 *
 * Freestyle's default snapshot persistence tier is `sticky` — a best-effort
 * cache the platform may evict under storage pressure, which would silently
 * destroy a snapshot the user deliberately saved. User-generated snapshots must
 * survive until the user deletes them, so production captures them as
 * `persistent` (retained indefinitely), mirroring the preset builder in
 * `bin/freestyle-build-snapshots.mjs`. The tier is taken from
 * `config.snapshotPersistence`: staging sets `"sticky"` (via
 * `FREESTYLE_STAGING_SNAPSHOTS`) so throwaway staging snapshots don't accumulate
 * permanent storage; an unset config defaults to the safe `"persistent"` tier.
 *
 * The SDK's typed `snapshot()` signature documents only `{ name }`, but the
 * runtime forwards the whole body to `POST /v1/vms/{vm_id}/snapshot`, which
 * accepts `persistence` (the same tiers as `vms.create`). The return type keeps
 * the extra field so the structural-typed call site type-checks while still
 * sending it on the wire.
 */
function snapshotOptions(
  config: FreestyleConfig,
  name: string,
): {
  name: string;
  persistence: { type: "persistent" | "sticky" };
} {
  return {
    name,
    persistence: { type: config.snapshotPersistence ?? "persistent" },
  };
}

/**
 * Normalize a Freestyle snapshot state onto the provider-agnostic vocabulary
 * consumers reconcile against (`active` / `building` / terminal).
 * Freestyle: `ready` is durable; `building` is in flight; `failed`/`cancelled`/
 * `lost` are terminal. `build_failed`/`error` are both treated as terminal by
 * consumers, so the exact terminal label is informational only.
 */
function mapFreestyleSnapshotState(
  state: string | undefined,
): string | undefined {
  switch (state) {
    case "ready":
      return "active";
    case "building":
      return "building";
    case "failed":
    case "cancelled":
      return "build_failed";
    case "lost":
      return "error";
    default:
      return state;
  }
}

function isTerminalFreestyleState(state: string | undefined): boolean {
  return state === "failed" || state === "cancelled" || state === "lost";
}

function toProviderSnapshot(snap: FreestyleVmSnapshot): ProviderSnapshot {
  return {
    // Our snapshots always carry the org-scoped name; fall back to the id only
    // for the degenerate case of a name-less snapshot so the field stays a
    // non-empty string (the API schema requires `name: string`).
    name: snap.name ?? snap.snapshotId,
    // The bootable handle, so a live lookup can backfill a row whose capture
    // never recorded `provider_snapshot_id` (`vms.create({ snapshotId })`).
    providerSnapshotId: snap.snapshotId,
    state: mapFreestyleSnapshotState(snap.state),
    createdAt: snap.createdAt,
    updatedAt: snap.updatedAt ?? undefined,
  };
}

/**
 * List every non-deleted snapshot, including in-flight and terminal ones, so a
 * by-name scan can surface a snapshot in any lifecycle state (the service needs
 * to see `building`/terminal states to reconcile in-flight rows). Deleted
 * snapshots are excluded (the API default) so a freed name reads as absent.
 */
async function listFreestyleSnapshots(
  client: Freestyle,
): Promise<FreestyleVmSnapshot[]> {
  const { snapshots } = await client.vms.snapshots.list({
    includeFailed: true,
    includeBuilding: true,
    includeCancelled: true,
    includeLost: true,
  });
  return snapshots;
}

/**
 * Find the snapshot record carrying `name`, preferring a `ready` one and then
 * the most recently created. Returns `null` when no non-deleted snapshot has
 * the name. (Amika never creates two live snapshots under one name, so the
 * preference rules only matter for degraded/leftover states.)
 */
function pickSnapshotByName(
  snapshots: FreestyleVmSnapshot[],
  name: string,
): FreestyleVmSnapshot | null {
  const matches = snapshots.filter((s) => s.name === name && !s.deleted);
  if (matches.length === 0) return null;
  const ready = matches.filter((s) => s.state === "ready");
  const pool = ready.length > 0 ? ready : matches;
  return pool.reduce((latest, s) =>
    new Date(s.createdAt).getTime() > new Date(latest.createdAt).getTime()
      ? s
      : latest,
  );
}

/**
 * Look up a snapshot by its org-scoped name, mapped onto the provider-agnostic
 * shape. Returns `null` when absent. Freestyle has no get-by-name, so this (and
 * `find`, which is identical here) scans the snapshot list.
 */
export async function getFreestyleSnapshotByName(
  config: FreestyleConfig,
  name: string,
): Promise<ProviderSnapshot | null> {
  const client = createFreestyleClient(config);
  const rec = pickSnapshotByName(await listFreestyleSnapshots(client), name);
  return rec ? toProviderSnapshot(rec) : null;
}

/**
 * Resolve a snapshot reference to a bootable snapshot id. Freestyle preset
 * references are deterministic **names** (`amika-<preset>-<size>`, see
 * {@link buildFreestyleSnapshotName}); captured-snapshot references arrive
 * already resolved to ids by `create.ts`. If a snapshot carries `ref` as its
 * name (preferring `ready`), return that snapshot's id; otherwise return `ref`
 * unchanged — it is already an id, or a name with no built snapshot (the caller
 * surfaces a clear error for the latter). Costs one snapshot-list scan, far
 * cheaper than the post-create `vm.resize` it replaces.
 */
export async function resolveFreestyleSnapshotRef(
  config: FreestyleConfig,
  ref: string,
): Promise<string> {
  const byName = await getFreestyleSnapshotByName(config, ref);
  return byName?.providerSnapshotId ?? ref;
}

/**
 * Delete every non-deleted snapshot carrying `name`. Idempotent: no matches is
 * a no-op, and an already-deleted snapshot (404) is tolerated. Deleting all
 * matches fully frees the name even in the (unexpected) event of duplicates.
 */
export async function deleteFreestyleSnapshotByName(
  config: FreestyleConfig,
  name: string,
): Promise<void> {
  const client = createFreestyleClient(config);
  const matches = (await listFreestyleSnapshots(client)).filter(
    (s) => s.name === name && !s.deleted,
  );
  for (const snap of matches) {
    const res = await client.fetch(
      `/v1/vms/snapshots/${encodeURIComponent(snap.snapshotId)}`,
      { method: "DELETE" },
    );
    if (!res.ok && res.status !== 404) {
      throw new Error(
        `Failed to delete Freestyle snapshot "${name}" (${snap.snapshotId}): ` +
          `${res.status} ${res.statusText}`,
      );
    }
  }
}

/**
 * Block until the snapshot named `name` reaches `ready`. Throws on a terminal
 * state (`failed`/`cancelled`/`lost`) or when the timeout elapses without it
 * becoming ready. Tolerates the snapshot being briefly absent from the list
 * right after capture.
 */
export async function waitForFreestyleSnapshotActive(
  config: FreestyleConfig,
  name: string,
  timeoutS: number = FREESTYLE_SNAPSHOT_ACTIVE_TIMEOUT_S,
): Promise<ProviderSnapshot> {
  const client = createFreestyleClient(config);
  const deadline = Date.now() + timeoutS * 1000;
  for (;;) {
    const rec = pickSnapshotByName(await listFreestyleSnapshots(client), name);
    if (rec?.state === "ready") {
      return toProviderSnapshot(rec);
    }
    if (rec && isTerminalFreestyleState(rec.state)) {
      throw new Error(
        `Snapshot "${name}" entered terminal state "${rec.state}"`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Snapshot "${name}" did not become ready within ${timeoutS}s ` +
          (rec
            ? `(last state: "${rec.state}")`
            : "(never appeared in the snapshot list)"),
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, FREESTYLE_SNAPSHOT_POLL_INTERVAL_MS),
    );
  }
}

/**
 * Capture a snapshot of the VM as it stands under `name` (the spec-018 raw
 * capture primitive — any scrub already ran above in core). Returns the
 * snapshot id so the caller can persist it as the bootable handle (a sandbox
 * is later created from this id via `vms.create`).
 *
 * Captures the VM *while it is still running* — Freestyle's API returns
 * `INTERNAL_ERROR` (500) when snapshotting a `stopped` VM (KAPRO-482) — so
 * `keepSourceRunning` needs no branch at this layer; the destructive caller
 * deletes the source afterward itself.
 *
 * SECURITY CAVEAT: a Freestyle snapshot of a running VM is a "live" snapshot
 * that includes RAM and CPU state, and a VM created from it resumes that
 * memory (Freestyle docs: "restoring the entire saved memory image"). A disk
 * scrub run before this capture removes the injected credential files and
 * managed env, but secrets already loaded into memory (the OpenCode server's
 * API keys, an agent's process environment, page cache of the scrubbed files)
 * survive the image and come back when it is cloned. Acceptable for the
 * current dev-gated, org-scoped Freestyle usage (a snapshot only boots within
 * its owning org); the robust cold, disk-only capture is blocked until
 * Freestyle supports snapshotting a stopped VM (KAPRO-482).
 */
export async function captureFreestyleSandboxSnapshot(
  config: FreestyleConfig,
  providerSandboxId: string,
  name: string,
): Promise<CapturedSnapshot> {
  const client = createFreestyleClient(config);
  const vm = client.vms.ref({ vmId: providerSandboxId });
  const { snapshotId } = await captureStep(config, providerSandboxId, () =>
    vm.snapshot(snapshotOptions(config, name)),
  );
  return { providerSnapshotId: snapshotId };
}

/**
 * Run the snapshot call, re-throwing a failure tagged with the VM's last-known
 * state. Freestyle surfaces opaque `INTERNAL_ERROR` 500s carrying only a
 * provider trace id, so without this an operator can't correlate the failure
 * with the VM state. The VM-state read runs only on failure (the lazy
 * {@link withStepContext} label) and degrades to "unknown" rather than masking
 * the original error, which is preserved as `cause`.
 */
function captureStep<T>(
  config: FreestyleConfig,
  providerSandboxId: string,
  run: () => Promise<T>,
): Promise<T> {
  return withStepContext(async () => {
    const state = await getFreestyleSandboxState(
      config,
      providerSandboxId,
    ).catch(() => "unknown");
    return `Freestyle snapshot capture failed at the "snapshot" step (VM state: "${state}")`;
  }, run);
}
