/**
 * Snapshots as Compute Engine disk images
 * (https://cloud.google.com/compute/docs/reference/rest/v1/images).
 *
 * An image holds the VM's boot disk: the installed software and the home
 * directory. It holds no memory and no running programs, so a scrub before
 * the capture removes the secrets for good. Capture uses `forceCreate`, so a
 * running VM stays running; we run `sync` first so recent writes are on
 * disk.
 *
 * Image names follow `./names.ts`. The bootable handle is the image path
 * (`projects/{project}/global/images/{name}`), which create takes as its
 * boot source. The exact Amika name rides in the image description.
 */
import { z } from "zod";
import type { CapturedSnapshot, ProviderSnapshot } from "../../provider";
import {
  isNotFound,
  requestJson,
  runOperation,
  type GcpTarget,
} from "./client";
import { gcpName } from "./names";
import { getGcpInstance } from "./operations";
import { execGcp } from "./ssh";

const imageSchema = z.object({
  name: z.string(),
  status: z.string(),
  diskSizeGb: z.string().optional(),
  archiveSizeBytes: z.string().optional(),
  creationTimestamp: z.string().optional(),
});
type GcpImage = z.infer<typeof imageSchema>;

/** How long a capture may take to become `READY`. */
const IMAGE_READY_TIMEOUT_MS = 20 * 60_000;
const IMAGE_POLL_INTERVAL_MS = 5_000;

/** Map an image status to the provider-agnostic state. */
export function mapGcpImageStatus(status: string): string {
  switch (status) {
    case "READY":
      return "active";
    case "PENDING":
      return "building";
    case "FAILED":
      return "build_failed";
    default:
      // `DELETING`.
      return status.toLowerCase();
  }
}

function imagePath(target: GcpTarget, imageName: string): string {
  return `${target.projectPath}/global/images/${encodeURIComponent(imageName)}`;
}

/** The image name in a handle from {@link captureGcpSnapshot}, or for `name`. */
function imageNameOf(name: string, providerSnapshotId?: string | null): string {
  if (providerSnapshotId) {
    return providerSnapshotId.split("/").pop() ?? providerSnapshotId;
  }
  return gcpName(name);
}

function toProviderSnapshot(
  target: GcpTarget,
  name: string,
  image: GcpImage,
): ProviderSnapshot {
  return {
    name,
    providerSnapshotId: `${target.projectPath}/global/images/${image.name}`,
    state: mapGcpImageStatus(image.status),
    disk: image.diskSizeGb ? Number(image.diskSizeGb) : undefined,
    size: image.archiveSizeBytes ? Number(image.archiveSizeBytes) : null,
    createdAt: image.creationTimestamp,
  };
}

async function getImage(
  target: GcpTarget,
  imageName: string,
): Promise<GcpImage | null> {
  try {
    return await requestJson(
      target,
      imageSchema,
      "GET",
      imagePath(target, imageName),
    );
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** Look up a snapshot by its Amika name; `null` when absent. */
export async function getGcpSnapshot(
  target: GcpTarget,
  name: string,
): Promise<ProviderSnapshot | null> {
  const image = await getImage(target, gcpName(name));
  return image ? toProviderSnapshot(target, name, image) : null;
}

/** Delete a snapshot. A missing snapshot is a no-op. */
export async function deleteGcpSnapshot(
  target: GcpTarget,
  name: string,
  providerSnapshotId?: string | null,
): Promise<void> {
  try {
    await runOperation(
      target,
      "DELETE",
      imagePath(target, imageNameOf(name, providerSnapshotId)),
    );
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

/** Wait until the image is `READY`. Throws when it fails or times out. */
export async function waitForGcpSnapshotReady(
  target: GcpTarget,
  name: string,
  providerSnapshotId?: string | null,
  timeoutMs: number = IMAGE_READY_TIMEOUT_MS,
): Promise<ProviderSnapshot> {
  const imageName = imageNameOf(name, providerSnapshotId);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const image = await getImage(target, imageName);
    if (image?.status === "READY") {
      return toProviderSnapshot(target, name, image);
    }
    if (image?.status === "FAILED") {
      throw new Error(`GCP image "${imageName}" for snapshot "${name}" failed`);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `GCP image "${imageName}" was not ready within ` +
          `${Math.round(timeoutMs / 1000)}s ` +
          (image ? `(last status: "${image.status}")` : "(not found)"),
      );
    }
    await new Promise((r) => setTimeout(r, IMAGE_POLL_INTERVAL_MS));
  }
}

/** Save the VM's boot disk as an image named after `name`. */
export async function captureGcpSnapshot(
  target: GcpTarget,
  instanceName: string,
  name: string,
): Promise<CapturedSnapshot> {
  const instance = await getGcpInstance(target, instanceName);
  if (!instance) throw new Error(`GCP VM ${instanceName} does not exist`);
  const sourceDisk = (
    instance.disks?.find((d) => d.boot) ?? instance.disks?.[0]
  )?.source;
  if (!sourceDisk) throw new Error(`GCP VM ${instanceName} has no boot disk`);
  if (instance.status === "RUNNING") {
    await execGcp(target, instanceName, "sync").catch(() => undefined);
  }
  const imageName = gcpName(name);
  await runOperation(target, "POST", `${target.projectPath}/global/images`, {
    query: { forceCreate: "true" },
    json: {
      name: imageName,
      description: name,
      sourceDisk,
      labels: { "amika-managed": "true" },
    },
  });
  return {
    providerSnapshotId: `${target.projectPath}/global/images/${imageName}`,
  };
}
