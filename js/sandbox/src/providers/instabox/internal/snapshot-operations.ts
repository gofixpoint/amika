/**
 * Snapshot operations (https://instabox.sh/docs/api/snapshots.md).
 *
 * An Instabox snapshot holds a machine's disks: the installed software and
 * `/data`. It holds no memory and no running programs, so a scrub before the
 * capture removes the secrets for good. A running machine is saved while it
 * runs and stays running.
 *
 * The bootable handle is the snapshot id (`sn_…`). Names are unique per
 * account, but `GET /v1/snapshots/{id}` takes only an id, so a by-name lookup
 * scans `GET /v1/snapshots`. Amika names go through {@link instaboxName}.
 */
import { z } from "zod";
import type { CapturedSnapshot, ProviderSnapshot } from "../../provider";
import type { InstaboxConfig } from "../config";
import { isNotFound, machinePath, requestJson, requestVoid } from "./client";
import { execInstabox } from "./exec";
import { instaboxName } from "./names";

const snapshotSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  createdAt: z.string().optional(),
  dataSizeBytes: z.number().optional(),
  rootSizeBytes: z.number().optional(),
});
type InstaboxSnapshot = z.infer<typeof snapshotSchema>;

const snapshotListSchema = z.object({ snapshots: z.array(snapshotSchema) });

/** How long a capture may take to become `ready`. */
const SNAPSHOT_READY_TIMEOUT_MS = 10 * 60_000;
const SNAPSHOT_POLL_INTERVAL_MS = 2_000;

/** Map an Instabox snapshot status to the provider-agnostic state. */
export function mapInstaboxSnapshotStatus(status: string): string {
  switch (status) {
    case "ready":
      return "active";
    case "pending":
      return "building";
    case "failed":
      return "build_failed";
    default:
      return status;
  }
}

function toProviderSnapshot(
  name: string,
  snapshot: InstaboxSnapshot,
): ProviderSnapshot {
  return {
    name,
    providerSnapshotId: snapshot.id,
    state: mapInstaboxSnapshotStatus(snapshot.status),
    size:
      snapshot.dataSizeBytes !== undefined ||
      snapshot.rootSizeBytes !== undefined
        ? (snapshot.dataSizeBytes ?? 0) + (snapshot.rootSizeBytes ?? 0)
        : null,
    createdAt: snapshot.createdAt,
  };
}

async function listInstaboxSnapshots(
  config: InstaboxConfig,
): Promise<InstaboxSnapshot[]> {
  return (await requestJson(config, snapshotListSchema, "GET", "/snapshots"))
    .snapshots;
}

/** The account's snapshot whose Instabox name is exactly `rawName`. */
export async function findInstaboxSnapshotByRawName(
  config: InstaboxConfig,
  rawName: string,
): Promise<InstaboxSnapshot | null> {
  const snapshots = await listInstaboxSnapshots(config);
  return snapshots.find((s) => s.name === rawName) ?? null;
}

async function getInstaboxSnapshotById(
  config: InstaboxConfig,
  id: string,
): Promise<InstaboxSnapshot | null> {
  try {
    return await requestJson(
      config,
      snapshotSchema,
      "GET",
      `/snapshots/${encodeURIComponent(id)}`,
    );
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** Look up a snapshot by its Amika name; `null` when absent. */
export async function getInstaboxSnapshotByName(
  config: InstaboxConfig,
  name: string,
): Promise<ProviderSnapshot | null> {
  const snapshot = await findInstaboxSnapshotByRawName(
    config,
    instaboxName(name),
  );
  return snapshot ? toProviderSnapshot(name, snapshot) : null;
}

/** The snapshot for `name`, by id when the caller has it, else by name. */
async function resolveSnapshot(
  config: InstaboxConfig,
  name: string,
  providerSnapshotId?: string | null,
): Promise<InstaboxSnapshot | null> {
  if (providerSnapshotId) {
    return getInstaboxSnapshotById(config, providerSnapshotId);
  }
  return findInstaboxSnapshotByRawName(config, instaboxName(name));
}

/** Delete a snapshot. A missing snapshot is a no-op. */
export async function deleteInstaboxSnapshot(
  config: InstaboxConfig,
  name: string,
  providerSnapshotId?: string | null,
): Promise<void> {
  const snapshot = await resolveSnapshot(config, name, providerSnapshotId);
  if (!snapshot) return;
  try {
    await requestVoid(
      config,
      "DELETE",
      `/snapshots/${encodeURIComponent(snapshot.id)}`,
      { idempotent: true, headers: { "X-Confirm-Delete": snapshot.id } },
    );
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

/** Wait until the snapshot is `ready`. Throws when it fails or times out. */
export async function waitForInstaboxSnapshotReady(
  config: InstaboxConfig,
  name: string,
  providerSnapshotId?: string | null,
  timeoutMs: number = SNAPSHOT_READY_TIMEOUT_MS,
): Promise<ProviderSnapshot> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = await resolveSnapshot(config, name, providerSnapshotId);
    if (snapshot?.status === "ready") return toProviderSnapshot(name, snapshot);
    if (snapshot?.status === "failed") {
      throw new Error(`Instabox snapshot "${name}" (${snapshot.id}) failed`);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Instabox snapshot "${name}" was not ready within ` +
          `${Math.round(timeoutMs / 1000)}s ` +
          (snapshot ? `(last status: "${snapshot.status}")` : "(not found)"),
      );
    }
    await new Promise((r) => setTimeout(r, SNAPSHOT_POLL_INTERVAL_MS));
  }
}

/**
 * Save the machine's disks as snapshot `name`. A running machine stays
 * running, so `keepSourceRunning` needs no special case. We run `sync` first
 * so recent writes are on disk; a stopped machine has nothing to flush.
 */
export async function captureInstaboxSnapshot(
  config: InstaboxConfig,
  machineId: string,
  name: string,
): Promise<CapturedSnapshot> {
  await execInstabox(config, machineId, "sync").catch(() => undefined);
  const snapshot = await requestJson(
    config,
    snapshotSchema,
    "POST",
    machinePath(machineId, "/snapshots"),
    {
      idempotent: true,
      json: { name: instaboxName(name), description: name },
    },
  );
  return { providerSnapshotId: snapshot.id };
}
