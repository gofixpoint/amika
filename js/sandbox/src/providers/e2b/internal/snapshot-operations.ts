import { createHash } from "node:crypto";
import { Sandbox, type SnapshotInfo } from "e2b";
import type {
  CapturedSnapshot,
  ProviderSnapshot,
  SnapshotIdResolver,
} from "../../provider";
import type { E2bConfig } from "../config";
import { e2bApiOptions } from "./client";

export async function getE2bSnapshotByName(
  config: E2bConfig,
  name: string,
): Promise<ProviderSnapshot | null> {
  const providerName = e2bSnapshotName(name);
  const snapshots = await listE2bSnapshots(config, providerName);
  const snapshot = snapshots.find((item) =>
    snapshotHasName(item, providerName),
  );
  return snapshot ? toProviderSnapshot(name, snapshot) : null;
}

export async function deleteE2bSnapshotByName(
  resolveSnapshotId: SnapshotIdResolver,
  config: E2bConfig,
  name: string,
  providerSnapshotId?: string | null,
): Promise<void> {
  const id =
    providerSnapshotId ??
    (await resolveSnapshotId(name)) ??
    (await getE2bSnapshotByName(config, name))?.providerSnapshotId;
  if (id) await Sandbox.deleteSnapshot(id, e2bApiOptions(config));
}

export async function waitForE2bSnapshotActive(
  resolveSnapshotId: SnapshotIdResolver,
  config: E2bConfig,
  name: string,
  providerSnapshotId?: string | null,
): Promise<ProviderSnapshot> {
  const id =
    providerSnapshotId ??
    (await resolveSnapshotId(name)) ??
    (await getE2bSnapshotByName(config, name))?.providerSnapshotId;
  if (!id) throw new Error(`E2B snapshot "${name}" was not found`);
  return { name, providerSnapshotId: id, state: "active" };
}

export async function captureE2bSnapshot(
  config: E2bConfig,
  providerSandboxId: string,
  name: string,
): Promise<CapturedSnapshot> {
  const snapshot = await Sandbox.createSnapshot(providerSandboxId, {
    ...e2bApiOptions(config),
    name: e2bSnapshotName(name),
  });
  return { providerSnapshotId: snapshot.snapshotId };
}

async function listE2bSnapshots(
  config: E2bConfig,
  name: string,
): Promise<SnapshotInfo[]> {
  const paginator = Sandbox.listSnapshots({
    ...e2bApiOptions(config),
    name,
  });
  const snapshots: SnapshotInfo[] = [];
  while (paginator.hasNext) snapshots.push(...(await paginator.nextItems()));
  return snapshots;
}

function snapshotHasName(snapshot: SnapshotInfo, name: string): boolean {
  return snapshot.names.some((candidate) => {
    const withoutTag = candidate.split(":", 1)[0]!;
    return withoutTag === name || withoutTag.endsWith(`/${name}`);
  });
}

function e2bSnapshotName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 12);
  return `amika-${slug || "snapshot"}-${hash}`;
}

function toProviderSnapshot(
  name: string,
  snapshot: SnapshotInfo,
): ProviderSnapshot {
  return {
    name,
    providerSnapshotId: snapshot.snapshotId,
    state: "active",
  };
}
