/**
 * Freestyle capability flags. Colocated with the provider but kept SDK-free so
 * the client-safe capabilities table (`../capabilities`) can aggregate it
 * without pulling in the Freestyle SDK.
 *
 * Per-sandbox lifecycle + exec + SSH + snapshot parity with Daytona. Snapshots
 * are captured from a running sandbox via `vm.snapshot` (the "Take Snapshot"
 * flow). Docker registries stay Daytona-only — they're a control-plane concern
 * Freestyle does not back. SSH rides on Freestyle's identity/token gateway
 * (`vm-ssh.freestyle.sh`; see `./ssh`). Log streaming stays disabled:
 * Freestyle's `vm.exec` buffers output (no incremental SSE), so advertising it
 * would misrepresent the behavior.
 */
import type { SandboxProviderCapabilities } from "../provider";

export const freestyleCapabilities: SandboxProviderCapabilities = {
  lifecycle: true,
  ssh: true,
  services: true,
  exec: true,
  listSandboxes: true,
  streaming: false,
  snapshots: true,
  scrubCapture: true,
  fullSnapshotCapture: true,
  dockerRegistries: false,
  skipStartScript: false,
  // `vm.snapshot` returns an opaque id distinct from the org-scoped name.
  snapshotIdsAreOpaque: true,
  // Persistent VMs suspend/resume rather than being auto-deleted.
  supportsAutoDelete: false,
};
