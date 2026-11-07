/**
 * Run commands with `POST /v1/machines/{id}/exec`
 * (https://instabox.sh/docs/api/commands.md).
 *
 * We always ask for the SSE stream (`Accept: text/event-stream`), also for a
 * buffered run: the JSON answer cuts each stream at 1 MiB, the stream does
 * not. Events are `stdout` / `stderr` (`{"data": "..."}`), then one `exit`
 * (the result, with empty output) or one `error`.
 *
 * A command runs as the machine user with `bash -lc`. Instabox stops a
 * command after `timeoutSeconds`, at most 600 (exit code 124). Longer jobs
 * must run in the background.
 */
import { z } from "zod";
import type {
  ExecCommandOptions,
  SandboxExecResult,
  StreamCommandHandlers,
} from "../../provider";
import type { InstaboxConfig } from "../config";
import { InstaboxApiError, machinePath, send } from "./client";
import { readSse } from "./sse";

/** The longest command Instabox runs (its maximum `timeoutSeconds`). */
export const INSTABOX_EXEC_TIMEOUT_S = 600;

/** Instabox refuses `stdin` larger than this. */
const MAX_STDIN_BYTES = 1024 * 1024;

/** Request timeout: the command limit plus time to connect and finish. */
const EXEC_REQUEST_TIMEOUT_MS = (INSTABOX_EXEC_TIMEOUT_S + 60) * 1000;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const chunkSchema = z.object({ data: z.string() });
const exitSchema = z.object({
  exitCode: z.number(),
  stdout: z.string().default(""),
  stderr: z.string().default(""),
});
const errorEventSchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
  error: z
    .object({ code: z.string().optional(), message: z.string().optional() })
    .optional(),
});

type ExecOpts = Pick<ExecCommandOptions, "cwd" | "env" | "sudo" | "input">;

/** The exec request body for `command` with `opts`. */
export function execRequestBody(
  command: string,
  opts: ExecOpts = {},
): Record<string, unknown> {
  const env = opts.env ?? {};
  for (const name of Object.keys(env)) {
    if (!ENV_NAME.test(name)) {
      throw new Error(`Invalid environment variable name: ${name}`);
    }
  }
  const body: Record<string, unknown> = opts.sudo
    ? {
        // `sudo` resets the environment, so pass the variables through
        // `env` inside it. argv form: no shell parses these values.
        argv: [
          "sudo",
          "-n",
          "env",
          ...Object.entries(env).map(([name, value]) => `${name}=${value}`),
          "bash",
          "-lc",
          command,
        ],
      }
    : { cmd: command, ...(opts.env ? { envs: opts.env } : {}) };
  if (opts.cwd) body.cwd = opts.cwd;
  if (opts.input !== undefined) {
    if (Buffer.byteLength(opts.input, "utf8") > MAX_STDIN_BYTES) {
      throw new Error("Command input exceeds the 1 MiB limit");
    }
    body.stdin = opts.input;
  }
  body.timeoutSeconds = INSTABOX_EXEC_TIMEOUT_S;
  return body;
}

/**
 * Run `command` and return its result. Output also goes to `handlers` while
 * the command runs, when given.
 */
export async function execInstabox(
  config: InstaboxConfig,
  machineId: string,
  command: string,
  opts: ExecOpts = {},
  handlers?: StreamCommandHandlers,
): Promise<SandboxExecResult> {
  const res = await send(config, "POST", machinePath(machineId, "/exec"), {
    json: execRequestBody(command, opts),
    accept: "text/event-stream",
    timeoutMs: EXEC_REQUEST_TIMEOUT_MS,
  });
  if (!res.body) throw new Error("Instabox exec returned no body");
  return collectExecEvents(readSse(res.body), handlers);
}

/** Fold exec stream events into a result. Exported for tests. */
export async function collectExecEvents(
  events: AsyncIterable<{ event: string; data: string }>,
  handlers?: StreamCommandHandlers,
): Promise<SandboxExecResult> {
  let stdout = "";
  let stderr = "";
  for await (const { event, data } of events) {
    switch (event) {
      case "stdout": {
        const chunk = chunkSchema.parse(JSON.parse(data)).data;
        stdout += chunk;
        handlers?.onStdout(chunk);
        break;
      }
      case "stderr": {
        const chunk = chunkSchema.parse(JSON.parse(data)).data;
        stderr += chunk;
        handlers?.onStderr?.(chunk);
        break;
      }
      case "exit": {
        const exit = exitSchema.parse(JSON.parse(data));
        // The exit event carries empty output; keep any it has anyway.
        return {
          exitCode: exit.exitCode,
          stdout: stdout + exit.stdout,
          stderr: stderr + exit.stderr,
        };
      }
      case "error": {
        const parsed = errorEventSchema.safeParse(safeJson(data));
        const detail = parsed.success
          ? (parsed.data.error ?? parsed.data)
          : { code: undefined, message: data };
        throw new InstaboxApiError(
          0,
          detail.code ?? "exec_error",
          detail.message ?? data,
        );
      }
      default:
        // Ignore events we do not know.
        break;
    }
  }
  throw new Error("Instabox exec stream ended without an exit event");
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
