import type { SnapshotIdResolver } from "../../provider";
import type { CapturedSnapshot, ProviderSnapshot } from "../../provider";
import type { SailboxConfig } from "../config";
import { getSailbox } from "./client";

const DEFAULT_CHECKPOINT_TTL_SECONDS = 365 * 24 * 60 * 60;

/** Sail checkpoints are synchronous; Amika's DB is their listing/index. */
export async function captureSailboxCheckpoint(
  config: SailboxConfig,
  providerSandboxId: string,
  name: string,
): Promise<CapturedSnapshot> {
  const box = await getSailbox(config, providerSandboxId);
  const checkpoint = await box.checkpoint({
    name,
    ttlSeconds: config.checkpointTtlSeconds ?? DEFAULT_CHECKPOINT_TTL_SECONDS,
  });
  return { providerSnapshotId: checkpoint.checkpointId };
}

/** Resolve only against Amika's database; Sail has no checkpoint list API. */
export async function getSailboxCheckpoint(
  resolveSnapshotId: SnapshotIdResolver,
  name: string,
  providerSnapshotId?: string | null,
): Promise<ProviderSnapshot | null> {
  const id = providerSnapshotId ?? (await resolveSnapshotId(name));
  return id ? activeCheckpoint(name, id) : null;
}

/** Provider deletion is deliberately a no-op; Amika deletes its DB row. */
export function deleteSailboxCheckpoint(): Promise<void> {
  return Promise.resolve();
}

export async function waitForSailboxCheckpointActive(
  resolveSnapshotId: SnapshotIdResolver,
  name: string,
  providerSnapshotId?: string | null,
): Promise<ProviderSnapshot> {
  const checkpoint = await getSailboxCheckpoint(
    resolveSnapshotId,
    name,
    providerSnapshotId,
  );
  if (!checkpoint) {
    throw new Error(`Snapshot "${name}" has no recorded Sail checkpoint id`);
  }
  return checkpoint;
}

function activeCheckpoint(name: string, id: string): ProviderSnapshot {
  return { name, providerSnapshotId: id, state: "active" };
}
