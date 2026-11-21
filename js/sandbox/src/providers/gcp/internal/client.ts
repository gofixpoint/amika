/**
 * Small REST client for the Compute Engine API
 * (https://cloud.google.com/compute/docs/reference/rest/v1).
 *
 * - Auth is an OAuth bearer token made from the service account key
 *   (`./credentials.ts`).
 * - Every error body is `{ error: { code, message, errors: [{ reason }] } }`.
 *   `send` turns it into a {@link GcpApiError}.
 * - Insert, delete, start, stop, and image create return a zone or global
 *   operation. {@link waitForOperation} follows it until it is `DONE`.
 * - A create takes a `requestId`, so a retry is not applied twice.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { GcpConfig } from "../config";
import {
  gcpAccessToken,
  parseGcpCredentials,
  type GcpCredentials,
} from "./credentials";

export const GCP_DEFAULT_API_URL = "https://compute.googleapis.com";

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 4;
const MAX_RETRY_WAIT_MS = 30_000;

/** How long one operation may take before we give up on it. */
const OPERATION_TIMEOUT_MS = 15 * 60_000;

/** Statuses Google asks a caller to retry. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/** Methods that do the same thing when sent twice. */
const REPEATABLE_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE"]);

const errorBodySchema = z.object({
  error: z.object({
    code: z.number().optional(),
    message: z.string().default(""),
    status: z.string().optional(),
    errors: z
      .array(z.object({ reason: z.string().optional() }).passthrough())
      .optional(),
  }),
});

/** An error the Compute Engine API answered with. */
export class GcpApiError extends Error {
  readonly status: number;
  /** The first `errors[].reason`, such as `notFound` or `alreadyExists`. */
  readonly reason: string;

  constructor(status: number, reason: string, message: string) {
    super(`GCP API error ${status} ${reason}: ${message}`);
    this.name = "GcpApiError";
    this.status = status;
    this.reason = reason;
  }
}

export function isNotFound(error: unknown): boolean {
  return error instanceof GcpApiError && error.status === 404;
}

export function isAlreadyExists(error: unknown): boolean {
  return error instanceof GcpApiError && error.status === 409;
}

/**
 * The parsed credentials and the API paths they decide. Built once per
 * provider, so a bad key fails the first call with a clear message.
 */
export interface GcpTarget {
  credentials: GcpCredentials;
  apiUrl: string;
  /** `projects/{project}`. */
  projectPath: string;
  /** `projects/{project}/zones/{zone}`. */
  zonePath: string;
}

export function gcpTarget(config: GcpConfig): GcpTarget {
  const credentials = parseGcpCredentials(config);
  const projectPath = `projects/${encodeURIComponent(credentials.projectId)}`;
  return {
    credentials,
    apiUrl: (config.apiUrl ?? GCP_DEFAULT_API_URL).replace(/\/+$/, ""),
    projectPath,
    zonePath: `${projectPath}/zones/${encodeURIComponent(credentials.zone)}`,
  };
}

export interface SendOptions {
  json?: unknown;
  query?: Record<string, string | undefined>;
  /** Request timeout. Default {@link REQUEST_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * The request is safe to send twice: a POST with a `requestId`, or one
   * that changes nothing. GET, PUT, and DELETE always are.
   */
  repeatable?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Send one request to `compute/v1/{path}` and return its JSON body. A
 * non-2xx answer throws a {@link GcpApiError}. A retryable answer or a
 * network error is retried only when the request is safe to repeat (see
 * {@link SendOptions.repeatable}).
 */
export async function requestJson<S extends z.ZodType>(
  target: GcpTarget,
  schema: S,
  method: string,
  path: string,
  opts: SendOptions = {},
): Promise<z.infer<S>> {
  const url = new URL(`${target.apiUrl}/compute/v1/${path}`);
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  const repeatable = REPEATABLE_METHODS.has(method) || opts.repeatable === true;

  for (let attempt = 1; ; attempt++) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await gcpAccessToken(target.credentials)}`,
    };
    if (opts.json !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
        signal: AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (!repeatable || attempt >= MAX_ATTEMPTS) throw error;
      await sleep(Math.min(1000 * 2 ** (attempt - 1), MAX_RETRY_WAIT_MS));
      continue;
    }
    if (res.ok) return schema.parse(await res.json());
    const error = await toApiError(res);
    // A 429 arrives before Google does any work, so any method may retry it.
    const retry =
      RETRYABLE_STATUSES.has(res.status) &&
      (repeatable || res.status === 429) &&
      attempt < MAX_ATTEMPTS;
    if (!retry) throw error;
    await sleep(Math.min(1000 * 2 ** (attempt - 1), MAX_RETRY_WAIT_MS));
  }
}

async function toApiError(res: Response): Promise<GcpApiError> {
  const text = await res.text().catch(() => "");
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON; use the raw text below.
  }
  const parsed = errorBodySchema.safeParse(body);
  if (!parsed.success) {
    return new GcpApiError(
      res.status,
      "unknown",
      text.slice(0, 500) || res.statusText,
    );
  }
  const { error } = parsed.data;
  return new GcpApiError(
    res.status,
    error.errors?.[0]?.reason ?? error.status ?? "unknown",
    error.message,
  );
}

export const operationSchema = z.object({
  name: z.string(),
  operationType: z.string().optional(),
  status: z.string(),
  targetLink: z.string().optional(),
  zone: z.string().optional(),
  error: z
    .object({
      errors: z
        .array(
          z.object({
            code: z.string().optional(),
            message: z.string().optional(),
          }),
        )
        .default([]),
    })
    .optional(),
});
export type GcpOperation = z.infer<typeof operationSchema>;

/** Raised when an operation ends with an error. */
export class GcpOperationError extends Error {
  readonly operation: GcpOperation;
  constructor(operation: GcpOperation) {
    const detail = (operation.error?.errors ?? [])
      .map((e) => `${e.code ?? "error"}: ${e.message ?? ""}`)
      .join("; ");
    super(
      `GCP ${operation.operationType ?? ""} operation ${operation.name} failed` +
        (detail ? `: ${detail}` : ""),
    );
    this.name = "GcpOperationError";
    this.operation = operation;
  }
}

/**
 * Start an operation with `method` on `path` and wait until it is `DONE`.
 * A POST gets a fresh `requestId`, which makes its retries safe.
 */
export async function runOperation(
  target: GcpTarget,
  method: "POST" | "DELETE",
  path: string,
  opts: Pick<SendOptions, "json" | "query"> = {},
): Promise<GcpOperation> {
  const op = await requestJson(target, operationSchema, method, path, {
    ...opts,
    query: { ...opts.query, requestId: randomUUID() },
    repeatable: true,
  });
  return waitForOperation(target, op);
}

/**
 * Follow an operation until it is `DONE`. Throws {@link GcpOperationError}
 * when it ends with an error. `operations/{name}/wait` holds the request
 * for up to two minutes, so the loop does not sleep.
 */
export async function waitForOperation(
  target: GcpTarget,
  initial: GcpOperation,
  timeoutMs: number = OPERATION_TIMEOUT_MS,
): Promise<GcpOperation> {
  const deadline = Date.now() + timeoutMs;
  // A zone operation names its zone; a global one (images) does not.
  const base = initial.zone ? target.zonePath : `${target.projectPath}/global`;
  let op = initial;
  while (op.status !== "DONE") {
    if (Date.now() >= deadline) {
      throw new Error(
        `GCP operation ${op.name} did not finish within ` +
          `${Math.round(timeoutMs / 1000)}s (last status: "${op.status}")`,
      );
    }
    op = await requestJson(
      target,
      operationSchema,
      "POST",
      `${base}/operations/${encodeURIComponent(op.name)}/wait`,
      // `wait` changes nothing, so it is safe to repeat.
      { repeatable: true, timeoutMs: 150_000 },
    );
  }
  if (op.error?.errors.length) throw new GcpOperationError(op);
  return op;
}
