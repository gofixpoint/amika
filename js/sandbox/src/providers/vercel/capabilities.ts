/**
 * Vercel capability flags. Colocated with the provider but kept SDK-free so the
 * client-safe capabilities table (`../capabilities`) can aggregate it without
 * pulling in the Vercel SDK.
 *
 * Per-sandbox lifecycle + exec + log streaming + snapshots, backed by
 * Vercel's `@vercel/sandbox` SDK (Firecracker microVMs). Streaming is real (the
 * SDK's incremental `command.logs()` async generator), unlike Freestyle. SSH
 * uses the provider-generic `amikad` no-relay service rather than the removed
 * provider-specific private-key bridge. Snapshots are captured from a
 * running sandbox via `sandbox.snapshot()`; only the destructive
 * scrub-and-delete capture is supported (a kept-alive source's
 * `keepLastSnapshots` retention would evict a full capture), so
 * `fullSnapshotCapture` is false. Docker registries and image-derived snapshots
 * stay Daytona-only — a control-plane concern Vercel does not back. Vercel
 * honors `skipStartScript` in its start-phase lifecycle rerun.
 */
import type { SandboxProviderCapabilities } from "../provider";

export const vercelCapabilities: SandboxProviderCapabilities = {
  lifecycle: true,
  ssh: false,
  services: true,
  exec: true,
  listSandboxes: true,
  streaming: true,
  snapshots: true,
  scrubCapture: true,
  fullSnapshotCapture: false,
  dockerRegistries: false,
  skipStartScript: true,
  // Vercel snapshots are id-only (`snap_…`), resolved from the org-scoped name
  // through the injected resolver.
  snapshotIdsAreOpaque: true,
  // Persistent microVMs suspend/resume on idle rather than being auto-deleted.
  supportsAutoDelete: false,
};
