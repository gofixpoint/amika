/**
 * Commands and files as the `amika` rig user, on a vendor whose own login
 * user is someone else.
 *
 * Every provider runs commands as `amika` (see amika-mono's spec 037). Some
 * vendors fix the login user and give it passwordless `sudo`: boat logs in
 * as `user`, Orble as `agent`, boxd as `boxd`, Runtime as `runtime`. Their
 * file APIs write as that user, and some refuse paths outside its home.
 *
 * {@link rigUserOps} builds the provider's exec and file calls on three
 * vendor primitives ({@link VendorShell}):
 *
 * - **Exec** wraps the command in `sudo -u amika`, so it runs as `amika` in
 *   `amika`'s home. With `sudo: true` it runs as root instead.
 * - **Write** stages the bytes through the vendor's file API, then a
 *   command pipes them into place as `amika`. The write creates parent
 *   directories, and a file that exists keeps its mode, as a write by the
 *   machine user does on the other providers.
 * - **Read** runs `base64` as `amika`, so a file `amika` cannot read is
 *   refused, as it would be on the other providers.
 * - **Stdin** stages the input as a file and pipes it to the command.
 *
 * The provider calls {@link RigUserOps.ensureRigUser} when it creates a
 * sandbox, before any other call. It makes `amika` with home
 * `/home/amika` and passwordless `sudo`. `amikad bootstrap` later finds the
 * user and keeps it.
 */
import { randomUUID } from "node:crypto";
import { DEFAULT_HOME_DIR } from "../../constants";
import { shellQuote } from "../../util/shell";
import {
  SandboxFileTooLargeError,
  type ExecCommandOptions,
  type ReadFileBytesOptions,
  type SandboxExecResult,
  type StreamCommandHandlers,
} from "../provider";

/** The rig user every provider runs commands as. */
export const RIG_USER = "amika";

/** The rig user's home on a vendor whose own user is someone else. */
export const RIG_USER_HOME = DEFAULT_HOME_DIR;

/** Command input larger than this is refused, as on the other providers. */
const MAX_INPUT_BYTES = 1024 * 1024;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The exit code the read script gives for a missing file. */
const READ_MISSING_EXIT = 3;
/** The exit code the read script gives for a file `amika` cannot read. */
const READ_DENIED_EXIT = 4;

/**
 * What a vendor gives: a bash script run as its own login user, who has
 * passwordless `sudo`, and a file write to a path that user owns.
 */
export interface VendorShell {
  /** Run `script` with bash as the vendor's login user. */
  run(script: string): Promise<SandboxExecResult>;
  /** Run `script` and send its output to `handlers` as it arrives. */
  stream?(script: string, handlers: StreamCommandHandlers): Promise<number>;
  /**
   * A directory the vendor's login user may write with {@link stage}.
   * Staged files are removed once used.
   */
  stagingDir: string;
  /** Write `content` to `path` (inside {@link stagingDir}) as the vendor user. */
  stage(path: string, content: Uint8Array): Promise<void>;
}

/** Raised when the rig user may not read a file. */
export class RigFilePermissionError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`Permission denied reading ${path}`);
    this.name = "RigFilePermissionError";
    this.path = path;
  }
}

export interface RigUserOps {
  ensureRigUser(): Promise<void>;
  exec(command: string, opts?: ExecCommandOptions): Promise<SandboxExecResult>;
  stream(command: string, handlers: StreamCommandHandlers): Promise<void>;
  readFile(
    path: string,
    opts?: ReadFileBytesOptions,
  ): Promise<Uint8Array | null>;
  writeFile(path: string, content: Buffer | string): Promise<void>;
}

/** Exec and file calls as the rig user, over `shell`. */
export function rigUserOps(shell: VendorShell): RigUserOps {
  return {
    ensureRigUser: async () => {
      const result = await shell.run(ensureRigUserScript());
      if (result.exitCode !== 0) {
        throw new Error(
          `Could not create the ${RIG_USER} user: ${failureText(result)}`,
        );
      }
    },

    exec: async (command, opts = {}) => {
      const line = rigCommandLine(command, opts);
      if (opts.input === undefined) return shell.run(line);
      if (Buffer.byteLength(opts.input, "utf8") > MAX_INPUT_BYTES) {
        throw new Error("Command input exceeds the 1 MiB limit");
      }
      return withStaged(shell, opts.input, (staged) =>
        shell.run(
          `set -o pipefail; sudo -n cat -- ${shellQuote(staged)} | ${line}`,
        ),
      );
    },

    stream: async (command, handlers) => {
      const line = rigCommandLine(command);
      if (shell.stream) {
        await shell.stream(line, handlers);
        return;
      }
      // No vendor stream: deliver the output when the command ends.
      const result = await shell.run(line);
      if (result.stdout) handlers.onStdout(result.stdout);
      if (result.stderr) handlers.onStderr?.(result.stderr);
    },

    readFile: async (path, opts) => {
      const result = await shell.run(readFileScript(path, opts?.maxBytes));
      if (result.exitCode === READ_MISSING_EXIT) return null;
      if (result.exitCode === READ_DENIED_EXIT) {
        throw new RigFilePermissionError(path);
      }
      if (result.exitCode !== 0) {
        throw new Error(`Could not read ${path}: ${failureText(result)}`);
      }
      const bytes = new Uint8Array(Buffer.from(result.stdout.trim(), "base64"));
      if (opts?.maxBytes !== undefined && bytes.byteLength > opts.maxBytes) {
        throw new SandboxFileTooLargeError(path, opts.maxBytes);
      }
      return bytes;
    },

    writeFile: async (path, content) => {
      const bytes =
        typeof content === "string"
          ? new TextEncoder().encode(content)
          : new Uint8Array(content);
      const result = await withStaged(shell, bytes, (staged) =>
        shell.run(writeFileScript(staged, path)),
      );
      if (result.exitCode !== 0) {
        throw new Error(`Could not write ${path}: ${failureText(result)}`);
      }
    },
  };
}

/**
 * The script that makes `amika`: a user and group with home
 * {@link RIG_USER_HOME}, a login shell, and passwordless `sudo`. It changes
 * nothing when the user exists. Exported for tests.
 */
export function ensureRigUserScript(): string {
  const user = shellQuote(RIG_USER);
  const home = shellQuote(RIG_USER_HOME);
  return [
    "set -eu",
    `if ! id -u ${user} >/dev/null 2>&1; then`,
    `  sudo -n useradd --create-home --user-group --home-dir ${home} --shell /bin/bash ${user}`,
    "fi",
    `echo ${shellQuote(`${RIG_USER} ALL=(ALL) NOPASSWD:ALL`)} | sudo -n tee /etc/sudoers.d/90-amika >/dev/null`,
    "sudo -n chmod 0440 /etc/sudoers.d/90-amika",
  ].join("\n");
}

/**
 * The command line that runs `command` as `amika` (or root, with `sudo`),
 * in `cwd` or the user's home, with `env` exported. Exported for tests.
 */
export function rigCommandLine(
  command: string,
  opts: Pick<ExecCommandOptions, "cwd" | "env" | "sudo"> = {},
): string {
  const env = Object.entries(opts.env ?? {});
  for (const [name] of env) {
    if (!ENV_NAME.test(name)) {
      throw new Error(`Invalid environment variable name: ${name}`);
    }
  }
  const dir = opts.cwd ? shellQuote(opts.cwd) : '"$HOME"';
  return [
    "sudo",
    "-n",
    // `-H` sets HOME to the target user's home; `env` passes the variables
    // through `sudo`, which would reset them.
    ...(opts.sudo ? ["-H"] : ["-H", "-u", RIG_USER]),
    "env",
    ...env.map(([name, value]) => shellQuote(`${name}=${value}`)),
    "bash",
    "-lc",
    shellQuote(`cd -- ${dir} && ${command}`),
  ].join(" ");
}

/**
 * Copy the staged file to `dest` as `amika`, making parent directories. A
 * file that exists keeps its mode and owner. Exported for tests.
 */
export function writeFileScript(staged: string, dest: string): string {
  const writer = `mkdir -p -- "$(dirname -- "$1")" && cat > "$1"`;
  return [
    "set -o pipefail",
    `sudo -n cat -- ${shellQuote(staged)} | sudo -n -H -u ${RIG_USER} bash -c ${shellQuote(writer)} bash ${shellQuote(dest)}`,
  ].join("\n");
}

/**
 * Print the file as base64, read as `amika`: exit 3 when it is missing, 4
 * when `amika` may not read it. With `maxBytes`, read one byte more than
 * the cap, so a larger file is caught without reading all of it. Exported
 * for tests.
 */
export function readFileScript(path: string, maxBytes?: number): string {
  const p = shellQuote(path);
  const read =
    maxBytes === undefined
      ? `base64 -w0 < ${p}`
      : `head -c ${maxBytes + 1} < ${p} | base64 -w0`;
  const script = [
    `[ -e ${p} ] || exit ${READ_MISSING_EXIT}`,
    `[ -r ${p} ] || exit ${READ_DENIED_EXIT}`,
    `set -o pipefail; ${read}`,
  ].join("\n");
  return `sudo -n -H -u ${RIG_USER} bash -c ${shellQuote(script)}`;
}

/** Stage `content`, run `fn` with its path, then remove it. */
async function withStaged<T>(
  shell: VendorShell,
  content: string | Uint8Array,
  fn: (staged: string) => Promise<T>,
): Promise<T> {
  const staged = `${shell.stagingDir}/${randomUUID()}`;
  await shell.stage(
    staged,
    typeof content === "string" ? new TextEncoder().encode(content) : content,
  );
  try {
    return await fn(staged);
  } finally {
    await shell
      .run(`sudo -n rm -f -- ${shellQuote(staged)}`)
      .catch(() => undefined);
  }
}

function failureText(result: SandboxExecResult): string {
  return (
    result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`
  );
}
