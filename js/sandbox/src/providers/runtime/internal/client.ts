/**
 * Small REST client for the Runtime API
 * (https://withruntime.com/docs/reference/overview.md, spec at
 * https://api.withruntime.com/v2/openapi.json).
 *
 * - Auth is `Authorization: Bearer rtkey_…`. Key-pair keys (`rtsk_…`) sign
 *   each request instead; we refuse them with a clear message.
 * - Every error body is `{ error: { code, message, requestId, hint,
 *   retryable, details: { reason } } }`. `send` turns it into a
 *   {@link RuntimeApiError}.
 * - Every request that is not a GET carries an `Idempotency-Key`, the same
 *   one on each retry, so Runtime applies it once. That covers exec too:
 *   a resent exec returns the first run's process.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { RuntimeConfig } from "../config";

export const RUNTIME_DEFAULT_API_URL = "https://api.withruntime.com";

/** The API version this client is written against. */
const RUNTIME_API_VERSION = "2026-10-27";

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 4;
const MAX_RETRY_WAIT_MS = 60_000;

const errorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string().default(""),
    requestId: z.string().optional(),
    hint: z.string().optional(),
    retryable: z.boolean().optional(),
    details: z
      .object({ reason: z.string().optional() })
      .passthrough()
      .nullish(),
  }),
});

/** An error the Runtime API answered with. */
export class RuntimeApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** `error.details.reason`, such as `sandbox_paused` or `file_not_found`. */
  readonly reason: string | null;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;

  constructor(
    status: number,
    code: string,
    message: string,
    opts: {
      reason?: string | null;
      retryable?: boolean;
      retryAfterSeconds?: number | null;
      requestId?: string;
    } = {},
  ) {
    super(
      `Runtime API error ${status} ${code}` +
        (opts.reason ? `/${opts.reason}` : "") +
        `: ${message}` +
        (opts.requestId ? ` (request ${opts.requestId})` : ""),
    );
    this.name = "RuntimeApiError";
    this.status = status;
    this.code = code;
    this.reason = opts.reason ?? null;
    this.retryable = opts.retryable ?? false;
    this.retryAfterSeconds = opts.retryAfterSeconds ?? null;
  }
}

export function isNotFound(error: unknown): boolean {
  return error instanceof RuntimeApiError && error.status === 404;
}

export interface SendOptions {
  json?: unknown;
  /** Raw body, sent as `application/octet-stream`. */
  raw?: Uint8Array;
  query?: Record<string, string | undefined>;
  accept?: string;
  /** Request timeout. `null`: none. Default {@link REQUEST_TIMEOUT_MS}. */
  timeoutMs?: number | null;
}

/** Refuse a key this client cannot use, before any request. */
export function checkRuntimeKey(config: RuntimeConfig): void {
  if (config.apiKey.startsWith("rtsk_")) {
    throw new Error(
      "Runtime key-pair keys (rtsk_…) sign each request; use a bearer API key (rtkey_…)",
    );
  }
}

function apiUrl(
  config: RuntimeConfig,
  path: string,
  query?: Record<string, string | undefined>,
): string {
  const base = (config.apiUrl ?? RUNTIME_DEFAULT_API_URL).replace(/\/+$/, "");
  const url = new URL(`${base}/v2${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

async function toApiError(res: Response): Promise<RuntimeApiError> {
  const text = await res.text().catch(() => "");
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON; use the raw text below.
  }
  const retryAfterHeader = Number(res.headers.get("retry-after"));
  const retryAfter =
    Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
      ? retryAfterHeader
      : null;
  const parsed = errorBodySchema.safeParse(body);
  if (!parsed.success) {
    return new RuntimeApiError(
      res.status,
      "unknown",
      text.slice(0, 500) || res.statusText,
      { retryable: res.status === 502 || res.status === 503 },
    );
  }
  const { error } = parsed.data;
  return new RuntimeApiError(res.status, error.code, error.message, {
    reason: error.details?.reason ?? null,
    // Runtime asks for a retry of 429 only with `Retry-After`, and of 503
    // always (docs/errors.md).
    retryable:
      error.retryable === true ||
      res.status === 503 ||
      (res.status === 429 && retryAfter !== null),
    retryAfterSeconds: retryAfter,
    requestId: error.requestId,
  });
}

export function retryDelayMs(
  error: RuntimeApiError | null,
  attempt: number,
): number {
  const wanted =
    error?.retryAfterSeconds != null
      ? error.retryAfterSeconds * 1000
      : 1000 * 2 ** (attempt - 1);
  return Math.min(wanted, MAX_RETRY_WAIT_MS);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Send one request and return the response. A non-2xx answer throws a
 * {@link RuntimeApiError}. Every request is safe to repeat (GETs by
 * nature, the rest through their idempotency key), so a retryable answer
 * or a network error is retried.
 */
export async function send(
  config: RuntimeConfig,
  method: string,
  path: string,
  opts: SendOptions = {},
): Promise<Response> {
  checkRuntimeKey(config);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    "Runtime-Version": RUNTIME_API_VERSION,
    Accept: opts.accept ?? "application/json",
  };
  if (method !== "GET") headers["Idempotency-Key"] = randomUUID();
  let body: RequestInit["body"];
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if (opts.raw !== undefined) {
    headers["Content-Type"] = "application/octet-stream";
    body = new Uint8Array(opts.raw);
  }
  const timeoutMs =
    opts.timeoutMs === undefined ? REQUEST_TIMEOUT_MS : opts.timeoutMs;

  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(apiUrl(config, path, opts.query), {
        method,
        headers,
        body,
        signal: timeoutMs === null ? undefined : AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS) throw error;
      await sleep(retryDelayMs(null, attempt));
      continue;
    }
    if (res.ok) return res;
    const error = await toApiError(res);
    if (!error.retryable || attempt >= MAX_ATTEMPTS) throw error;
    await sleep(retryDelayMs(error, attempt));
  }
}

export async function requestJson<S extends z.ZodType>(
  config: RuntimeConfig,
  schema: S,
  method: string,
  path: string,
  opts: SendOptions = {},
): Promise<z.infer<S>> {
  const res = await send(config, method, path, opts);
  return schema.parse(await res.json());
}

/** `/sandboxes/{id}` plus a colon verb (`:exec`) or a sub-path (`/files`). */
export function sandboxPath(sandboxId: string, suffix = ""): string {
  return `/sandboxes/${encodeURIComponent(sandboxId)}${suffix}`;
}

export const sandboxSchema = z.object({
  id: z.string(),
  name: z.string().nullish(),
  state: z.string(),
  labels: z.record(z.string(), z.string()).nullish(),
  vcpu: z.number().nullish(),
  memoryGB: z.number().nullish(),
  diskGB: z.number().nullish(),
});
export type RuntimeSandbox = z.infer<typeof sandboxSchema>;
