/**
 * GCP capability flags. Kept SDK-free so the client-safe capabilities table
 * (`../capabilities`) can read them.
 *
 * A Compute Engine VM has a REST API for lifecycle, listing, and disk
 * images, but none for commands or files. The provider runs both over SSH,
 * so exec streams and takes stdin. Compute Engine has no port routing, so
 * there are no service URLs and no minted SSH access. A disk image of a
 * running VM keeps the VM running, so full capture is supported. Image
 * names follow Compute Engine's rules, not Amika's, so snapshot ids are
 * opaque. Compute Engine has no idle timer, so there is no auto-delete, and
 * a VM may take any size the project's quota allows, so there are no
 * account sizes.
 */
import type { SandboxProviderCapabilities } from "../provider";

export const gcpCapabilities: SandboxProviderCapabilities = {
  lifecycle: true,
  ssh: false,
  services: false,
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
