/** Client-safe capabilities of the embedded smolvm provider. */
import type { SandboxProviderCapabilities } from "../provider";

export const smolvmSdkCapabilities: SandboxProviderCapabilities = {
  lifecycle: true,
  ssh: false,
  services: true,
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
