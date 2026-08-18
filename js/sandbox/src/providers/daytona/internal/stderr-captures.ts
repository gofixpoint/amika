/**
 * Pre-snapshot removal of orphaned stderr capture files.
 *
 * Daytona's one-shot exec carries a single combined stream, so
 * {@link buildStreamSplitCommand} rebuilds the two-stream contract by sending
 * the command's stderr to a temp file and reading it back after the command
 * exits. The wrapper removes that file in an `EXIT` trap, and traps `INT`,
 * `TERM` and `HUP` on top — but a `SIGKILL`, an OOM kill, or the sandbox being
 * force-stopped mid-command runs no trap at all, and the file stays.
 *
 * That file holds the command's stderr, which is not reliably non-sensitive: a
 * failed `git clone https://x-access-token:<token>@github.com/...` prints the
 * tokenized URL there, the same class of leak `scrubGitRemoteTokens` exists to
 * clean out of `.git/config`. Snapshots capture the filesystem opaquely and are
 * forkable, so residue left in `/tmp` is baked in and travels.
 *
 * The core scrub (`scrubTargetsViaExec`) cannot cover this: it removes exactly
 * the paths the caller declares and never decides what is a secret, whereas this
 * path pattern is an invariant of *this* provider's wrapper. So it lives here,
 * wired as the Daytona `removeInjectedSecrets` primitive, which
 * `snapshots.scrubAndCreate` runs after the core scrub and before `capture`.
 */
import { shellQuote } from "../../../util/shell";
import { getDaytonaClient } from "./client";
import type { DaytonaConfig } from "../config";
import { STDERR_CAPTURE_PREFIX, executeCommand } from "./commands";

/**
 * Remove every stderr capture file left in the sandbox's temp directory.
 *
 * Deliberately *not* verified fail-closed, unlike the credential-path scrub.
 * That scrub removes a known secret at a known path, so a survivor is a genuine
 * failure. Here the target set is opportunistic residue, and every exec — this
 * one included — creates a capture file of its own while it runs, so a check
 * would be racing its own plumbing rather than detecting a leak. The in-flight
 * file is unlinked by the sweep or by its own trap moments later, and either way
 * it is gone before `capture` freezes the filesystem.
 *
 * `find`'s stderr is folded into stdout so a diagnostic survives the sweep
 * deleting the very file this command's own stderr is being captured to;
 * `execFailureText` falls back to stdout, so the exit-code check still reports
 * something useful. Unprivileged: the capture file is created by the framing
 * shell before any `sudo`, so one user owns all of them.
 *
 * Bounded to `$TMPDIR` as this exec sees it. A capture file written under a
 * caller-supplied `TMPDIR` is not swept — no caller sets one today, and the
 * alternative is searching the filesystem before every snapshot.
 */
export async function removeStderrCaptureFiles(
  config: DaytonaConfig,
  providerSandboxId: string,
): Promise<void> {
  const daytona = getDaytonaClient(config);
  const sandbox = await daytona.get(providerSandboxId);
  const result = await executeCommand(
    sandbox,
    `find "\${TMPDIR:-/tmp}" -maxdepth 1 -type f ` +
      `-name ${shellQuote(`${STDERR_CAPTURE_PREFIX}*`)} ` +
      `-exec rm -f -- {} + 2>&1`,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to remove stderr capture files: ${result.stdout.trim() || result.stderr.trim()}`,
    );
  }
}
