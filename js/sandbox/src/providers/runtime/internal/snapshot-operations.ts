/**
 * Snapshots as Runtime image versions
 * (https://withruntime.com/docs/reference/snapshots.md).
 *
 * A plain Runtime snapshot keeps memory as well as disk, so secrets held by
 * running programs would survive a scrub. Capture instead passes `image`,
 * which keeps the **disk only**, as the next version of the named image.
 * The sandbox keeps running.
 *
 * The bootable handle is the image version's id, which create passes as
 * `image`. Image names follow `./names.ts`; a by-name lookup reads the
 * newest version.
 */
import { z } from "zod";
import type { CapturedSnapshot, ProviderSnapshot } from "../../provider";
import type { RuntimeConfig } from "../config";
import { isNotFound, requestJson, sandboxPath, send } from "./client";
import { runtimeImageName } from "./names";
import { runRuntimeScript } from "./shell";

const storedSchema = z.object({
  id: z.string(),
  name: z.string().nullish(),
  state: z.string(),
  sizeBytes: z.number().nullish(),
  createdAt: z.string().nullish(),
  error: z.string().nullish(),
});
type RuntimeStored = z.infer<typeof storedSchema>;

const LONG_POLL_S = 60;
const SNAPSHOT_READY_TIMEOUT_MS = 30 * 60_000;

export function mapRuntimeImageState(state: string): string {
  switch (state) {
    case "ready":
      return "active";
    case "making":
      return "building";
    case "failed":
      return "build_failed";
    default:
      return state;
  }
}

function toProviderSnapshot(
  name: string,
  stored: RuntimeStored,
): ProviderSnapshot {
  return {
    name,
    providerSnapshotId: stored.id,
    state: mapRuntimeImageState(stored.state),
    errorReason: stored.error ?? null,
    size: stored.sizeBytes ?? null,
    createdAt: stored.createdAt ?? undefined,
  };
}

/** An image by id, or the newest version by name; `null` when absent. */
async function getImage(
  config: RuntimeConfig,
  ref: string,
  query?: Record<string, string>,
): Promise<RuntimeStored | null> {
  try {
    return await requestJson(
      config,
      storedSchema,
      "GET",
      `/images/${encodeURIComponent(ref)}`,
      { query, timeoutMs: (LONG_POLL_S + 15) * 1000 },
    );
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function getRuntimeSnapshot(
  config: RuntimeConfig,
  name: string,
): Promise<ProviderSnapshot | null> {
  const image = await getImage(config, runtimeImageName(name));
  return image ? toProviderSnapshot(name, image) : null;
}

/** Delete the snapshot's image version. A missing one is a no-op. */
export async function deleteRuntimeSnapshot(
  config: RuntimeConfig,
  name: string,
  providerSnapshotId?: string | null,
): Promise<void> {
  const id =
    providerSnapshotId ?? (await getImage(config, runtimeImageName(name)))?.id;
  if (!id) return;
  try {
    const res = await send(
      config,
      "DELETE",
      `/images/${encodeURIComponent(id)}`,
    );
    await res.body?.cancel();
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

export async function waitForRuntimeSnapshotReady(
  config: RuntimeConfig,
  name: string,
  providerSnapshotId?: string | null,
  timeoutMs: number = SNAPSHOT_READY_TIMEOUT_MS,
): Promise<ProviderSnapshot> {
  const ref = providerSnapshotId ?? runtimeImageName(name);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const image = await getImage(config, ref, {
      wait: String(LONG_POLL_S),
      ifState: "making",
    });
    if (image?.state === "ready") return toProviderSnapshot(name, image);
    if (image?.state === "failed") {
      throw new Error(
        `Runtime image "${ref}" failed` +
          (image.error ? `: ${image.error}` : ""),
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Runtime image "${ref}" was not ready within ` +
          `${Math.round(timeoutMs / 1000)}s ` +
          (image ? `(last state: "${image.state}")` : "(not found)"),
      );
    }
    if (!image) await new Promise((r) => setTimeout(r, 2_000));
  }
}

/** Save the sandbox's disk as the next version of the image for `name`. */
export async function captureRuntimeSnapshot(
  config: RuntimeConfig,
  sandboxId: string,
  name: string,
): Promise<CapturedSnapshot> {
  await runRuntimeScript(config, sandboxId, "sync").catch(() => undefined);
  const stored = await requestJson(
    config,
    storedSchema,
    "POST",
    sandboxPath(sandboxId, ":snapshot"),
    { json: { image: runtimeImageName(name) } },
  );
  return { providerSnapshotId: stored.id };
}
