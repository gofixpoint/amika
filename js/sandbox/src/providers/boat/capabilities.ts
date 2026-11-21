/**
 * boat capability flags. Kept SDK-free so the client-safe capabilities
 * table (`../capabilities`) can read them.
 *
 * boat sandboxes are Ubuntu VMs with a REST API for lifecycle, commands
 * (streamed as NDJSON), files, hosted ports, and saved snapshots. A saved
 * snapshot holds the disk only, so a scrub before capture is complete, and
 * a running sandbox keeps running, so full capture is supported. Saved
 * snapshot names follow boat's rules, not Amika's, so snapshot ids are
 * opaque. boat stops a sandbox only at a fixed deadline, not after an idle
 * period, and has no auto-delete. `GET /limits` reports the sizes the key's
 * account may start, so it lists account sizes. boat can add an SSH key
 * but not remove one, so there is no minted SSH access.
 */
import type { SandboxProviderCapabilities } from "../provider";

export const boatCapabilities: SandboxProviderCapabilities = {
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
  accountSizes: true,
};
