/**
 * Command execution and workspace path helpers for Daytona sandboxes.
 */
import { Daytona } from "@daytonaio/sdk";
import { randomUUID } from "node:crypto";
import { shellQuote } from "../../../util/shell";
import { execFailureText } from "../../shared/adapter";

/**
 * Amika hook vars that must survive the `sudo` environment reset even when the
 * caller passes no explicit `env` (the lifecycle scripts read these).
 */
const SUDO_PRESERVE_ENV_BASE = [
  "AMIKA_AGENT_CWD",
  "AMIKA_OPENCODE_WEB",
  "OPENCODE_SERVER_PASSWORD",
] as const;

/**
 * Build the on-box command string for a Daytona exec, one-shot or session.
 * Both paths run the *entire* command as the single quoted argument of a
 * `bash -c`, which buys three things:
 *
 *   - **Syntactic isolation.** Every caller embeds this inside a larger script
 *     — a subshell for the stream split, a pipeline for stdin. As one word the
 *     command cannot interact with that script's syntax: a trailing comment
 *     can't swallow the closing paren, a trailing `&` can't strand it, and a
 *     multi-line command can't escape a preceding `&&`.
 *   - **A known interpreter.** Daytona runs the outer script under `zsh`
 *     (verified on a live sandbox), which is close to but not `bash` — word
 *     splitting differs most notably. Callers write bash, so run bash.
 *   - **Shell-state containment**, which matters on the session path: a session
 *     is a long-lived shell, and a script's `set -e` sent as bare text would
 *     take it down before the agent recorded an exit status.
 *
 * `sudo: true` additionally elevates the whole command rather than just its
 * first simple command, and extends `--preserve-env` with the caller's explicit
 * `env` keys (on top of the Amika hook vars) so `sudo`'s environment reset
 * doesn't strip the variables `ExecCommandOptions.env` promises to expose.
 * `sudo -n` is non-interactive so it fails fast rather than hanging on a
 * password prompt. Exported for unit testing.
 */
export function buildDaytonaCommand(
  command: string,
  opts?: { env?: Record<string, string>; sudo?: boolean },
): string {
  assertEnvNames(opts?.env);
  const inner = `bash -c ${shellQuote(command)}`;
  if (!opts?.sudo) return inner;
  const preserve = [...SUDO_PRESERVE_ENV_BASE, ...Object.keys(opts.env ?? {})];
  return `sudo -n --preserve-env=${preserve.join(",")} ${inner}`;
}

/** Shell-legal environment variable name; anything else is rejected. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * Reject any environment variable name that isn't shell-legal.
 *
 * Both builders interpolate these names into a command string unquoted — into
 * `sudo --preserve-env=` here, and into an `export` on the session path — so a
 * name is never safe to take on trust. Checked in {@link buildDaytonaCommand}
 * rather than only at the call sites because every exec path funnels through
 * it, which is what makes the guard unbypassable.
 */
function assertEnvNames(env?: Record<string, string>): void {
  for (const name of Object.keys(env ?? {})) {
    if (!ENV_NAME_RE.test(name)) {
      throw new Error(`Invalid environment variable name: ${name}`);
    }
  }
}

/**
 * Wrap {@link buildDaytonaCommand} with the `cwd` and `env` that Daytona's
 * one-shot `process.executeCommand` takes as parameters.
 *
 * Only the stdin path needs this: a `SessionExecuteRequest` is just a command
 * string, with nowhere to put either. Both are applied in the session shell,
 * ahead of the command, so it inherits the working directory and the exported
 * variables, and on the sudo path `--preserve-env` then has something to
 * preserve.
 *
 * A plain `&&` chain is enough because {@link buildDaytonaCommand} hands back a
 * single `bash -c '…'` word: there is no second line for the `&&` to miss, so a
 * failed `cd` stops everything. Exported for unit testing.
 */
export function buildDaytonaSessionCommand(
  command: string,
  opts?: { cwd?: string; env?: Record<string, string>; sudo?: boolean },
): string {
  assertEnvNames(opts?.env);
  const setup: string[] = [];
  if (opts?.cwd) setup.push(`cd ${shellQuote(opts.cwd)}`);
  for (const [name, value] of Object.entries(opts?.env ?? {})) {
    setup.push(`export ${name}=${shellQuote(value)}`);
  }
  return [...setup, buildDaytonaCommand(command, opts)].join(" && ");
}

export async function executeCommand(
  sandbox: Awaited<ReturnType<Daytona["get"]>>,
  command: string,
  opts?: {
    cwd?: string;
    env?: Record<string, string>;
    sudo?: boolean;
    input?: string;
  },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // An empty string means "no bytes on stdin", which is what a command with no
  // stdin wiring already sees, so it takes the same path as the no-input case.
  return opts?.input
    ? executeSessionCommandWithInput(sandbox, command, opts.input, opts)
    : executeOneShotCommand(sandbox, command, opts);
}

const MAX_COMMAND_INPUT_BYTES = 1024 * 1024;

type DaytonaSandbox = Awaited<ReturnType<Daytona["get"]>>;

/**
 * Run one command through Daytona's one-shot `process.executeCommand`.
 *
 * Deliberately *not* a process session. Daytona owns a session's processes and
 * kills them when the session is deleted, `nohup` and `setsid` included, so a
 * command whose point is the daemon it leaves behind loses it the moment the
 * command returns. The one-shot API has no owning session, so it survives.
 *
 * Sessions were reached for because this API reports a single combined
 * `result`, with stderr folded into the value stream, corrupting any caller
 * that parses stdout. {@link buildStreamSplitCommand} recovers the two streams
 * on-box instead, so both properties hold at one round-trip per command.
 */
async function executeOneShotCommand(
  sandbox: DaytonaSandbox,
  command: string,
  opts?: { cwd?: string; env?: Record<string, string>; sudo?: boolean },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const marker = `--amika-stderr-${randomUUID()}--`;
  const response = await sandbox.process.executeCommand(
    buildStreamSplitCommand(buildDaytonaCommand(command, opts), marker),
    opts?.cwd,
    opts?.env,
  );
  // `ExecuteResponse.exitCode` is typed `number` but the wire model has it
  // optional, so TypeScript cannot catch an omitted value; the stdin path has
  // carried the same fallback all along.
  const exitCode = response.exitCode ?? 1;
  return {
    exitCode,
    ...splitStreamsAtMarker(response.result, marker, exitCode),
  };
}

/**
 * Wrap a command so its two streams survive a transport that carries only one.
 *
 * `command`'s stderr is captured to a temp file; once it has exited, the
 * response body is its stdout, then `marker`, then the captured stderr, so
 * {@link splitStreamsAtMarker} can cut the two apart. The command's own exit
 * status is re-raised at the end, so the wrapper is invisible to the caller.
 * `marker` must be unique per command, so that no legitimate output can
 * contain it and split at the wrong place.
 *
 * That capture file is unlinked as soon as it exists and is read back through a
 * surviving descriptor, so stderr is never reachable on disk under any name.
 *
 * `command` arrives from {@link buildDaytonaCommand} as a single `bash -c '…'`
 * word, so nothing in it can interact with this script's syntax. Exported for
 * unit testing.
 */
export function buildStreamSplitCommand(
  command: string,
  marker: string,
): string {
  return [
    // Bail if the capture file can't be made. Without this the redirect below
    // becomes `2>""`, which fails, which means the subshell never runs at all —
    // and the wrapper would still print its marker, so the split would succeed
    // and hand the caller shell diagnostics that look like command output. A
    // full or read-only /tmp is enough to trigger it. Exiting here leaves no
    // marker, so `splitStreamsAtMarker` reports the failure text as stderr.
    "__amika_err=$(mktemp) || exit 125",
    '[ -n "$__amika_err" ] || exit 125',
    // Cleanup for the one window where the capture has a name: between `mktemp`
    // and the `rm` two lines below. A redirection error on `exec` — a special
    // built-in — is fatal to a non-interactive shell in dash and `sh`, which kill
    // the script before any `||` branch can run, so that branch alone cannot
    // clean up and this trap is what does. After the `rm` it is a no-op on a path
    // that no longer exists, which is why an untrappable kill past that point
    // still leaves nothing: there is no file, not merely no handler.
    `trap 'rm -f -- "$__amika_err"' EXIT`,
    // Everything from here writes stderr to the capture file, this script
    // included. Redirecting only the command would leave the wrapper's own
    // diagnostics — a `Terminated` on a group kill, an OOM notice — in the
    // response *ahead* of the marker, i.e. reported as stdout, which is the
    // one thing `ExecResult.stdout` promises never to carry.
    //
    // Guarded because bash, unlike dash, treats a failed redirection on a bare
    // `exec` as non-fatal and carries on. Unguarded there, it would run the
    // command and print its marker with no usable capture, reporting a clean
    // success carrying no stderr at all — the silently-wrong answer this framing
    // exists to prevent.
    //
    // Only fd 2 is redirected, and only onto a descriptor that already exists.
    // An earlier revision also opened a second descriptor to read the capture
    // back; that needed a free high fd, so `RLIMIT_NOFILE` below 10 broke it, and
    // it was inherited by every process the command left running — pinning the
    // unlinked inode for a daemon's whole life even when the daemon redirected
    // its own streams, since that replaces fd 1 and 2 and never touches fd 9.
    // Reading through `/proc/self/fd/2` needs no second descriptor and so has
    // neither problem.
    'exec 2>"$__amika_err" || exit 125',
    // Unlink the name immediately. From here the capture exists only as an open
    // inode: writes still land through fd 2, and it still reads back through
    // `/proc/self/fd/2`, but no path resolves to it.
    //
    // Cleanup used to be an `EXIT` trap, which a `SIGKILL`, an OOM kill, or a
    // sandbox force-stopped mid-command never runs — leaving the file on disk
    // with the command's stderr in it. Stderr is not reliably non-sensitive: a
    // failed `git clone https://x-access-token:<token>@…` prints the tokenized
    // URL there. Snapshots capture the filesystem opaquely and are forkable, so
    // that residue would be baked in and travel. Unlinking up front removes the
    // window rather than cleaning up after it — there is no name to leak, and
    // the kernel frees the inode when the process dies however it dies.
    //
    // Fails closed: proceeding with a still-named capture file would reinstate
    // exactly the exposure this prevents. `--` so a `TMPDIR` beginning with `-`
    // can't make the path read as flags.
    'rm -f -- "$__amika_err" || exit 125',
    // Emit whatever the command produced, then leave with the signal's
    // conventional status. A POSIX trap handler resumes where the shell was
    // rather than exiting, so a handler that fell through would report the
    // command's own status for a wrapper that was told to stop. Exiting without
    // emitting first is no better: the response would carry no marker, and the
    // whole of stdout would be reported as failure text.
    // `__amika_emitted` keeps a signal that lands *during* the normal emit
    // below from emitting a second time: two markers in one response would
    // leave the split reporting the captured stderr twice with a raw marker
    // between the copies.
    // Cleared explicitly: `env` may legally carry a leading-underscore name, so
    // an inherited `__amika_emitted` would otherwise suppress the bail emit.
    "__amika_emitted=",
    `__amika_bail() { if [ -z "$__amika_emitted" ]; then __amika_emit; fi; exit "$1"; }`,
    // Reads the capture through the kernel's own handle on fd 2 rather than by
    // path, since the path is already gone. A fresh open, so it starts at offset
    // 0 regardless of how much stderr has been written. `self` is `cat`, whose
    // fd 2 it inherited from this shell, so it reopens the same inode; the
    // command ran in a subshell, so nothing it did to its own copy applies here.
    `__amika_emit() { __amika_emitted=1; printf '%s' ${shellQuote(marker)}; cat /proc/self/fd/2; }`,
    "trap '__amika_bail 130' INT",
    "trap '__amika_bail 143' TERM",
    "trap '__amika_bail 129' HUP",
    `( ${command} )`,
    "__amika_rc=$?",
    "__amika_emit",
    `exit "$__amika_rc"`,
  ].join("\n");
}

/** Cut a {@link buildStreamSplitCommand} response back into its two streams. */
function splitStreamsAtMarker(
  combined: string,
  marker: string,
  exitCode: number,
): { stdout: string; stderr: string } {
  const at = combined.indexOf(marker);
  if (at === -1) {
    // The wrapper never reached its `printf`, so this is not command output at
    // all — the shell itself failed to start, or the command took the process
    // down with it. On a failure that text is the only diagnostic there is, so
    // route it where `execFailureText` will find it rather than leaving it to
    // be parsed as a value.
    return exitCode === 0
      ? { stdout: combined, stderr: "" }
      : { stdout: "", stderr: combined };
  }
  return {
    stdout: combined.slice(0, at),
    stderr: combined.slice(at + marker.length),
  };
}

/** Run `body` against a throwaway session, always tearing the session down. */
async function withSession<T>(
  sandbox: DaytonaSandbox,
  body: (sessionId: string) => Promise<T>,
): Promise<T> {
  const sessionId = `exec-${randomUUID()}`;
  await sandbox.process.createSession(sessionId);
  try {
    return await body(sessionId);
  } finally {
    await sandbox.process.deleteSession(sessionId).catch(() => {});
  }
}

/**
 * As {@link executeOneShotCommand}, but with `input` on the command's stdin.
 *
 * Sending stdin needs the command's id, which only a session's async run hands
 * back before the command finishes, so this variant alone still pays for a
 * session — and gets the two streams from the log callbacks for free. Deleting
 * that session reaps whatever the command left running, which is safe here: a
 * command fed bytes on stdin consumes them and exits rather than daemonizing.
 */
async function executeSessionCommandWithInput(
  sandbox: DaytonaSandbox,
  command: string,
  input: string,
  opts?: { cwd?: string; env?: Record<string, string>; sudo?: boolean },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const byteLength = Buffer.byteLength(input, "utf8");
  if (byteLength > MAX_COMMAND_INPUT_BYTES) {
    throw new Error("Command input exceeds the 1 MiB limit");
  }
  return withSession(sandbox, async (sessionId) => {
    // Daytona does not expose a close-stdin operation. Bound the reader to the
    // exact byte count so the command sees EOF without putting input in argv.
    //
    // The parens are load-bearing beyond grouping the pipe's right-hand side: a
    // session is a long-lived shell, and bare text would run *in* it, so a
    // script's `set -e` would take the shell down before the agent recorded an
    // exit code and this call would wait on a result that never comes. Both the
    // pipeline and the explicit subshell confine that state to a child.
    const onBox = buildDaytonaSessionCommand(command, opts);
    const response = await sandbox.process.executeSessionCommand(sessionId, {
      command: `head -c ${byteLength} | (${onBox})`,
      runAsync: true,
      suppressInputEcho: true,
    });
    if (!response.cmdId) throw new Error("Daytona command returned no id");
    await sandbox.process.sendSessionCommandInput(
      sessionId,
      response.cmdId,
      input,
    );
    const stdout: string[] = [];
    const stderr: string[] = [];
    await sandbox.process.getSessionCommandLogs(
      sessionId,
      response.cmdId,
      (chunk) => stdout.push(chunk),
      (chunk) => stderr.push(chunk),
    );
    const completed = await sandbox.process.getSessionCommand(
      sessionId,
      response.cmdId,
    );
    return {
      exitCode: completed.exitCode ?? 1,
      stdout: stdout.join(""),
      stderr: stderr.join(""),
    };
  });
}

export async function executeCheckedCommand(
  sandbox: Awaited<ReturnType<Daytona["get"]>>,
  command: string,
  opts?: {
    cwd?: string;
    env?: Record<string, string>;
    sudo?: boolean;
  },
): Promise<void> {
  const result = await executeCommand(sandbox, command, opts);
  if (result.exitCode !== 0) {
    throw new Error(execFailureText(result) || `Command failed: ${command}`);
  }
}

// Workspace path helpers are provider-agnostic; re-exported from the shared
// module so there is a single definition shared with the Freestyle provider.
export { getWorkspaceDir, getRepoDir } from "../../shared/adapter-helpers";
