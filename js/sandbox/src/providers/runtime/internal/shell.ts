/**
 * Runtime's command and file primitives, as the {@link VendorShell} the
 * shared rig-user layer (`../../shared/rig-user.ts`) runs on.
 *
 * - **Commands** go to `POST /sandboxes/{id}:exec` as argv
 *   (`["bash", "-c", script]`) with `stream: true`, so output arrives as
 *   NDJSON events: `stdout` / `stderr` with `data`, then one `exit`. When
 *   Runtime cuts the stream it sends `continue`, and we read the rest from
 *   the process's output. A command runs as Runtime's `runtime` user, at
 *   most {@link RUNTIME_EXEC_TIMEOUT_S} seconds.
 * - **Staging** is `PUT /sandboxes/{id}/files`, raw bytes of any size, as
 *   `runtime`. It makes missing directories. Runtime keeps only the latest
 *   1 MiB of a command's output, so reads go through a staged copy too,
 *   read back as raw bytes with `GET /sandboxes/{id}/files`.
 */
import { z } from "zod";
import type { SandboxExecResult, StreamCommandHandlers } from "../../provider";
import { readNdjson } from "../../shared/ndjson";
import type { VendorShell } from "../../shared/rig-user";
import type { RuntimeConfig } from "../config";
import { RuntimeApiError, requestJson, sandboxPath, send } from "./client";

/** The longest one command may run. Runtime itself has no limit. */
export const RUNTIME_EXEC_TIMEOUT_S = 30 * 60;

/** The exit code for a command stopped at its time limit, as `timeout`. */
const TIMED_OUT_EXIT = 124;

const EXEC_REQUEST_TIMEOUT_MS = (RUNTIME_EXEC_TIMEOUT_S + 60) * 1000;

/** Where staged files go; Runtime's login user owns it. */
export const RUNTIME_STAGING_DIR = "/workspace/.amika-staging";

const eventSchema = z.object({
  type: z.string(),
  data: z.string().optional(),
  processId: z.string().optional(),
  cursor: z.number().optional(),
  exitCode: z.number().nullish(),
  state: z.string().optional(),
  timedOut: z.boolean().optional(),
  error: z
    .object({ code: z.string().optional(), message: z.string().optional() })
    .optional(),
});

export function runtimeShell(
  config: RuntimeConfig,
  sandboxId: string,
): VendorShell {
  return {
    run: (script) => runRuntimeScript(config, sandboxId, script),
    stream: async (script, handlers) =>
      (await runRuntimeScript(config, sandboxId, script, handlers)).exitCode,
    stagingDir: RUNTIME_STAGING_DIR,
    stage: async (path, content) => {
      const res = await send(config, "PUT", sandboxPath(sandboxId, "/files"), {
        query: { path, mode: "600" },
        raw: content,
        timeoutMs: 10 * 60_000,
      });
      await res.body?.cancel();
    },
    unstage: async (path) => {
      const res = await send(config, "GET", sandboxPath(sandboxId, "/files"), {
        query: { path },
        accept: "application/octet-stream",
        timeoutMs: 10 * 60_000,
      });
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

/** Run `script` with bash; with `handlers`, output goes to them, not the result. */
export async function runRuntimeScript(
  config: RuntimeConfig,
  sandboxId: string,
  script: string,
  handlers?: StreamCommandHandlers,
): Promise<SandboxExecResult> {
  const res = await send(config, "POST", sandboxPath(sandboxId, ":exec"), {
    json: {
      cmd: ["bash", "-c", script],
      timeoutSeconds: RUNTIME_EXEC_TIMEOUT_S,
      stream: true,
    },
    accept: "application/x-ndjson",
    timeoutMs: EXEC_REQUEST_TIMEOUT_MS,
  });
  if (!res.body) throw new Error("Runtime exec returned no body");
  const sink = outputSink(handlers);
  const end = await foldEvents(readNdjson(res.body), sink);
  if (end.kind === "exit") return sink.result(end.exitCode);
  return sink.result(await followOutput(config, sandboxId, end, sink));
}

interface OutputSink {
  stdout(chunk: string): void;
  stderr(chunk: string): void;
  result(exitCode: number): SandboxExecResult;
}

function outputSink(handlers?: StreamCommandHandlers): OutputSink {
  let stdout = "";
  let stderr = "";
  return {
    stdout: (chunk) => {
      if (handlers) handlers.onStdout(chunk);
      else stdout += chunk;
    },
    stderr: (chunk) => {
      if (handlers) handlers.onStderr?.(chunk);
      else stderr += chunk;
    },
    result: (exitCode) => ({ exitCode, stdout, stderr }),
  };
}

type StreamEnd =
  | { kind: "exit"; exitCode: number }
  | { kind: "continue"; processId: string; cursor: number };

/** Fold exec events into the sink, until `exit` or `continue`. Exported for tests. */
export async function foldEvents(
  lines: AsyncIterable<string>,
  sink: Pick<OutputSink, "stdout" | "stderr">,
): Promise<StreamEnd> {
  for await (const line of lines) {
    const event = eventSchema.parse(JSON.parse(line));
    switch (event.type) {
      case "stdout":
        sink.stdout(event.data ?? "");
        break;
      case "stderr":
        sink.stderr(event.data ?? "");
        break;
      case "exit":
        return { kind: "exit", exitCode: exitCodeOf(event) };
      case "continue":
        if (!event.processId || event.cursor === undefined) {
          throw new Error("Runtime exec stream cut with no process to follow");
        }
        return {
          kind: "continue",
          processId: event.processId,
          cursor: event.cursor,
        };
      case "error":
        throw new RuntimeApiError(
          0,
          event.error?.code ?? "exec_error",
          event.error?.message ?? line,
        );
      default:
        // `start`, `truncated`, and events we do not know.
        break;
    }
  }
  throw new Error("Runtime exec stream ended without an exit event");
}

/**
 * The exit code of an `exit` event or a finished process: 124 for a time
 * out, and 128 + n for a process a signal ended (Runtime reports -n).
 * Exported for tests.
 */
export function exitCodeOf(end: {
  exitCode?: number | null;
  state?: string;
  timedOut?: boolean;
}): number {
  if (end.timedOut || end.state === "timed_out") return TIMED_OUT_EXIT;
  const code = end.exitCode ?? 1;
  return code < 0 ? 128 - code : code;
}

const outputSchema = z.object({
  chunks: z.array(
    z.object({ stream: z.string(), text: z.string().optional() }),
  ),
  nextCursor: z.number(),
  process: z
    .object({
      state: z.string(),
      exitCode: z.number().nullish(),
    })
    .nullish(),
});

/** Read a cut stream's remaining output until the process ends. */
async function followOutput(
  config: RuntimeConfig,
  sandboxId: string,
  from: { processId: string; cursor: number },
  sink: OutputSink,
): Promise<number> {
  const deadline = Date.now() + EXEC_REQUEST_TIMEOUT_MS;
  let cursor = from.cursor;
  for (;;) {
    const out = await requestJson(
      config,
      outputSchema,
      "GET",
      sandboxPath(
        sandboxId,
        `/processes/${encodeURIComponent(from.processId)}/output`,
      ),
      { query: { cursor: String(cursor), waitSeconds: "8" } },
    );
    for (const chunk of out.chunks) {
      if (chunk.stream === "stderr") sink.stderr(chunk.text ?? "");
      else sink.stdout(chunk.text ?? "");
    }
    cursor = out.nextCursor;
    if (out.chunks.length === 0) {
      // The output may come without the process; then ask for it.
      const process =
        out.process ?? (await getProcess(config, sandboxId, from.processId));
      if (process && process.state !== "running") {
        return exitCodeOf(process);
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Runtime process ${from.processId} did not end within the exec time limit`,
      );
    }
  }
}

const processListSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      state: z.string(),
      exitCode: z.number().nullish(),
    }),
  ),
});

/** A process of the sandbox's, running or recently ended; null if gone. */
async function getProcess(
  config: RuntimeConfig,
  sandboxId: string,
  processId: string,
): Promise<{ state: string; exitCode?: number | null } | null> {
  const { items } = await requestJson(
    config,
    processListSchema,
    "GET",
    sandboxPath(sandboxId, "/processes"),
  );
  return items.find((p) => p.id === processId) ?? null;
}
