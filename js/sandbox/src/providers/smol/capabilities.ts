/** Client-safe capabilities of the local smolvm provider. */
import type { SandboxProviderCapabilities } from "../provider";

export const smolCapabilities: SandboxProviderCapabilities = {
  lifecycle: false,
  ssh: false,
  services: false,
  exec: true,
  listSandboxes: true,
  streaming: false,
  snapshots: false,
  fullSnapshotCapture: false,
  scrubCapture: false,
  dockerRegistries: false,
  snapshotIdsAreOpaque: false,
  supportsAutoDelete: false,
};
