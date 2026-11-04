/** Client-safe capabilities for the Smol superset exposed by amika-hostd. */
import type { SandboxProviderCapabilities } from "../provider";
import { smolCapabilities } from "../smol/capabilities";

/**
 * Smol's, plus services and snapshots.
 *
 * Services: hostd routes to published guest ports, which is also what makes
 * a hostd machine eligible for no-relay SSH through `amikad`.
 *
 * Snapshots: hostd packs a rig's disks into a `.smolmachine` on the host's
 * own disk and boots new rigs from it by name. The pack needs the rig
 * stopped (smolvm refuses to pack a running machine), so the
 * non-destructive "snapshot everything and keep it running" mode is not
 * available — `fullSnapshotCapture` is false and the create-snapshot API
 * steers callers to "snapshot and delete", which is the only mode here.
 * Snapshots are addressed by their own name, never an opaque id.
 */
export const amikaHostdCapabilities: SandboxProviderCapabilities = {
  ...smolCapabilities,
  services: true,
  snapshots: true,
  fullSnapshotCapture: false,
  scrubCapture: true,
  snapshotIdsAreOpaque: false,
};
