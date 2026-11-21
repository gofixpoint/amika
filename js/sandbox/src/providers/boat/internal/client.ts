/**
 * Small REST client for the boat API (https://docs.boat.dev/api/v1.md, spec
 * at https://docs.boat.dev/openapi/boat-v1.yaml).
 *
 * - Auth is `Authorization: Bearer boat_…`.
 * - Every error body is `{ ok: false, code, message, error: { code, message,
 *   status, details }, requestId }`. `send` turns it into a
 *   {@link BoatApiError}.
 * - Create takes an `Idempotency-Key`, so a retry is not applied twice.
 * - Lifecycle calls answer 202 and run on: the caller polls the sandbox.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { BoatConfig } from "../config";

export const BOAT_DEFAULT_API_URL = "https://boat.dev/api/v1";

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 4;
const MAX_RETRY_WAIT_MS = 60_000;

const errorBodySchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
  retryable: z.boolean().optional(),
  retryAfterSeconds: z.number().optional(),
  error: z
    .object({
      code: z.string().optional(),
      message: z.string().optional(),
      details: z.record(z.string(), z.unknown()).nullish(),
    })
    .optional(),
  requestId: z.string().optional(),
});

/** An error the boat API answered with. */
export class BoatApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;

  constructor(
    status: number,
    code: string,
    message: string,
    opts: {
      retryable?: boolean;
      retryAfterSeconds?: number | null;
      requestId?: string;
    } = {},
  ) {
    super(
      `boat API error ${status} ${code}: ${message}` +
        (opts.requestId ? ` (request ${opts.requestId})` : ""),
    );
    this.name = "BoatApiError";
    this.status = status;
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.retryAfterSeconds = opts.retryAfterSeconds ?? null;
  }
}

export function isNotFound(error: unknown): boolean {
  return error instanceof BoatApiError && error.status === 404;
}

/**
 * Codes boat sends before it does any work, which any request may retry:
 * the sandbox is still starting, a stop holds the machine, or a limit
 * asks the caller to wait.
 */
const RETRY_BEFORE_WORK_CODES = new Set([
  "sandbox_starting",
  "sandbox_stopping",
  "sandbox_resuming",
  "sandbox_securing",
  "rate_limited",
  "IP_RATE_LIMIT_EXCEEDED",
]);

/** Gateway answers that may come with no API body. */
const GATEWAY_STATUSES = new Set([502, 503, 504]);

const REPEATABLE_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE"]);

export interface SendOptions {
  json?: unknown;
  query?: Record<string, string | undefined>;
  headers?: Record<string, string>;
  /** Send an `Idempotency-Key` (the same one on every retry). */
  idempotent?: boolean;
  /** Request timeout. `null`: none. Default {@link REQUEST_TIMEOUT_MS}. */
  timeoutMs?: number | null;
}

function apiUrl(
  config: BoatConfig,
  path: string,
  query?: Record<string, string | undefined>,
): string {
  const base = (config.apiUrl ?? BOAT_DEFAULT_API_URL).replace(/\/+$/, "");
  const url = new URL(`${base}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

async function toApiError(res: Response): Promise<BoatApiError> {
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
    return new BoatApiError(
      res.status,
      "unknown",
      text.slice(0, 500) || res.statusText,
      {
        retryable: GATEWAY_STATUSES.has(res.status) || res.status === 429,
        retryAfterSeconds: retryAfter,
      },
    );
  }
  const data = parsed.data;
  const code = data.error?.code ?? data.code ?? "unknown";
  const detailsRetryable = data.error?.details?.retryable === true;
  return new BoatApiError(
    res.status,
    code,
    data.error?.message ?? data.message ?? "",
    {
      retryable:
        data.retryable === true ||
        detailsRetryable ||
        res.status === 429 ||
        RETRY_BEFORE_WORK_CODES.has(code),
      retryAfterSeconds: data.retryAfterSeconds ?? retryAfter,
      requestId: data.requestId,
    },
  );
}

/**
 * Whether to send a request again after a retryable error or a network
 * error (`error` null). A POST without an idempotency key (such as a
 * command) may have run already, so we retry it only on an answer boat
 * sends before it does any work.
 */
function canRetry(
  method: string,
  opts: SendOptions,
  error: BoatApiError | null,
): boolean {
  if (REPEATABLE_METHODS.has(method) || opts.idempotent === true) return true;
  return error !== null && RETRY_BEFORE_WORK_CODES.has(error.code);
}

export function retryDelayMs(
  error: BoatApiError | null,
  attempt: number,
): number {
  const wanted =
    error?.retryAfterSeconds != null
      ? error.retryAfterSeconds * 1000
      : 1000 * 2 ** (attempt - 1);
  return Math.min(wanted, MAX_RETRY_WAIT_MS);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Send one request and return the response; a non-2xx answer throws. */
export async function send(
  config: BoatConfig,
  method: string,
  path: string,
  opts: SendOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    ...opts.headers,
  };
  if (opts.idempotent) headers["Idempotency-Key"] = randomUUID();
  if (opts.json !== undefined) headers["Content-Type"] = "application/json";
  const body = opts.json === undefined ? undefined : JSON.stringify(opts.json);
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
      if (!canRetry(method, opts, null) || attempt >= MAX_ATTEMPTS) throw error;
      await sleep(retryDelayMs(null, attempt));
      continue;
    }
    if (res.ok) return res;
    const error = await toApiError(res);
    if (
      !error.retryable ||
      !canRetry(method, opts, error) ||
      attempt >= MAX_ATTEMPTS
    ) {
      throw error;
    }
    await sleep(retryDelayMs(error, attempt));
  }
}

export async function requestJson<S extends z.ZodType>(
  config: BoatConfig,
  schema: S,
  method: string,
  path: string,
  opts: SendOptions = {},
): Promise<z.infer<S>> {
  const res = await send(config, method, path, opts);
  return schema.parse(await res.json());
}

export function sandboxPath(sandboxId: string, suffix = ""): string {
  return `/sandboxes/${encodeURIComponent(sandboxId)}${suffix}`;
}

export const sandboxSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string(),
  error: z.string().nullish(),
  labels: z.record(z.string(), z.string()).nullish(),
  type: z.string().nullish(),
  vcpu: z.number().nullish(),
  memoryGB: z.number().nullish(),
});
export type BoatSandbox = z.infer<typeof sandboxSchema>;
