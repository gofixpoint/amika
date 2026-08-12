/**
 * Daytona capability flags. Colocated with the provider but kept SDK-free so the
 * client-safe capabilities table (`../capabilities`) can aggregate it without
 * pulling in the Daytona SDK.
 *
 * The full-featured, control-plane provider: per-sandbox lifecycle + exec + log
 * streaming + SSH + snapshots, plus the image-derived snapshots and docker
 * registries no other provider backs. Streaming is real (session command logs
 * over a WebSocket). Daytona honors `skipStartScript` in its start-phase
 * lifecycle rerun.
 */
import type { SandboxProviderCapabilities } from "../provider";

export const daytonaCapabilities: SandboxProviderCapabilities = {
  lifecycle: true,
  ssh: true,
  services: true,
  exec: true,
  listSandboxes: true,
  streaming: true,
  snapshots: true,
  scrubCapture: true,
  fullSnapshotCapture: true,
  dockerRegistries: true,
  skipStartScript: true,
  // Snapshots are booted by their org-scoped name (no separate id handle).
  snapshotIdsAreOpaque: false,
  // Daytona deletes idle sandboxes on the auto-delete interval.
  supportsAutoDelete: true,
};
