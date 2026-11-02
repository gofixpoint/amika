/** Client-safe capabilities of the in-memory `simulate` provider. */
import type { SandboxProviderCapabilities } from "../provider";

export const simulateCapabilities: SandboxProviderCapabilities = {
  lifecycle: true,
  ssh: true,
  services: true,
  exec: true,
  listSandboxes: true,
  streaming: true,
  snapshots: true,
  fullSnapshotCapture: true,
  scrubCapture: true,
  dockerRegistries: false,
  snapshotIdsAreOpaque: false,
  supportsAutoDelete: true,
  guestProvisioning: true,
};
