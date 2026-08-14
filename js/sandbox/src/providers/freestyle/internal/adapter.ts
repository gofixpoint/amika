/**
 * Freestyle adapter for the provider-agnostic {@link SandboxAdapter} port.
 *
 * Wraps a Freestyle `Vm` handle and maps the four adapter primitives onto the
 * SDK. Two impedance mismatches with the Daytona model are handled here:
 *
 *  - `vm.exec` takes only a command string (no `cwd`/`env` parameters), so
 *    those are folded into a single shell script.
 *  - Freestyle's default exec runs as **root**, but the shared lifecycle
 *    expects the Daytona contract: unprivileged work as the `amika` user, with
 *    `sudo: true` for system-level steps. We honor that by running ordinary
 *    execs/file writes through an `amika`-scoped handle and reserving the root
 *    handle for `sudo: true` commands.
 */
import type { Freestyle } from "freestyle";
import { shellQuote } from "../../../util/shell";
import {
  execFailureText,
  type ExecOptions,
  type ExecResult,
  type SandboxAdapter,
} from "../../shared/adapter";

// `Vm` isn't a named export of `freestyle`; derive it from the client surface.
type FreestyleVm = ReturnType<Freestyle["vms"]["ref"]>;

/**
 * The unprivileged user the Amika preset VMs provision (`useradd amika`, with
 * passwordless sudo; see `bin/freestyle-build-snapshots.mjs`). Adapter execs
 * run as this user so the lifecycle matches the Daytona contract — repos land
 * in `/home/amika/workspace`, the uploaded dotfiles apply, and `claude
 * --dangerously-skip-permissions` (which refuses to run as root) works.
 */
const AMIKA_USER = "amika";

/**
 * `vm.user({ username })` returns a VM handle whose exec/fs/pty calls run as the
 * given Linux user (it attaches the `X-Freestyle-Vm-Linux-User-Id` header to
 * each request). The method is present in the SDK runtime (freestyle@0.1.63)
 * but missing from its published type declarations, so we type it locally. The
 * pinned SDK version guards against it changing underfoot.
 */
type UserScopable = { user(opts: { username: string }): FreestyleVm };

function scopeToUser(vm: FreestyleVm, username: string): FreestyleVm {
  return (vm as FreestyleVm & UserScopable).user({ username });
}

/**
 * Load the Amika-managed environment that provisioning persists to
 * `/etc/environment` (`AMIKA_AGENT_CWD`, `OPENCODE_*`, injected vars). Daytona
 * gets these from the container env baked at create time, not by sourcing this
 * file: a Daytona `process.exec` runs a non-login shell, and `BASH_ENV` (which
 * would make bash source the file) lives only inside `/etc/environment`, not
 * the ambient env, so it never triggers. A var that lives only in
 * `/etc/environment` is thus invisible to a Daytona `process.exec`. Freestyle
 * has no container env to inherit, so its `vm.exec` must source the file here.
 * Guarded with `[ -f ... ]` so it's a harmless no-op before the file exists
 * (early in init).
 */
const SOURCE_MANAGED_ENV =
  "[ -f /etc/environment ] && { set -a; . /etc/environment; set +a; }";

/**
 * Fold the adapter {@link ExecOptions} into a single shell script for
 * `vm.exec`. The managed env is sourced first, then any explicit env vars are
 * exported (so they win), then the working directory is changed before the
 * command runs. The `sudo` flag is not reflected in the command string —
 * {@link FreestyleAdapter.exec} selects a root vs. `amika`-scoped VM handle
 * instead.
 */
export function buildFreestyleCommand(
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
    // command can't silently run in the VM's previous cwd and let a successful
    // command mask the failed `cd` (e.g. a destructive command hitting the
    // wrong directory).
    segments.push(`cd ${shellQuote(opts.cwd)} || exit 1`);
  }
  segments.push(command);
  return segments.join("\n");
}

export class FreestyleAdapter implements SandboxAdapter {
  /** Handle whose exec/fs calls run as `amika` — the default for adapter work. */
  private readonly userVm: FreestyleVm;

  // Round-trip accounting for diagnosing slow provisions. Every adapter op is
  // a separate HTTPS call to the Freestyle API; on a chatty path (a new sandbox
  // makes ~dozens) the sum of these dominates boot time. Tracked here so the
  // orchestrators can log a per-provision breakdown via {@link roundTripStats}.
  private roundTripCount = 0;
  private roundTripMs = 0;
  private slowestMs = 0;
  private slowestLabel = "";

  /**
   * @param rootVm a VM handle that execs as root. Used only for `sudo: true`
   *   commands (system-level setup); everything else runs via {@link userVm}.
   * @param client the Freestyle SDK client the VM handle was derived from,
   *   retained so callers can reuse the one already-constructed client for
   *   further SDK work instead of building a fresh one. Optional —
   *   provider-specific and off the SDK-free {@link SandboxAdapter} port
   *   (Vercel's static SDK has no client).
   */
  constructor(
    private readonly rootVm: FreestyleVm,
    readonly client?: Freestyle,
  ) {
    this.userVm = scopeToUser(rootVm, AMIKA_USER);
  }

  /**
   * Time one provider round-trip, accumulating count + total time and tracking
   * the single slowest call. The label identifies the call (a truncated command
   * or `op:path`) so the slowest one is actionable in logs.
   */
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

  /**
   * Cumulative provider round-trip stats for this adapter since construction
   * (a fresh adapter is built per provision/restart, so this scopes to one
   * operation). Lets the orchestrators see whether a slow provision is many
   * cheap round-trips (chattiness) or a few slow commands (e.g. a setup script).
   */
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
    // `sudo: true` runs as root for system-level setup; everything else runs as
    // amika so repos, dotfiles, and agent processes are owned by the lifecycle
    // user rather than root.
    const vm = opts?.sudo ? this.rootVm : this.userVm;
    const res = await this.timed(command.slice(0, 80), () =>
      vm.exec({
        command: buildFreestyleCommand(command, opts),
      }),
    );
    return {
      exitCode: res.statusCode ?? 0,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
    };
  }

  async uploadFile(content: Buffer | string, path: string): Promise<void> {
    await this.ensureParentDir(path);
    if (typeof content === "string") {
      await this.timed(`write ${path}`, () =>
        this.userVm.fs.writeTextFile(path, content),
      );
    } else {
      await this.timed(`write ${path}`, () =>
        this.userVm.fs.writeFile(path, content),
      );
    }
    // Freestyle's `fs` write API runs as **root** regardless of the
    // amika-scoped handle, so the file lands root-owned. The shared lifecycle
    // then operates on these paths as `amika` (e.g. `chmod 600` on
    // `~/.git-credentials`, the credential-store read, the agent process), which
    // fails with "Operation not permitted" on a root-owned file. Reassign the
    // file to `amika` so writes match the Daytona contract, where user-scoped
    // writes are already user-owned. Fail loudly if the repair doesn't take —
    // a silently root-owned file reproduces exactly the bug this prevents.
    const chownResult = await this.exec(
      `chown ${AMIKA_USER}:${AMIKA_USER} ${shellQuote(path)}`,
      { sudo: true },
    );
    if (chownResult.exitCode !== 0) {
      throw new Error(
        `Failed to chown ${path} to ${AMIKA_USER}: ${execFailureText(chownResult)}`,
      );
    }
  }

  async downloadFile(path: string): Promise<string | null> {
    try {
      return await this.timed(`read ${path}`, () =>
        this.userVm.fs.readTextFile(path),
      );
    } catch {
      return null;
    }
  }

  private async ensureParentDir(path: string): Promise<void> {
    const idx = path.lastIndexOf("/");
    if (idx <= 0) return;
    const dir = path.slice(0, idx);
    // `fs.mkdir` is non-recursive in the SDK, so use `mkdir -p` to create
    // intermediate dirs. Best-effort: a real failure surfaces on the write.
    try {
      await this.timed(`mkdir ${dir}`, () =>
        this.userVm.exec({ command: `mkdir -p ${shellQuote(dir)}` }),
      );
    } catch {
      // ignore — the subsequent write surfaces a real failure.
    }
  }
}
