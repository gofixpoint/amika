/**
 * Orble's command and file primitives, as the {@link VendorShell} the
 * shared rig-user layer (`../../shared/rig-user.ts`) runs on.
 *
 * - **Commands** go to `POST /boxes/{name}/exec`, which runs the string
 *   with `/bin/sh -c` as `agent`; we send `bash -c <script>`. Orble holds
 *   the request about 50 seconds; a command still running then comes back
 *   as `{ running: true, job }`, and we post `{ job }` until it ends. A
 *   command runs at most 600 seconds (exit code 124 after that), and each
 *   stream keeps only its last 64 KiB.
 * - **Staging** is `PUT /boxes/{name}/files`, raw bytes, at most 8 MiB per
 *   write; a larger file goes in parts that a command joins. Because
 *   command output is capped, reads go through a staged copy too, read
 *   back with the chunked `GET /boxes/{name}/files`.
 */
import { z } from "zod";
import type { SandboxExecResult } from "../../provider";
import type { VendorShell } from "../../shared/rig-user";
import { shellQuote } from "../../../util/shell";
import type { OrbleConfig } from "../config";
import { boxPath, requestJson, send } from "./client";

/** The longest command Orble runs (its maximum `timeout_s`). */
export const ORBLE_EXEC_TIMEOUT_S = 600;

/** Orble refuses a file write larger than 8 MiB; stay under it. */
const MAX_WRITE_BYTES = 7 * 1024 * 1024;

/** Where staged files go; Orble's login user owns it. */
export const ORBLE_STAGING_DIR = "/home/agent/.amika-staging";

/** The server holds an exec about 50 seconds; wait a little longer. */
const EXEC_REQUEST_TIMEOUT_MS = 90_000;

const execResponseSchema = z.object({
  exit_code: z.number().nullish(),
  stdout: z.string().default(""),
  stderr: z.string().default(""),
  timed_out: z.boolean().optional(),
  running: z.boolean().optional(),
  job: z.string().optional(),
});

const fileChunkSchema = z.object({
  size: z.number(),
  offset: z.number(),
  bytes: z.number(),
  encoding: z.string(),
  content: z.string(),
});

export function orbleShell(config: OrbleConfig, boxName: string): VendorShell {
  return {
    run: (script) => runOrbleScript(config, boxName, script),
    stagingDir: ORBLE_STAGING_DIR,
    stage: (path, content) => stageOrbleFile(config, boxName, path, content),
    unstage: (path) => readOrbleFile(config, boxName, path),
  };
}

/** Run `script` with bash and wait for it, following Orble's job polls. */
export async function runOrbleScript(
  config: OrbleConfig,
  boxName: string,
  script: string,
): Promise<SandboxExecResult> {
  const path = boxPath(boxName, "/exec");
  const deadline = Date.now() + (ORBLE_EXEC_TIMEOUT_S + 120) * 1000;
  let res = await requestJson(config, execResponseSchema, "POST", path, {
    json: {
      command: `bash -c ${shellQuote(script)}`,
      timeout_s: ORBLE_EXEC_TIMEOUT_S,
    },
    timeoutMs: EXEC_REQUEST_TIMEOUT_MS,
  });
  while (res.running && res.job) {
    if (Date.now() >= deadline) {
      throw new Error(`Orble command job ${res.job} did not end in time`);
    }
    res = await requestJson(config, execResponseSchema, "POST", path, {
      json: { job: res.job },
      timeoutMs: EXEC_REQUEST_TIMEOUT_MS,
    });
  }
  return {
    exitCode: res.timed_out ? 124 : (res.exit_code ?? 1),
    stdout: res.stdout,
    stderr: res.stderr,
  };
}

/** Write `content` to `path` as `agent`, in parts when it is large. */
async function stageOrbleFile(
  config: OrbleConfig,
  boxName: string,
  path: string,
  content: Uint8Array,
): Promise<void> {
  const put = async (target: string, bytes: Uint8Array) => {
    const res = await send(config, "PUT", boxPath(boxName, "/files"), {
      query: { path: target },
      raw: bytes,
      timeoutMs: 5 * 60_000,
    });
    await res.body?.cancel();
  };
  if (content.byteLength <= MAX_WRITE_BYTES) {
    await put(path, content);
    return;
  }
  const parts: string[] = [];
  for (let offset = 0; offset < content.byteLength; offset += MAX_WRITE_BYTES) {
    const part = `${path}.part-${String(parts.length).padStart(4, "0")}`;
    await put(part, content.subarray(offset, offset + MAX_WRITE_BYTES));
    parts.push(part);
  }
  const quoted = parts.map(shellQuote).join(" ");
  const joined = await runOrbleScript(
    config,
    boxName,
    `set -e; cat ${quoted} > ${shellQuote(path)}; rm -f ${quoted}`,
  );
  if (joined.exitCode !== 0) {
    throw new Error(
      `Could not join the parts of ${path}: ${joined.stderr.trim() || joined.stdout.trim()}`,
    );
  }
}

/** Read a file as `agent`, chunk by chunk. */
export async function readOrbleFile(
  config: OrbleConfig,
  boxName: string,
  path: string,
): Promise<Uint8Array> {
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const chunk = await requestJson(
      config,
      fileChunkSchema,
      "GET",
      boxPath(boxName, "/files"),
      { query: { path, offset: String(offset) } },
    );
    parts.push(
      chunk.encoding === "base64"
        ? Buffer.from(chunk.content, "base64")
        : Buffer.from(chunk.content, "utf8"),
    );
    offset += chunk.bytes;
    if (chunk.bytes === 0 || offset >= chunk.size) break;
  }
  return new Uint8Array(Buffer.concat(parts));
}
