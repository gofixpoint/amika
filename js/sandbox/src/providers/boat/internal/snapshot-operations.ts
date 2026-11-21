/**
 * Snapshots as boat saved snapshots (https://docs.boat.dev/snapshots.md).
 *
 * A saved snapshot holds the sandbox's disk; boat never saves memory or
 * running programs, so a scrub before capture removes the secrets for good.
 * Saving works on a running sandbox, which keeps running.
 *
 * Saved snapshots are addressed by name, which follows boat's rules
 * (`./names.ts`). The bootable handle is that name: create passes it as
 * `from`.
 */
import { z } from "zod";
import type { CapturedSnapshot, ProviderSnapshot } from "../../provider";
import type { BoatConfig } from "../config";
import { isNotFound, requestJson, send } from "./client";
import { boatSnapshotName } from "./names";
import { runBoatScript } from "./shell";

const savedSnapshotSchema = z.object({
  name: z.string(),
  status: z.string(),
  error: z.string().nullish(),
  sizeBytes: z.number().nullish(),
  createdAt: z.string().nullish(),
});
type BoatSavedSnapshot = z.infer<typeof savedSnapshotSchema>;

const snapshotResponseSchema = z.object({ snapshot: savedSnapshotSchema });

const SNAPSHOT_READY_TIMEOUT_MS = 20 * 60_000;
const SNAPSHOT_POLL_INTERVAL_MS = 3_000;

export function mapBoatSnapshotStatus(status: string): string {
  switch (status) {
    case "ready":
      return "active";
    case "saving":
      return "building";
    case "failed":
      return "build_failed";
    default:
      return status;
  }
}

function toProviderSnapshot(
  name: string,
  snapshot: BoatSavedSnapshot,
): ProviderSnapshot {
  return {
    name,
    providerSnapshotId: snapshot.name,
    state: mapBoatSnapshotStatus(snapshot.status),
    errorReason: snapshot.error ?? null,
    size: snapshot.sizeBytes ?? null,
    createdAt: snapshot.createdAt ?? undefined,
  };
}

function savedPath(boatName: string): string {
  return `/saved-snapshots/${encodeURIComponent(boatName)}`;
}

async function getSaved(
  config: BoatConfig,
  boatName: string,
): Promise<BoatSavedSnapshot | null> {
  try {
    return (
      await requestJson(
        config,
        snapshotResponseSchema,
        "GET",
        savedPath(boatName),
      )
    ).snapshot;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function getBoatSnapshot(
  config: BoatConfig,
  name: string,
): Promise<ProviderSnapshot | null> {
  const saved = await getSaved(config, boatSnapshotName(name));
  return saved ? toProviderSnapshot(name, saved) : null;
}

export async function deleteBoatSnapshot(
  config: BoatConfig,
  name: string,
  providerSnapshotId?: string | null,
): Promise<void> {
  try {
    const res = await send(
      config,
      "DELETE",
      savedPath(providerSnapshotId ?? boatSnapshotName(name)),
    );
    await res.body?.cancel();
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

export async function waitForBoatSnapshotReady(
  config: BoatConfig,
  name: string,
  providerSnapshotId?: string | null,
  timeoutMs: number = SNAPSHOT_READY_TIMEOUT_MS,
): Promise<ProviderSnapshot> {
  const boatName = providerSnapshotId ?? boatSnapshotName(name);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const saved = await getSaved(config, boatName);
    if (saved?.status === "ready") return toProviderSnapshot(name, saved);
    if (saved?.status === "failed") {
      throw new Error(
        `boat snapshot "${boatName}" failed` +
          (saved.error ? `: ${saved.error}` : ""),
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `boat snapshot "${boatName}" was not ready within ` +
          `${Math.round(timeoutMs / 1000)}s ` +
          (saved ? `(last status: "${saved.status}")` : "(not found)"),
      );
    }
    await new Promise((r) => setTimeout(r, SNAPSHOT_POLL_INTERVAL_MS));
  }
}

/** Save the sandbox's disk as a snapshot named after `name`. */
export async function captureBoatSnapshot(
  config: BoatConfig,
  sandboxId: string,
  name: string,
): Promise<CapturedSnapshot> {
  await runBoatScript(config, sandboxId, "sync").catch(() => undefined);
  const boatName = boatSnapshotName(name);
  await requestJson(
    config,
    snapshotResponseSchema,
    "POST",
    "/saved-snapshots",
    {
      json: { sandboxId, name: boatName },
    },
  );
  return { providerSnapshotId: boatName };
}
