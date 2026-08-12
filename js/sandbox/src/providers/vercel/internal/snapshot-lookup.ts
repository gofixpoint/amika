/**
 * Snapshot lookup (the query path) against the Vercel Sandbox API.
 *
 * Vercel snapshots are addressable only by an opaque `snapshotId` (`snap_…`) —
 * they carry NO name or label. Amika's snapshot model, however, is name-keyed:
 * every consumer (`getSnapshot`/`deleteSnapshot`/`waitForSnapshotActive`)
 * addresses a snapshot by its org-scoped name (`{orgId}/sandbox/{slug}`).
 *
 * We bridge the two through an injected {@link SnapshotIdResolver}: the caller
 * owns the name↔id mapping (recorded when a capture completes), so a by-name
 * lookup resolves the name to its id via the resolver and then hits the id-keyed
 * SDK (`Snapshot.get` / `snapshot.delete`). This keeps the shared
 * `SnapshotCapability` interface unchanged (Daytona/Freestyle keep their own
 * by-name provider access) while accommodating Vercel's id-only API — and keeps
 * this module free of any storage coupling. The write/capture side lives
 * alongside in `./snapshot-capture`; the resolver is injected by the caller.
 */
import { APIError, Snapshot } from "@vercel/sandbox";
import { vercelCredentials } from "./client";
import type { ProviderSnapshot, SnapshotIdResolver } from "../../provider";
import type { VercelConfig } from "../config";

/**
 * How long to wait for a freshly captured Vercel snapshot to reach `created`,
 * in seconds. `sandbox.snapshot()` resolves once the snapshot exists, so this is
 * usually satisfied on the first poll; the window exists only to tolerate a
 * snapshot that briefly reads back as not-yet-`created`. Mirrors the
 * Freestyle/Daytona activation windows so the background-capture lifecycle
 * behaves the same across providers.
 */
const VERCEL_SNAPSHOT_ACTIVE_TIMEOUT_S = 10 * 60;

/** Poll cadence for {@link waitForVercelSnapshotActive}. */
const VERCEL_SNAPSHOT_POLL_INTERVAL_MS = 2_000;

/**
 * Normalize a Vercel snapshot status onto the provider-agnostic vocabulary
 * consumers reconcile against (`active` / terminal). Vercel: `created`
 * is durable and bootable; `failed` is terminal; `deleted` is treated as absent
 * by callers (this maps it to `error` for the rare case a lookup surfaces a
 * `deleted` record). Vercel has no in-flight "building" status — `snapshot()`
 * returns a `created` snapshot synchronously — so there is no `building` mapping.
 */
export function mapVercelSnapshotStatus(
  status: string | undefined,
): string | undefined {
  switch (status) {
    case "created":
      return "active";
    case "failed":
      return "build_failed";
    case "deleted":
      return "error";
    default:
      return status;
  }
}

function toProviderSnapshot(name: string, snap: Snapshot): ProviderSnapshot {
  return {
    name,
    // The bootable handle (`snap_…`), so a live lookup can backfill a row whose
    // capture never recorded `provider_snapshot_id`
    // (`Sandbox.create({ source: { type: "snapshot", snapshotId } })`).
    providerSnapshotId: snap.snapshotId,
    state: mapVercelSnapshotStatus(snap.status),
    createdAt: snap.createdAt,
    updatedAt: snap.updatedAt,
    size: snap.sizeBytes,
  };
}

/**
 * Fetch the live snapshot for a `snap_…` id, or `null` when it is genuinely
 * absent (a 404 — deleted / never existed), which we translate to `null` so
 * callers don't couple to provider-specific not-found errors (matching the
 * `SnapshotCapability.getSnapshot` contract).
 *
 * ONLY a 404 becomes `null`. A transient 5xx / auth / network failure is
 * rethrown: callers read `null` as "the snapshot is gone" — `getSnapshot`
 * reports it absent and `deleteSnapshot` removes the caller's record WITHOUT
 * deleting the provider snapshot — so swallowing a transient error would orphan
 * the user's Vercel snapshot. Failing loud lets the caller retry instead.
 */
async function getVercelSnapshotById(
  config: VercelConfig,
  snapshotId: string,
): Promise<Snapshot | null> {
  try {
    return await Snapshot.get({ ...vercelCredentials(config), snapshotId });
  } catch (err) {
    if (err instanceof APIError && err.response.status === 404) {
      return null;
    }
    throw err;
  }
}

/**
 * Look up a snapshot by its org-scoped name, mapped onto the provider-agnostic
 * shape. Returns `null` when the name has no recorded id, or when the provider no
 * longer has the snapshot. Vercel has no by-name provider access, so this resolves
 * the name→id via the injected {@link SnapshotIdResolver} first, then does an
 * id-keyed get.
 */
export async function getVercelSnapshotByName(
  resolveSnapshotId: SnapshotIdResolver,
  config: VercelConfig,
  name: string,
): Promise<ProviderSnapshot | null> {
  const snapshotId = await resolveSnapshotId(name);
  if (!snapshotId) {
    return null;
  }
  const snap = await getVercelSnapshotById(config, snapshotId);
  return snap ? toProviderSnapshot(name, snap) : null;
}

/**
 * Delete the snapshot carrying `name`. Idempotent: a name with no recorded id is
 * a no-op (nothing to delete), and a snapshot already gone from the provider is
 * tolerated (`Snapshot.get` returns `null`, so there is nothing to `delete`). The
 * caller's own record is removed elsewhere, not here.
 *
 * `providerSnapshotId` short-circuits the resolver: a caller holding the handle
 * from a fresh capture (a bound `Snapshot.delete()`) can delete before the
 * name↔id mapping has been recorded.
 */
export async function deleteVercelSnapshotByName(
  resolveSnapshotId: SnapshotIdResolver,
  config: VercelConfig,
  name: string,
  providerSnapshotId?: string | null,
): Promise<void> {
  const snapshotId = providerSnapshotId ?? (await resolveSnapshotId(name));
  if (!snapshotId) {
    return;
  }
  const snap = await getVercelSnapshotById(config, snapshotId);
  if (!snap) {
    return;
  }
  await snap.delete();
}

/**
 * Block until the snapshot named `name` reaches `created`. Throws on a terminal
 * status (`failed`/`deleted`) or when the timeout elapses without it becoming
 * durable. Tolerates the row briefly lacking a recorded id right after capture
 * (the background capture records `provider_snapshot_id` around the same time it
 * transitions the row), retrying until the id resolves or the deadline passes.
 *
 * `providerSnapshotId` short-circuits the resolver: a caller holding the handle
 * from a fresh capture (a bound `Snapshot.waitForActive()`) can wait before the
 * name↔id mapping has been recorded.
 */
export async function waitForVercelSnapshotActive(
  resolveSnapshotId: SnapshotIdResolver,
  config: VercelConfig,
  name: string,
  providerSnapshotId?: string | null,
  timeoutS: number = VERCEL_SNAPSHOT_ACTIVE_TIMEOUT_S,
): Promise<ProviderSnapshot> {
  const deadline = Date.now() + timeoutS * 1000;
  for (;;) {
    const snapshotId = providerSnapshotId ?? (await resolveSnapshotId(name));
    const snap = snapshotId
      ? await getVercelSnapshotById(config, snapshotId)
      : null;
    if (snap?.status === "created") {
      return toProviderSnapshot(name, snap);
    }
    if (snap && (snap.status === "failed" || snap.status === "deleted")) {
      throw new Error(
        `Snapshot "${name}" entered terminal status "${snap.status}"`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Snapshot "${name}" did not become ready within ${timeoutS}s ` +
          (snap
            ? `(last status: "${snap.status}")`
            : "(no bootable snapshot id was recorded)"),
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, VERCEL_SNAPSHOT_POLL_INTERVAL_MS),
    );
  }
}
