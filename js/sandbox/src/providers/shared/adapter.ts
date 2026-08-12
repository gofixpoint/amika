/**
 * Provider-agnostic "sandbox adapter" port.
 *
 * The adapter provisioning logic (clone, credential injection, lifecycle
 * scripts, MCP wiring, `/etc/environment` management) needs only a handful of
 * primitives against a *running* sandbox: run a command, write a file, read a
 * file, and learn the user's home directory. {@link SandboxAdapter} captures
 * exactly that surface so the orchestration in `./configure-adapter` can run
 * against any provider. Each provider supplies an adapter — Daytona via
 * `daytona/adapter`, Freestyle via `freestyle/adapter` — and never leaks its
 * SDK's sandbox object into the shared code.
 */

export interface ExecOptions {
  /** Working directory the command runs in. */
  cwd?: string;
  /** Extra environment variables to expose to the command. */
  env?: Record<string, string>;
  /**
   * Run the command with root privileges. Providers whose default user is
   * unprivileged (Daytona's `amika` user) translate this to `sudo`; providers
   * that already run as root (Freestyle VMs) treat it as a no-op.
   */
  sudo?: boolean;
}

/**
 * The adapter-level echo of {@link SandboxExecResult}: the streams stay
 * separate so value parsers can read {@link stdout} without incidental
 * stderr (a `sudo` hostname warning, a deprecation notice) corrupting it.
 */
export interface ExecResult {
  exitCode: number;
  /** Standard output only; never carries stderr text. */
  stdout: string;
  /** Standard error only; empty when the command wrote nothing to it. */
  stderr: string;
}

/**
 * The most diagnosable text a finished command produced: stderr when it
 * wrote any, else stdout. Every "command failed" message should route
 * through this so splitting the streams does not cost failure
 * debuggability, which is the reason stderr used to be merged at all.
 */
export function execFailureText(
  result: Pick<ExecResult, "stdout" | "stderr">,
): string {
  const stderr = result.stderr.trim();
  return stderr !== "" ? stderr : result.stdout.trim();
}

/**
 * The minimal adapter surface the shared provisioning logic codes against.
 * `downloadFile` returns `null` for a missing/unreadable file (rather than
 * throwing) so callers can treat "no existing config" uniformly across
 * providers.
 */
export interface SandboxAdapter {
  /** Run a one-shot command and capture its two streams + exit code. */
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
  /** Write a file, creating parent directories as needed. */
  uploadFile(content: Buffer | string, path: string): Promise<void>;
  /** Read a file as UTF-8 text; `null` when it does not exist / can't be read. */
  downloadFile(path: string): Promise<string | null>;
}

/**
 * Run a command and throw when it exits non-zero. The adapter analogue of
 * Daytona's `executeCheckedCommand`; the thrown message carries the command's
 * stderr (falling back to stdout) so the failure is diagnosable.
 */
export async function execChecked(
  adapter: SandboxAdapter,
  command: string,
  opts?: ExecOptions,
): Promise<void> {
  const result = await adapter.exec(command, opts);
  if (result.exitCode !== 0) {
    throw new Error(execFailureText(result) || `Command failed: ${command}`);
  }
}
