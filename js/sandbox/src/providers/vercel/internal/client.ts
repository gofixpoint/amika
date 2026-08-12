/**
 * Vercel Sandbox SDK access.
 *
 * `@vercel/sandbox` is a static SDK — there is no client object to construct;
 * `Sandbox.create`/`Sandbox.get` take the credentials inline. Amika runs
 * off-Vercel, so we use access-token auth (a team-scoped token plus the team
 * and project ids) rather than the OIDC token the SDK auto-resolves from the
 * environment when code is deployed on Vercel. Centralizing the credential
 * mapping here keeps every operation authenticating identically; nothing else
 * in the provider references the raw {@link VercelConfig} fields.
 */
import { Sandbox } from "@vercel/sandbox";
import type { VercelConfig } from "../config";

/** The credential fields spread into every `Sandbox.create`/`get` call. */
export function vercelCredentials(config: VercelConfig): {
  token: string;
  teamId: string;
  projectId: string;
} {
  return {
    token: config.apiKey,
    teamId: config.teamId,
    projectId: config.projectId,
  };
}

/**
 * Reconnect to an existing sandbox by its provider id — the Vercel sandbox
 * `name`, generated at create time and stored as `provider_sandbox_id`.
 *
 * `resume` defaults to `false` so read-only / teardown operations (state, stop,
 * delete) don't spin a stopped VM back up just to inspect or remove it. Pass
 * `true` on paths that need a live VM (exec, file read, lifecycle restart):
 * Vercel sandboxes are persistent, so a stopped one resumes from its last
 * snapshot.
 *
 * `onResume` is the SDK hook the platform invokes when a `resume: true` call
 * actually wakes a stopped session from its snapshot (it does NOT fire for a
 * sandbox that is already running). Persistence restores only the filesystem,
 * not the processes the lifecycle hooks started, so exec/stream paths pass a
 * callback here to relaunch OpenCode and the user services on a cold resume.
 */
export function getVercelSandbox(
  config: VercelConfig,
  providerSandboxId: string,
  opts?: { resume?: boolean; onResume?: (sandbox: Sandbox) => Promise<void> },
): Promise<Sandbox> {
  return Sandbox.get({
    ...vercelCredentials(config),
    name: providerSandboxId,
    resume: opts?.resume ?? false,
    ...(opts?.onResume ? { onResume: opts.onResume } : {}),
  });
}
