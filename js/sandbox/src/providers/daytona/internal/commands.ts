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
 * Build the on-box command string for Daytona's `process.executeCommand`.
 * Non-sudo commands run verbatim (Daytona execs them through a shell, so
 * compound commands already work). For `sudo: true` we:
 *
 *   - run the *entire* command in a root shell (`bash -c '<command>'`) so a
 *     compound command / pipeline / redirection runs fully elevated, not just
 *     its first simple command; and
 *   - extend `--preserve-env` with the caller's explicit `env` keys (on top of
 *     the Amika hook vars) so `sudo`'s environment reset doesn't strip the
 *     variables the public `ExecCommandOptions.env` promises to expose.
 *
 * `sudo -n` is non-interactive so it fails fast instead of hanging on a
 * password prompt. Exported for unit testing.
 */
export function buildDaytonaCommand(
  command: string,
  opts?: { env?: Record<string, string>; sudo?: boolean },
): string {
  if (!opts?.sudo) return command;
  const preserve = [...SUDO_PRESERVE_ENV_BASE, ...Object.keys(opts.env ?? {})];
  return `sudo -n --preserve-env=${preserve.join(",")} bash -c ${shellQuote(command)}`;
}

/** Shell-legal environment variable name; anything else is rejected. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * Wrap {@link buildDaytonaCommand} with the `cwd` and `env` that Daytona's
 * one-shot `process.executeCommand` used to apply for us.
 *
 * Sessions carry no cwd/env parameters (`SessionExecuteRequest` is just a
 * command string), so both are applied in the outer shell, before `sudo`,
 * so that `--preserve-env` actually has something to preserve. Exported for
 * unit testing.
 */
export function buildDaytonaSessionCommand(
  command: string,
  opts?: { cwd?: string; env?: Record<string, string>; sudo?: boolean },
): string {
  const prefix: string[] = [];
  if (opts?.cwd) prefix.push(`cd ${shellQuote(opts.cwd)}`);
  for (const [name, value] of Object.entries(opts?.env ?? {})) {
    if (!ENV_NAME_RE.test(name)) {
      throw new Error(`Invalid environment variable name: ${name}`);
    }
    prefix.push(`export ${name}=${shellQuote(value)}`);
  }
  return [...prefix, buildDaytonaCommand(command, opts)].join(" && ");
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
    : executeSessionCommand(sandbox, command, opts);
}

const MAX_COMMAND_INPUT_BYTES = 1024 * 1024;

type DaytonaSandbox = Awaited<ReturnType<Daytona["get"]>>;

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
 * Run one command in a session and read back its two streams.
 *
 * Sessions rather than `process.executeCommand`, which returns only a single
 * combined `result` string: stderr folded into the value stream corrupts
 * every caller that parses stdout (host keys, JSON, PIDs). A synchronous
 * session command reports `stdout`, `stderr`, and the exit code directly, so
 * this costs one extra round-trip over the one-shot API, not several.
 */
async function executeSessionCommand(
  sandbox: DaytonaSandbox,
  command: string,
  opts?: { cwd?: string; env?: Record<string, string>; sudo?: boolean },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return withSession(sandbox, async (sessionId) => {
    const response = await sandbox.process.executeSessionCommand(sessionId, {
      command: buildDaytonaSessionCommand(command, opts),
    });
    return {
      exitCode: response.exitCode ?? 1,
      stdout: response.stdout ?? "",
      stderr: response.stderr ?? "",
    };
  });
}

/**
 * As {@link executeSessionCommand}, but with `input` on the command's stdin.
 *
 * Sending stdin needs the command's id, which only an async run hands back
 * before the command finishes, so this variant runs detached and collects the
 * streams from the log callbacks instead.
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
