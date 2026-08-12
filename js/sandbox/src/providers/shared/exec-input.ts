/** Securely emulate stdin for providers whose SDK exposes only exec + files. */
import { randomUUID } from "node:crypto";
import { shellQuote } from "../../util/shell";
import type { ExecOptions, ExecResult, SandboxAdapter } from "./adapter";

const MAX_INPUT_BYTES = 1024 * 1024;
export const EXEC_INPUT_STAGING_ROOT = "/tmp/.amika-exec-inputs";

/**
 * Stage input in a private, unpredictable directory, redirect it to the
 * command, and remove it in a finally block. The bytes never enter argv,
 * environment variables, provider logs, or an Amika-specific provider API.
 */
export async function execWithStagedInput(
  adapter: SandboxAdapter,
  command: string,
  input: string,
  opts?: ExecOptions,
): Promise<ExecResult> {
  if (Buffer.byteLength(input, "utf8") > MAX_INPUT_BYTES) {
    throw new Error("Command input exceeds the 1 MiB limit");
  }
  const directory = `${EXEC_INPUT_STAGING_ROOT}/${randomUUID()}`;
  const inputPath = `${directory}/stdin`;
  const prepared = await adapter.exec(
    `install -d -m 0700 ${shellQuote(EXEC_INPUT_STAGING_ROOT)} ${shellQuote(directory)}`,
  );
  if (prepared.exitCode !== 0) {
    throw new Error("Failed to prepare command input");
  }
  try {
    await adapter.uploadFile(input, inputPath);
    const protectedInput = await adapter.exec(
      `chmod 0600 ${shellQuote(inputPath)}`,
    );
    if (protectedInput.exitCode !== 0) {
      throw new Error("Failed to protect command input");
    }
    return await adapter.exec(`(${command}) < ${shellQuote(inputPath)}`, opts);
  } finally {
    await adapter
      .exec(
        `rm -rf -- ${shellQuote(directory)} && rmdir ${shellQuote(EXEC_INPUT_STAGING_ROOT)} 2>/dev/null || true`,
      )
      .catch(() => undefined);
  }
}
