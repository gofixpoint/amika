/**
 * Snapshot capture (the write path) against the Vercel Sandbox API.
 *
 * Vercel captures a snapshot from a running sandbox with `sandbox.snapshot()`,
 * which returns a `Snapshot` carrying an opaque `snapshotId` (`snap_…`). Unlike
 * Freestyle's `vm.snapshot({ name })`, a Vercel snapshot has NO name or label —
 * it is addressable only by that id. The capture therefore returns the bootable
 * id for the caller to persist; the by-name lookup/delete path (which bridges
 * Amika's name-keyed snapshot model to Vercel's id-only API) lives alongside in
 * `./snapshot-lookup`.
 *
 * Only the DESTRUCTIVE delete-intent capture is supported for Vercel: it
 * captures the sandbox and the caller deletes the source right after. A
 * non-destructive keep-source capture is NOT offered — the sandbox is created
 * with `keepLastSnapshots: { count: 1 }` (flat storage), so the source's next
 * stop/idle auto-snapshot would evict the captured snapshot, and the SDK
 * exposes no way to pin an individual snapshot. The provider throws
 * `SandboxProviderUnsupportedError` for `keepSourceRunning: true`.
 * `sandbox.snapshot()` stops the source as part of the capture — harmless
 * here, since the source is discarded immediately after.
 *
 * The Amika secret scrub itself is core-synthesized and runs before these
 * primitives through the exec capability with a bare resume;
 * this module contributes only the provider-owned pieces.
 *
 * SECURITY CAVEAT: like Freestyle, the disk scrub removes the injected
 * credential files and managed env, but `sandbox.snapshot()` captures a live
 * session — secrets that were already loaded into memory (the OpenCode
 * server's API keys, an agent's process env) may survive in the captured state
 * and come back when the snapshot is booted. Acceptable for the current
 * dev-gated, org-scoped Vercel usage (a snapshot only boots within its owning
 * org).
 */
import { shellQuote } from "../../../util/shell";
import { getVercelSandbox } from "./client";
import { VercelAdapter } from "./adapter";
import { VERCEL_RESUME_CONTEXT_PATH } from "./operations";
import { execChecked } from "../../shared/adapter";
import type { CapturedSnapshot } from "../../provider";
import type { VercelConfig } from "../config";

/**
 * Remove the secrets Vercel itself injected into the sandbox: the resume
 * context ({@link VERCEL_RESUME_CONTEXT_PATH}), which holds the source
 * sandbox's OpenCode server password and would otherwise land on disk in a
 * capture even after the Amika scrub removed `OPENCODE_SERVER_PASSWORD` from
 * `/etc/environment`. Root owned (installed 0600), so removed with sudo;
 * idempotent (`rm -f`). Resumes bare (no `onResume` callback) — the
 * service-restart callback reads this very file, and relaunching OpenCode with
 * the password mid-scrub would defeat the removal.
 */
export async function removeVercelInjectedSecrets(
  config: VercelConfig,
  providerSandboxId: string,
): Promise<void> {
  // `resume: true` with no `onResume` is a bare resume.
  const sandbox = await getVercelSandbox(config, providerSandboxId, {
    resume: true,
  });
  const adapter = new VercelAdapter(sandbox);
  await execChecked(
    adapter,
    `rm -f ${shellQuote(VERCEL_RESUME_CONTEXT_PATH)}`,
    { sudo: true },
  );
}

/**
 * Capture the sandbox as it stands. `snapshot()` stops the source, but the
 * caller deletes it right after on this destructive path, so the stop is
 * harmless. Resumes bare (no `onResume`) for the same reason as the secret
 * removal above — a service relaunch would reload scrubbed credentials into
 * the session the capture freezes.
 */
export async function captureVercelSnapshot(
  config: VercelConfig,
  providerSandboxId: string,
): Promise<CapturedSnapshot> {
  // `resume: true` with no `onResume` is a bare resume.
  const sandbox = await getVercelSandbox(config, providerSandboxId, {
    resume: true,
  });
  const snapshot = await sandbox.snapshot({ expiration: 0 });
  return { providerSnapshotId: snapshot.snapshotId };
}
