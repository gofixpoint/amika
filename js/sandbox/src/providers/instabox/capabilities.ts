/**
 * Instabox capability flags. Kept SDK-free so the client-safe capabilities
 * table (`../capabilities`) can read them.
 *
 * Instabox machines are Linux VMs with a REST API for lifecycle, exec (with
 * SSE streaming), files, SSH tokens, private port URLs, and snapshots.
 * A snapshot holds the disks only (no memory), so a scrub before capture is
 * complete. Capture works on a running machine and keeps it running, so
 * full capture is supported. Snapshot ids (`sn_…`) are opaque. Instabox can
 * delete a machine at a fixed time after create, but not after an idle
 * period, so auto-delete is not supported.
 */
import type { SandboxProviderCapabilities } from "../provider";

export const instaboxCapabilities: SandboxProviderCapabilities = {
  lifecycle: true,
  ssh: true,
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
};
