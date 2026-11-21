/**
 * Small REST client for the Orble API (https://orble.tech/docs.md). Orble
 * publishes no API reference; the paths and shapes here follow its
 * official SDK (`@orble/sdk`, github.com/orbletech/orble-sdk).
 *
 * - Auth is `Authorization: Bearer orble_…`.
 * - Every error body is `{ "error": "<message>" }`. `send` turns it into
 *   an {@link OrbleApiError}.
 * - Orble documents no idempotency keys, so a request that changes state
 *   is retried only on a network error before any answer, and only where a
 *   repeat changes nothing (GET, PUT, DELETE).
 */
import { z } from "zod";
import type { OrbleConfig } from "../config";

export const ORBLE_DEFAULT_API_URL = "https://orble.tech";

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;

/** An error the Orble API answered with. */
export class OrbleApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(`Orble API error ${status}: ${message}`);
    this.name = "OrbleApiError";
    this.status = status;
  }
}

export function isNotFound(error: unknown): boolean {
  return error instanceof OrbleApiError && error.status === 404;
}

export interface SendOptions {
  json?: unknown;
  raw?: Uint8Array;
  query?: Record<string, string | undefined>;
  /** Request timeout. Default {@link REQUEST_TIMEOUT_MS}. */
  timeoutMs?: number;
}

const REPEATABLE_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE"]);

const errorBodySchema = z.object({ error: z.string() });

function apiUrl(
  config: OrbleConfig,
  path: string,
  query?: Record<string, string | undefined>,
): string {
  const base = (config.apiUrl ?? ORBLE_DEFAULT_API_URL).replace(/\/+$/, "");
  const url = new URL(`${base}/v1${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function send(
  config: OrbleConfig,
  method: string,
  path: string,
  opts: SendOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
  };
  let body: RequestInit["body"];
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if (opts.raw !== undefined) {
    headers["Content-Type"] = "application/octet-stream";
    body = new Uint8Array(opts.raw);
  }
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(apiUrl(config, path, opts.query), {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (!REPEATABLE_METHODS.has(method) || attempt >= MAX_ATTEMPTS) {
        throw error;
      }
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }
    if (res.ok) return res;
    const text = await res.text().catch(() => "");
    let message = text.slice(0, 500) || res.statusText;
    try {
      message = errorBodySchema.parse(JSON.parse(text)).error;
    } catch {
      // Not Orble's JSON error; keep the raw text.
    }
    throw new OrbleApiError(res.status, message);
  }
}

/** Send a request and parse its JSON answer; an empty body reads as `{}`. */
export async function requestJson<S extends z.ZodType>(
  config: OrbleConfig,
  schema: S,
  method: string,
  path: string,
  opts: SendOptions = {},
): Promise<z.infer<S>> {
  const res = await send(config, method, path, opts);
  const text = await res.text();
  return schema.parse(text ? JSON.parse(text) : {});
}

export function boxPath(name: string, suffix = ""): string {
  return `/boxes/${encodeURIComponent(name)}${suffix}`;
}

export const boxSchema = z.object({
  name: z.string(),
  state: z.string(),
});
export type OrbleBox = z.infer<typeof boxSchema>;
