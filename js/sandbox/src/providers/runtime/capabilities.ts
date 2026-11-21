/**
 * Runtime capability flags. Kept SDK-free so the client-safe capabilities
 * table (`../capabilities`) can read them.
 *
 * Runtime sandboxes are Firecracker microVMs with a REST API for lifecycle,
 * commands (streamed as NDJSON), raw-byte files, private HTTPS previews,
 * and images. Capture saves the disk only, as an image version, so a scrub
 * before capture is complete; the sandbox keeps running, so full capture is
 * supported. Image ids are opaque. Runtime has no SSH, so there is no
 * minted SSH access. A sandbox pauses when idle but is never deleted for
 * it, so there is no auto-delete. Sizes are free-form up to the plan's
 * limits, so there are no account sizes.
 */
import type { SandboxProviderCapabilities } from "../provider";

export const runtimeCapabilities: SandboxProviderCapabilities = {
  lifecycle: true,
  ssh: false,
  services: true,
  exec: true,
  listSandboxes: true,
  streaming: true,
  snapshots: true,
  scrubCapture: true,
  fullSnapshotCapture: true,
  dockerRegistries: false,
  snapshotIdsAreOpaque: true,
  supportsAutoDelete: false,
  accountSizes: false,
};
