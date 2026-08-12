/**
 * Core-synthesized pre-snapshot secret scrub, expressed against the id-keyed
 * {@link ExecCapability} primitive.
 *
 * Snapshots capture the whole filesystem opaquely, so injected secrets are
 * removed from the running sandbox immediately before capture. Providers do
 * not implement this: `makeSandboxSnapshots` runs it above the provider's
 * `capture()`/`removeInjectedSecrets()` primitives for every provider that
 * declares exec.
 *
 * The mechanism is generic — it removes exactly the paths it is handed and
 * never decides what is a secret (the target list, including the workspace root
 * for the git-remote pass, is computed by the caller and arrives as
 * {@link ScrubTargets}).
 *
 * Every command runs with `resumeMode: "bare"`: on Vercel a generic exec
 * against a stopped sandbox would otherwise fire the service-restart resume
 * callback, which reads the resume-context file and relaunches OpenCode with
 * the source password — reloading the very secret being scrubbed into a live
 * session right before capture. Providers without resume callbacks ignore it.
 *
 * Used only on the destructive "snapshot and delete" path — the source is
 * deleted afterward (or, on failure, kept with the scrub already applied), so
 * the scrub is not reversed.
 */
import { shellQuote } from "../../util/shell";
import {
  ScrubRestoreError,
  ScrubVerificationError,
  type ScrubTargets,
} from "../provider";
import type { ExecCapability, ExecCommandOptions } from "../provider";
import { execFailureText } from "./adapter";

const SCRUB_EXEC_OPTS: ExecCommandOptions = { resumeMode: "bare" };

/**
 * Rewrite tokenized Git remotes to their plain `https://` form in every cloned
 * repo under `workspaceRoot`. Clones performed with
 * `https://x-access-token:<token>@github.com/...` persist that exact URL in
 * each repo's `.git/config`; the credential-file/env scrub never touches it,
 * so without this a "scrubbed" snapshot would still carry a live GitHub token
 * for any cloned private repo. Verifies none survive (fail closed, like the
 * file scrub). A no-op when the workspace or repos are absent.
 */
async function scrubGitRemoteTokens(
  exec: ExecCapability,
  providerSandboxId: string,
  workspaceRoot: string,
): Promise<void> {
  // Only `.git/config` files under the workspace; the userinfo is `[^@/]+` so we
  // strip exactly the `x-access-token:<token>@` prefix and keep the host/path.
  const findConfigs = `find ${shellQuote(workspaceRoot)} -type f -path '*/.git/config'`;
  const sanitizeCmd =
    `if [ -d ${shellQuote(workspaceRoot)} ]; then ` +
    `${findConfigs} -exec sed -i -E 's#https://x-access-token:[^@/]+@#https://#g' {} +; fi`;
  const sanitizeResult = await exec.run(
    providerSandboxId,
    sanitizeCmd,
    SCRUB_EXEC_OPTS,
  );
  if (sanitizeResult.exitCode !== 0) {
    throw new Error(
      `Failed to scrub tokenized git remotes: ${execFailureText(sanitizeResult)}`,
    );
  }

  // Verify no `.git/config` still contains a tokenized remote before the caller
  // snapshots. `grep -l` prints only the paths that still match; any output is a
  // leftover token, so fail closed exactly as the file scrub does.
  const verifyCmd =
    `if [ -d ${shellQuote(workspaceRoot)} ]; then ` +
    `${findConfigs} -exec grep -l 'x-access-token:' {} + 2>/dev/null; fi`;
  const { stdout } = await exec.run(
    providerSandboxId,
    verifyCmd,
    SCRUB_EXEC_OPTS,
  );
  const leftover = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (leftover.length > 0) {
    throw new ScrubVerificationError(leftover);
  }
}

/**
 * Remove the given credential files and managed env files from a running
 * sandbox, then verify the removal took. Credential files (`targets.files`)
 * are removed as the unprivileged user; the managed env files
 * (`targets.sudoFiles`) are system paths removed with sudo. `rm -rf`/`rm -f`
 * are no-ops on missing paths, so this stays idempotent; the exit-code check
 * still surfaces a genuine filesystem error. All target paths arrive
 * absolute, so no home-directory resolution is needed.
 *
 * A silent no-op (e.g. a misrouted exec) would produce a snapshot that still
 * contains secrets — exactly what this guards against — so every removed path
 * is verified gone afterward, failing closed with
 * {@link ScrubVerificationError}.
 */
export async function scrubTargetsViaExec(
  exec: ExecCapability,
  providerSandboxId: string,
  targets: ScrubTargets,
): Promise<void> {
  // Restore system baselines first, before anything else runs. This is what
  // clears the injected secrets out of `/etc/environment` (the file is
  // overwritten with its clean baseline rather than removed), so doing it
  // first keeps the window in which a live process could still read them as
  // short as possible.
  for (const restore of targets.sudoFileRestores) {
    const result = await exec.run(
      providerSandboxId,
      `install -m 0644 ${shellQuote(restore.sourcePath)} ${shellQuote(restore.destinationPath)}`,
      { ...SCRUB_EXEC_OPTS, sudo: true },
    );
    if (result.exitCode !== 0) {
      throw new ScrubRestoreError(
        restore.sourcePath,
        restore.destinationPath,
        `install failed (exit ${result.exitCode}) ${execFailureText(result)}`.trim(),
      );
    }
  }

  for (const file of targets.files) {
    const result = await exec.run(
      providerSandboxId,
      `rm -rf ${shellQuote(file)}`,
      SCRUB_EXEC_OPTS,
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to remove credential path ${file}: ${execFailureText(result)}`,
      );
    }
  }

  for (const filePath of targets.sudoFiles) {
    const result = await exec.run(
      providerSandboxId,
      `rm -f ${shellQuote(filePath)}`,
      { ...SCRUB_EXEC_OPTS, sudo: true },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to remove environment file ${filePath}: ${execFailureText(result)}`,
      );
    }
  }

  // Rewrite tokenized Git remotes the credential/env removal doesn't cover
  // (each cloned repo's `.git/config` still holds the clone-URL token) when
  // the caller declared a workspace root. Verifies internally, fails closed.
  if (targets.gitTokenWorkspaceRoot) {
    await scrubGitRemoteTokens(
      exec,
      providerSandboxId,
      targets.gitTokenWorkspaceRoot,
    );
  }

  // Verify the scrub actually took before the caller captures. `ls -1d`
  // prints existing paths to stdout and routes "no such file" to stderr, so a
  // single sudo command yields exactly the still-present files; its exit code
  // is ignored (non-zero whenever any candidate is absent — the good case).
  const removedPaths = [...targets.files, ...targets.sudoFiles];
  if (removedPaths.length > 0) {
    const { stdout } = await exec.run(
      providerSandboxId,
      `ls -1d ${removedPaths.map(shellQuote).join(" ")} 2>/dev/null`,
      { ...SCRUB_EXEC_OPTS, sudo: true },
    );
    const present = new Set(
      stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    );
    const leftover = removedPaths.filter((file) => present.has(file));
    if (leftover.length > 0) {
      throw new ScrubVerificationError(leftover);
    }
  }

  for (const restore of targets.sudoFileRestores) {
    const result = await exec.run(
      providerSandboxId,
      `source_hash=$(sha256sum ${shellQuote(restore.sourcePath)}) && ` +
        `destination_hash=$(sha256sum ${shellQuote(restore.destinationPath)}) && ` +
        `[ "\${source_hash%% *}" = "\${destination_hash%% *}" ]`,
      { ...SCRUB_EXEC_OPTS, sudo: true },
    );
    if (result.exitCode === 0) continue;
    throw new ScrubRestoreError(
      restore.sourcePath,
      restore.destinationPath,
      `verification failed (exit ${result.exitCode}) ${execFailureText(result)}`.trim(),
    );
  }
}
