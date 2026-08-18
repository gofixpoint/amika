import type { SandboxProviderCapabilities } from "../provider";

/** SDK-free E2B capability declaration for server and client consumers. */
export const e2bCapabilities: SandboxProviderCapabilities = {
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
  skipStartScript: true,
  snapshotIdsAreOpaque: true,
  supportsAutoDelete: false,
};
