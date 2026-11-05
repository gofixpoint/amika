/**
 * Small REST client for the Instabox API (https://instabox.sh/docs/api.md).
 *
 * - Auth is the `X-API-Key` header.
 * - Every error body is `{ error: { code, message, retryable, ... } }`.
 *   `send` turns it into an {@link InstaboxApiError}.
 * - Requests that change state need an `Idempotency-Key`. `send` makes one
 *   per call and reuses it on retry, so a retry is not applied twice.
 * - Create, start, stop, suspend, resume, and delete return an operation.
 *   {@link waitForOperation} follows it until it ends.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { InstaboxConfig } from "../config";

export const INSTABOX_DEFAULT_API_URL = "https://api.instabox.sh";

/** Timeout for one control-plane request. */
const REQUEST_TIMEOUT_MS = 60_000;

/** Attempts for a request that fails with a retryable error. */
const MAX_ATTEMPTS = 4;

/** Upper bound for one wait between retries. */
const MAX_RETRY_WAIT_MS = 60_000;

/** How long one operation may take before we give up on it. */
const OPERATION_TIMEOUT_MS = 15 * 60_000;

/** The server waits up to this long for an operation to change. */
const OPERATION_LONG_POLL = "25s";

const errorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string().default(""),
    retryable: z.boolean().optional(),
    retryAfterSeconds: z.number().nullish(),
    operationId: z.string().nullish(),
    requestId: z.string().optional(),
  }),
});

/** An error the Instabox API answered with. */
export class InstaboxApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;
  /** The operation that blocks this request (`operation_conflict`). */
  readonly operationId: string | null;

  constructor(
    status: number,
    code: string,
    message: string,
    opts: {
      retryable?: boolean;
      retryAfterSeconds?: number | null;
      operationId?: string | null;
      requestId?: string;
    } = {},
  ) {
    super(
      `Instabox API error ${status} ${code}: ${message}` +
        (opts.requestId ? ` (request ${opts.requestId})` : ""),
    );
    this.name = "InstaboxApiError";
    this.status = status;
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.retryAfterSeconds = opts.retryAfterSeconds ?? null;
    this.operationId = opts.operationId ?? null;
  }
}

/** True when `error` is the API's 404. */
export function isNotFound(error: unknown): boolean {
  return error instanceof InstaboxApiError && error.status === 404;
}

export interface SendOptions {
  /** JSON body. */
  json?: unknown;
  /** Raw body, sent as `application/octet-stream`. */
  raw?: Uint8Array;
  query?: Record<string, string | undefined>;
  headers?: Record<string, string>;
  /** Send an `Idempotency-Key` (the same one on every retry). */
  idempotent?: boolean;
  accept?: string;
  /** Request timeout. `null`: no timeout. Default {@link REQUEST_TIMEOUT_MS}. */
  timeoutMs?: number | null;
}

function apiUrl(
  config: InstaboxConfig,
  path: string,
  query?: Record<string, string | undefined>,
): string {
  const base = (config.apiUrl ?? INSTABOX_DEFAULT_API_URL).replace(/\/+$/, "");
  const url = new URL(`${base}/v1${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

async function toApiError(res: Response): Promise<InstaboxApiError> {
  const text = await res.text().catch(() => "");
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON; fall back to the raw text below.
  }
  const parsed = errorBodySchema.safeParse(body);
  if (!parsed.success) {
    return new InstaboxApiError(
      res.status,
      "unknown",
      text.slice(0, 500) || res.statusText,
      { retryable: res.status === 502 || res.status === 503 },
    );
  }
  const { error } = parsed.data;
  const retryAfterHeader = Number(res.headers.get("retry-after"));
  return new InstaboxApiError(res.status, error.code, error.message, {
    retryable: error.retryable,
    retryAfterSeconds:
      error.retryAfterSeconds ??
      (Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
        ? retryAfterHeader
        : null),
    operationId: error.operationId,
    requestId: error.requestId,
  });
}

/** The wait before retry `attempt` (1-based) of a retryable error. */
export function retryDelayMs(error: InstaboxApiError, attempt: number): number {
  const wanted =
    error.retryAfterSeconds != null
      ? error.retryAfterSeconds * 1000
      : 1000 * 2 ** (attempt - 1);
  return Math.min(wanted, MAX_RETRY_WAIT_MS);
}

/** Methods that do the same thing when sent twice. */
const REPEATABLE_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE"]);

/**
 * Whether to send a request again after a retryable error. A POST without
 * an idempotency key (such as exec) may have run already, so we retry it
 * only on 429, which the API sends before it does any work.
 */
function canRetry(method: string, opts: SendOptions, status: number): boolean {
  return (
    REPEATABLE_METHODS.has(method) || opts.idempotent === true || status === 429
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Send one request and return the response. A non-2xx answer throws an
 * {@link InstaboxApiError}. An error the API marks `retryable` (rate limit,
 * no capacity, host restart) is retried a few times, but only when a repeat
 * cannot apply the change twice: see {@link canRetry}.
 */
export async function send(
  config: InstaboxConfig,
  method: string,
  path: string,
  opts: SendOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "X-API-Key": config.apiKey,
    ...opts.headers,
  };
  if (opts.accept) headers.Accept = opts.accept;
  if (opts.idempotent) headers["Idempotency-Key"] = randomUUID();
  let body: string | Uint8Array | undefined;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if (opts.raw !== undefined) {
    headers["Content-Type"] = "application/octet-stream";
    body = opts.raw;
  }
  const timeoutMs =
    opts.timeoutMs === undefined ? REQUEST_TIMEOUT_MS : opts.timeoutMs;

  for (let attempt = 1; ; attempt++) {
    const res = await fetch(apiUrl(config, path, opts.query), {
      method,
      headers,
      body,
      signal: timeoutMs === null ? undefined : AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return res;
    const error = await toApiError(res);
    if (
      !error.retryable ||
      !canRetry(method, opts, res.status) ||
      attempt >= MAX_ATTEMPTS
    ) {
      throw error;
    }
    await sleep(retryDelayMs(error, attempt));
  }
}

/** Send a request and parse its JSON answer with `schema`. */
export async function requestJson<S extends z.ZodType>(
  config: InstaboxConfig,
  schema: S,
  method: string,
  path: string,
  opts: SendOptions = {},
): Promise<z.infer<S>> {
  const res = await send(config, method, path, opts);
  return schema.parse(await res.json());
}

/** Send a request whose answer has no useful body. */
export async function requestVoid(
  config: InstaboxConfig,
  method: string,
  path: string,
  opts: SendOptions = {},
): Promise<void> {
  const res = await send(config, method, path, opts);
  await res.body?.cancel();
}

// ---------------------------------------------------------------------------
// Resource shapes (only the fields we read)
// ---------------------------------------------------------------------------

export const machineSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string(),
  operationId: z.string().nullish(),
  metadata: z.record(z.string(), z.string()).nullish(),
  spec: z
    .object({
      vcpus: z.number(),
      memMiB: z.number(),
      persistentDiskGiB: z.number().optional(),
      rootDiskGiB: z.number().optional(),
    })
    .nullish(),
});
export type InstaboxMachine = z.infer<typeof machineSchema>;

export const operationSchema = z.object({
  id: z.string(),
  machineId: z.string().nullish(),
  type: z.string(),
  state: z.string(),
  error: z
    .object({ code: z.string(), message: z.string().default("") })
    .nullish(),
});
export type InstaboxOperation = z.infer<typeof operationSchema>;

/** Raised when an operation ends `failed`. */
export class InstaboxOperationError extends Error {
  readonly operation: InstaboxOperation;
  constructor(operation: InstaboxOperation) {
    super(
      `Instabox ${operation.type} operation ${operation.id} failed` +
        (operation.machineId ? ` on machine ${operation.machineId}` : "") +
        (operation.error
          ? `: ${operation.error.code}: ${operation.error.message}`
          : ""),
    );
    this.name = "InstaboxOperationError";
    this.operation = operation;
  }
}

/**
 * Follow an operation until it ends. Returns it when it `succeeded`; throws
 * {@link InstaboxOperationError} when it `failed`. Uses the server's long
 * poll, so the loop does not sleep.
 */
export async function waitForOperation(
  config: InstaboxConfig,
  operationId: string,
  timeoutMs: number = OPERATION_TIMEOUT_MS,
): Promise<InstaboxOperation> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const op = await requestJson(
      config,
      operationSchema,
      "GET",
      `/operations/${encodeURIComponent(operationId)}`,
      { query: { wait: OPERATION_LONG_POLL } },
    );
    if (op.state === "succeeded") return op;
    if (op.state === "failed") throw new InstaboxOperationError(op);
    if (Date.now() >= deadline) {
      throw new Error(
        `Instabox ${op.type} operation ${op.id} did not finish within ` +
          `${Math.round(timeoutMs / 1000)}s (last state: "${op.state}")`,
      );
    }
  }
}

/** How often to retry a change that another operation blocks. */
const MAX_CONFLICT_RETRIES = 5;

/**
 * Start an operation and wait for it to end. A machine runs one operation at
 * a time: when another one blocks this request (`409 operation_conflict` with
 * an `operationId`), wait for that one and try again.
 */
export async function runOperation(
  config: InstaboxConfig,
  method: "POST" | "DELETE",
  path: string,
  opts: Pick<SendOptions, "json" | "headers"> = {},
): Promise<InstaboxOperation> {
  for (let attempt = 0; ; attempt++) {
    let op: InstaboxOperation;
    try {
      op = await requestJson(config, operationSchema, method, path, {
        ...opts,
        idempotent: true,
      });
    } catch (error) {
      if (
        error instanceof InstaboxApiError &&
        error.code === "operation_conflict" &&
        error.operationId &&
        attempt < MAX_CONFLICT_RETRIES
      ) {
        // The blocking operation may fail; that is not our failure.
        await waitForOperation(config, error.operationId).catch(() => {});
        continue;
      }
      throw error;
    }
    return waitForOperation(config, op.id);
  }
}

/** Encode a machine id for a URL path. */
export function machinePath(machineId: string, suffix = ""): string {
  return `/machines/${encodeURIComponent(machineId)}${suffix}`;
}
