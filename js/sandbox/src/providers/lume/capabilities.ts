/** Client-safe capabilities of the local Lume provider. */
import type { SandboxProviderCapabilities } from "../provider";

export const lumeCapabilities: SandboxProviderCapabilities = {
  lifecycle: true,
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
