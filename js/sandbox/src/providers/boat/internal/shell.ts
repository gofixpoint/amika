/**
 * boat's command and file primitives, as the {@link VendorShell} the shared
 * rig-user layer (`../../shared/rig-user.ts`) runs on.
 *
 * - **Commands** go to `POST /sandboxes/{id}/commands` with `stream: true`,
 *   so output arrives as NDJSON frames (`stdout` / `stderr` with `data`,
 *   then one `exit` or `error`) and has no size cap. boat runs the command
 *   string in a shell as `user`; we send `bash -c <script>`. A command runs
 *   at most 600 seconds (a boat limit); after that boat reports `timedOut`
 *   and we return exit code 124, as `timeout` does.
 * - **Staging** writes through a signed upload URL, which takes any size
 *   and makes missing directories. boat's file API writes only under
 *   `/home/user` and `/tmp`, so staging is under `/home/user`.
 */
import { z } from "zod";
import type { SandboxExecResult, StreamCommandHandlers } from "../../provider";
import { readNdjson } from "../../shared/ndjson";
import type { VendorShell } from "../../shared/rig-user";
import { shellQuote } from "../../../util/shell";
import type { BoatConfig } from "../config";
import { BoatApiError, requestJson, sandboxPath, send } from "./client";

/** The longest command boat runs (its maximum `timeoutSeconds`). */
export const BOAT_EXEC_TIMEOUT_S = 600;

/** The exit code for a command boat stopped at its time limit. */
const TIMED_OUT_EXIT = 124;

const EXEC_REQUEST_TIMEOUT_MS = (BOAT_EXEC_TIMEOUT_S + 90) * 1000;

/** Where staged files go; boat's login user owns it. */
export const BOAT_STAGING_DIR = "/home/user/.amika-staging";

const frameSchema = z.object({
  type: z.string(),
  data: z.string().optional(),
  exitCode: z.number().nullish(),
  timedOut: z.boolean().optional(),
  signal: z.string().nullish(),
  oomKilled: z.boolean().optional(),
  error: z.string().optional(),
  message: z.string().optional(),
});

const uploadUrlSchema = z.object({ url: z.string(), method: z.string() });

export function boatShell(config: BoatConfig, sandboxId: string): VendorShell {
  return {
    run: (script) => runBoatScript(config, sandboxId, script),
    stream: async (script, handlers) =>
      (await runBoatScript(config, sandboxId, script, handlers)).exitCode,
    stagingDir: BOAT_STAGING_DIR,
    stage: async (path, content) => {
      const target = await requestJson(
        config,
        uploadUrlSchema,
        "POST",
        sandboxPath(sandboxId, "/files/upload-url"),
        { json: { path } },
      );
      // A signed URL: it carries its own auth, so no API key goes with it.
      const res = await fetch(target.url, {
        method: target.method || "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(content),
        signal: AbortSignal.timeout(10 * 60_000),
      });
      if (!res.ok) {
        throw new Error(
          `boat upload of ${path} failed: ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`,
        );
      }
      await res.body?.cancel();
    },
  };
}

/**
 * Run `script` with bash and collect its output. With `handlers`, output
 * goes to them and the result carries none.
 */
export async function runBoatScript(
  config: BoatConfig,
  sandboxId: string,
  script: string,
  handlers?: StreamCommandHandlers,
): Promise<SandboxExecResult> {
  const res = await send(config, "POST", sandboxPath(sandboxId, "/commands"), {
    json: {
      command: `bash -c ${shellQuote(script)}`,
      timeoutSeconds: BOAT_EXEC_TIMEOUT_S,
      stream: true,
    },
    timeoutMs: EXEC_REQUEST_TIMEOUT_MS,
  });
  if (!res.body) throw new Error("boat command returned no body");
  return collectFrames(readNdjson(res.body), handlers);
}

/** Fold command frames into a result. Exported for tests. */
export async function collectFrames(
  lines: AsyncIterable<string>,
  handlers?: StreamCommandHandlers,
): Promise<SandboxExecResult> {
  let stdout = "";
  let stderr = "";
  for await (const line of lines) {
    const frame = frameSchema.parse(JSON.parse(line));
    switch (frame.type) {
      case "stdout":
        if (handlers) handlers.onStdout(frame.data ?? "");
        else stdout += frame.data ?? "";
        break;
      case "stderr":
        if (handlers) handlers.onStderr?.(frame.data ?? "");
        else stderr += frame.data ?? "";
        break;
      case "exit":
        return { exitCode: exitCodeOf(frame), stdout, stderr };
      case "error":
        throw new BoatApiError(
          0,
          frame.error ?? "command_error",
          frame.message ?? line,
        );
      default:
        // `started`, and frames we do not know.
        break;
    }
  }
  throw new Error("boat command stream ended without an exit frame");
}

/** POSIX signal numbers boat may name in an `exit` frame. */
const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGABRT: 6,
  SIGKILL: 9,
  SIGSEGV: 11,
  SIGPIPE: 13,
  SIGTERM: 15,
};

/**
 * The exit code of an `exit` frame: its code when it has one; 124 for a
 * time out, as `timeout` reports; 137 for the OOM killer (SIGKILL); else
 * 128 + the signal's number, as a shell reports. Exported for tests.
 */
export function exitCodeOf(frame: {
  exitCode?: number | null;
  timedOut?: boolean;
  signal?: string | null;
  oomKilled?: boolean;
}): number {
  if (frame.exitCode != null) return frame.exitCode;
  if (frame.timedOut) return TIMED_OUT_EXIT;
  if (frame.oomKilled) return 128 + SIGNAL_NUMBERS.SIGKILL;
  const signal = frame.signal ? SIGNAL_NUMBERS[frame.signal] : undefined;
  return 128 + (signal ?? 0);
}
