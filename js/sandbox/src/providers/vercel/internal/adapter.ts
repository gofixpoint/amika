/**
 * Vercel adapter for the provider-agnostic {@link SandboxAdapter} port.
 *
 * Wraps a `@vercel/sandbox` `Sandbox` instance and maps the four adapter
 * primitives onto the SDK. Two impedance mismatches with the Daytona model are
 * handled here, mirroring {@link FreestyleAdapter}:
 *
 *  - `sandbox.runCommand` runs a single `cmd` + `args` (no implicit shell), so
 *    `cwd`/`env`/the managed-env source are folded into a `bash -c` script.
 *  - Vercel's default exec runs as the unprivileged `vercel-sandbox` user (which
 *    has passwordless `sudo`), so ordinary adapter work runs as that user and
 *    `sudo: true` steps go through the SDK's `sudo` flag — the same
 *    unprivileged-by-default / sudo-for-system-steps contract Daytona expects.
 */
import type { Sandbox } from "@vercel/sandbox";
import { shellQuote } from "../../../util/shell";
import type {
  ExecOptions,
  ExecResult,
  SandboxAdapter,
} from "../../shared/adapter";

/**
 * Load the Amika-managed environment that provisioning persists to
 * `/etc/environment` (`HOME`, `AMIKA_AGENT_CWD`, `OPENCODE_*`, injected vars)
 * before running the command. Vercel's `runCommand` starts a fresh shell with
 * only the sandbox's default `env`, so — like Freestyle's `vm.exec` — it
 * wouldn't otherwise see the managed env. Guarded with `[ -f ... ]` so it's a
 * harmless no-op before the file exists (early in init).
 */
const SOURCE_MANAGED_ENV =
  "[ -f /etc/environment ] && { set -a; . /etc/environment; set +a; }";

/**
 * Strip URL-embedded credentials from a command before it is used as a
 * diagnostic timing label. The provisioning layer's exec-based clone builds
 * `git clone 'https://x-access-token:<token>@github.com/...'`, so the raw
 * command text carries a GitHub token; without this the token would reach
 * server logs via {@link VercelAdapter.roundTripStats}'s `slowestLabel`.
 * Rewrites the `user:secret@` userinfo of any `http(s)://` URL to `***@`,
 * defending every token-bearing exec (clone, `ls-remote`, …), not just today's.
 */
export function redactCommandForLabel(command: string): string {
  return command.replace(/(\bhttps?:\/\/)[^/@\s]+@/gi, "$1***@");
}

/**
 * Fold the adapter {@link ExecOptions} into a single shell script for
 * `bash -c`. The managed env is sourced first, then any explicit env vars are
 * exported (so they win), then the working directory is changed before the
 * command runs. The `sudo` flag is not reflected in the script —
 * {@link VercelAdapter.exec} passes it to `runCommand` instead. Exported for
 * unit testing.
 */
export function buildVercelCommand(
  command: string,
  opts?: ExecOptions,
): string {
  const segments: string[] = [SOURCE_MANAGED_ENV];
  if (opts?.env) {
    for (const [name, value] of Object.entries(opts.env)) {
      segments.push(`export ${name}=${shellQuote(value)}`);
    }
  }
  if (opts?.cwd) {
    // Fail fast if the working directory is missing/inaccessible, so the
    // command can't silently run in the sandbox's previous cwd and let a
    // successful command mask the failed `cd`.
    segments.push(`cd ${shellQuote(opts.cwd)} || exit 1`);
  }
  segments.push(command);
  return segments.join("\n");
}

export class VercelAdapter implements SandboxAdapter {
  // Round-trip accounting for diagnosing slow provisions. Every adapter op is a
  // separate HTTPS call to the Vercel API; on a chatty path (a new sandbox makes
  // dozens) the sum dominates boot time. Tracked here so the orchestrators can
  // log a per-provision breakdown via {@link roundTripStats}, mirroring
  // `FreestyleAdapter`.
  private roundTripCount = 0;
  private roundTripMs = 0;
  private slowestMs = 0;
  private slowestLabel = "";

  constructor(private readonly sandbox: Sandbox) {}

  private async timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      const ms = performance.now() - start;
      this.roundTripCount += 1;
      this.roundTripMs += ms;
      if (ms > this.slowestMs) {
        this.slowestMs = ms;
        this.slowestLabel = label;
      }
    }
  }

  get roundTripStats(): {
    count: number;
    totalMs: number;
    slowestMs: number;
    slowestLabel: string;
  } {
    return {
      count: this.roundTripCount,
      totalMs: Math.round(this.roundTripMs),
      slowestMs: Math.round(this.slowestMs),
      slowestLabel: this.slowestLabel,
    };
  }

  async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    // `sudo: true` elevates via the SDK's flag (system-level setup); everything
    // else runs as the default `vercel-sandbox` user so repos, dotfiles, and
    // agent processes are owned by the lifecycle user rather than root.
    const commandHandle = await this.timed(
      redactCommandForLabel(command).slice(0, 80),
      () =>
        this.sandbox.runCommand({
          cmd: "bash",
          args: ["-c", buildVercelCommand(command, opts)],
          sudo: opts?.sudo ?? false,
        }),
    );
    const stdout = await commandHandle.stdout();
    const stderr = await commandHandle.stderr();
    return { exitCode: commandHandle.exitCode, stdout, stderr };
  }

  async uploadFile(content: Buffer | string, path: string): Promise<void> {
    await this.ensureParentDir(path);
    const buffer =
      typeof content === "string" ? Buffer.from(content, "utf8") : content;
    // `writeFiles` runs as `vercel-sandbox` (the sandbox's default user), so the
    // file lands owned by the lifecycle user — no root-ownership repair is
    // needed, unlike Freestyle whose `fs` writes run as root.
    await this.timed(`write ${path}`, () =>
      this.sandbox.writeFiles([{ path, content: buffer }]),
    );
  }

  async downloadFile(path: string): Promise<string | null> {
    try {
      const buffer = await this.timed(`read ${path}`, () =>
        this.sandbox.readFileToBuffer({ path }),
      );
      return buffer ? buffer.toString("utf8") : null;
    } catch {
      return null;
    }
  }

  private async ensureParentDir(path: string): Promise<void> {
    const idx = path.lastIndexOf("/");
    if (idx <= 0) return;
    const dir = path.slice(0, idx);
    // `mkdir -p` (rather than `sandbox.mkDir`) so intermediate dirs are created.
    // Best-effort: a real failure surfaces on the subsequent write.
    try {
      await this.timed(`mkdir ${dir}`, () =>
        this.sandbox.runCommand({ cmd: "mkdir", args: ["-p", dir] }),
      );
    } catch {
      // ignore — the subsequent write surfaces a real failure.
    }
  }
}
