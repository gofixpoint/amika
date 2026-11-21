/**
 * Build the command line one SSH exec runs, and the provider's exec and file
 * calls on top of `./ssh.ts`.
 *
 * SSH hands the command line to the `amika` user's login shell, so every
 * value in it is quoted. The command itself runs with `bash -lc`, as on the
 * other providers.
 */
import type {
  ExecCommandOptions,
  ReadFileBytesOptions,
  SandboxExecResult,
  StreamCommandHandlers,
} from "../../provider";
import { shellQuote } from "../../../util/shell";
import type { GcpTarget } from "./client";
import { execGcp, readGcpFile, writeGcpFile } from "./ssh";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Command input larger than this is refused, as on the other providers. */
const MAX_STDIN_BYTES = 1024 * 1024;

type ExecOpts = Pick<ExecCommandOptions, "cwd" | "env" | "sudo">;

/** The login-shell command line for `command` with `opts`. Exported for tests. */
export function gcpCommandLine(command: string, opts: ExecOpts = {}): string {
  const env = Object.entries(opts.env ?? {});
  for (const [name] of env) {
    if (!ENV_NAME.test(name)) {
      throw new Error(`Invalid environment variable name: ${name}`);
    }
  }
  const script = opts.cwd
    ? `cd -- ${shellQuote(opts.cwd)} && ${command}`
    : command;
  return [
    // `sudo` resets the environment, so the variables go through `env`
    // inside it.
    ...(opts.sudo ? ["sudo", "-n"] : []),
    "env",
    ...env.map(([name, value]) => shellQuote(`${name}=${value}`)),
    "bash",
    "-lc",
    shellQuote(script),
  ].join(" ");
}

export async function execGcpCommand(
  target: GcpTarget,
  instanceName: string,
  command: string,
  opts: ExecOpts & Pick<ExecCommandOptions, "input"> = {},
): Promise<SandboxExecResult> {
  if (
    opts.input !== undefined &&
    Buffer.byteLength(opts.input, "utf8") > MAX_STDIN_BYTES
  ) {
    throw new Error("Command input exceeds the 1 MiB limit");
  }
  return execGcp(target, instanceName, gcpCommandLine(command, opts), {
    input: opts.input,
  });
}

export async function streamGcpCommand(
  target: GcpTarget,
  instanceName: string,
  command: string,
  handlers: StreamCommandHandlers,
): Promise<void> {
  await execGcp(target, instanceName, gcpCommandLine(command), { handlers });
}

export function readGcpFileBytes(
  target: GcpTarget,
  instanceName: string,
  path: string,
  opts?: ReadFileBytesOptions,
): Promise<Uint8Array | null> {
  return readGcpFile(target, instanceName, path, opts?.maxBytes);
}

/** Write a file as the `amika` user, creating parent directories. */
export async function writeGcpFileWithParents(
  target: GcpTarget,
  instanceName: string,
  path: string,
  content: Buffer | string,
): Promise<void> {
  const slash = path.lastIndexOf("/");
  if (slash > 0) {
    const parent = path.slice(0, slash);
    const made = await execGcp(
      target,
      instanceName,
      `mkdir -p -- ${shellQuote(parent)}`,
    );
    if (made.exitCode !== 0) {
      throw new Error(
        `Could not create ${parent}: ${made.stderr.trim() || made.stdout.trim()}`,
      );
    }
  }
  await writeGcpFile(target, instanceName, path, content);
}
