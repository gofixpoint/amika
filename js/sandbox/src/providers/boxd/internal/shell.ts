/**
 * boxd's command and file primitives, as the {@link VendorShell} the shared
 * rig-user layer (`../../shared/rig-user.ts`) runs on.
 *
 * - **Commands** go through the SDK's `exec` (boxd's `Exec` stream), which
 *   runs a shell command line as `boxd`; we send `bash -c <script>`. boxd
 *   sets no time limit, so we set {@link BOXD_EXEC_TIMEOUT_MS}; cancelling
 *   the call makes boxd end the command's process group.
 * - **Staging** is `machines.fs.write`, which writes as `boxd` and makes
 *   missing directories.
 */
import type { SandboxExecResult, StreamCommandHandlers } from "../../provider";
import type { VendorShell } from "../../shared/rig-user";
import { shellQuote } from "../../../util/shell";
import type { BoxdConfig } from "../config";
import { boxdClient } from "./client";

/** The longest one command may run. */
export const BOXD_EXEC_TIMEOUT_MS = 30 * 60_000;

/** Where staged files go; boxd's login user owns it. */
export const BOXD_STAGING_DIR = "/home/boxd/.amika-staging";

export function boxdShell(config: BoxdConfig, machineId: string): VendorShell {
  return {
    run: (script) => runBoxdScript(config, machineId, script),
    stream: (script, handlers) =>
      streamBoxdScript(config, machineId, script, handlers),
    stagingDir: BOXD_STAGING_DIR,
    stage: async (path, content) => {
      const boxd = boxdClient(config);
      await boxd.machines.fs.write(machineId, path, content);
    },
  };
}

export async function runBoxdScript(
  config: BoxdConfig,
  machineId: string,
  script: string,
  timeoutMs: number = BOXD_EXEC_TIMEOUT_MS,
): Promise<SandboxExecResult> {
  const boxd = boxdClient(config);
  const result = await boxd.machines.exec(machineId, {
    command: `bash -c ${shellQuote(script)}`,
    timeout: timeoutMs,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function streamBoxdScript(
  config: BoxdConfig,
  machineId: string,
  script: string,
  handlers: StreamCommandHandlers,
): Promise<number> {
  const boxd = boxdClient(config);
  const stream = boxd.machines.streamExec(machineId, {
    command: `bash -c ${shellQuote(script)}`,
    closeStdin: true,
  });
  const timer = setTimeout(() => stream.close(), BOXD_EXEC_TIMEOUT_MS);
  try {
    const pump = async (
      source: AsyncIterable<Uint8Array>,
      emit: (chunk: string) => void,
    ) => {
      const decoder = new TextDecoder();
      for await (const chunk of source) {
        emit(decoder.decode(chunk, { stream: true }));
      }
      const rest = decoder.decode();
      if (rest) emit(rest);
    };
    await Promise.all([
      pump(stream.stdout, (c) => handlers.onStdout(c)),
      pump(stream.stderr, (c) => handlers.onStderr?.(c)),
    ]);
    return await stream.wait();
  } finally {
    clearTimeout(timer);
  }
}
