import type { SandboxProviderCapabilities } from "../provider";

/** Client-safe Sailbox capability declaration. */
export const sailboxCapabilities: SandboxProviderCapabilities = {
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
  skipStartScript: false,
  snapshotIdsAreOpaque: true,
  supportsAutoDelete: false,
};
