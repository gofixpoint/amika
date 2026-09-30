/** HTTP boundary for smolvm serve (not the smol cloud API). */
import { z } from "zod";
import type { SmolConfig } from "../config";

export const machineSchema = z.object({
  name: z.string().min(1),
  state: z.string(),
  cpus: z.number().positive(),
  memoryMb: z.number().positive(),
  storageGb: z.number().positive().optional(),
  /** Published guest ports; absent on runtimes that predate them. */
  ports: z
    .array(z.object({ host: z.number().int(), guest: z.number().int() }))
    .optional(),
});
export const execSchema = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
});

export class SmolApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    /** Relative to the client's machines path; `""` is the collection. */
    readonly path: string,
    /** The response body's `error` message, when it is safe to surface. */
    reason?: string,
  ) {
    super(
      `smolvm ${method} ${path} failed (HTTP ${status})${reason === undefined ? "" : `: ${reason}`}`,
    );
    this.name = "SmolApiError";
  }
}

export class SmolClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    config: SmolConfig,
    private readonly fetcher = fetch,
    /** Where the machine API lives: smolvm's path, or a compatible one. */
    private readonly machinesPath = "/api/v1/machines",
  ) {
    const url = new URL(config.apiUrl ?? "http://127.0.0.1:8080");
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error(
        "Smol apiUrl must be an HTTP(S) URL without credentials, query, or fragment",
      );
    }
    this.baseUrl = url.toString().replace(/\/$/, "");
    this.timeoutMs = z
      .number()
      .int()
      .positive()
      .parse(config.requestTimeoutMs ?? 300_000);
  }

  async request(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<Response> {
    const binary = Buffer.isBuffer(body);
    const response = await this.fetcher(
      `${this.baseUrl}${this.machinesPath}${path}`,
      {
        method,
        headers:
          body === undefined
            ? undefined
            : {
                "Content-Type": binary
                  ? "application/octet-stream"
                  : "application/json",
              },
        body:
          body === undefined
            ? undefined
            : binary
              ? new Uint8Array(body)
              : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    if (!response.ok) {
      throw new SmolApiError(
        response.status,
        method,
        path,
        await errorReason(response, path),
      );
    }
    return response;
  }

  async json<T>(
    path: string,
    schema: z.ZodType<T>,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    return schema.parse(await (await this.request(path, method, body)).json());
  }

  async discard(path: string, method: string, body?: unknown): Promise<void> {
    const response = await this.request(path, method, body);
    await response.body?.cancel();
  }
}

/**
 * A refused request's `{ error }` message, e.g. amika-hostd's explanation of
 * a 400. Exec error bodies may echo command input, so they are never read;
 * nor is any body without a string `error`.
 */
async function errorReason(
  response: Response,
  path: string,
): Promise<string | undefined> {
  if (EXEC_PATH.test(path)) {
    await response.body?.cancel();
    return undefined;
  }
  const body = errorBodySchema.safeParse(
    await response.json().catch(() => undefined),
  );
  return body.success ? body.data.error : undefined;
}

const errorBodySchema = z.object({ error: z.string().min(1) });

// The `/<machine>/exec` endpoint only: a file named `exec` is
// `/<machine>/files/.../exec`, and its errors are safe to show.
const EXEC_PATH = /^\/[^/]+\/exec$/;

/** Keep URL normalization from interpreting a machine name as a path. */
export function machinePath(id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) {
    throw new Error("Invalid smol machine name");
  }
  return `/${encodeURIComponent(id)}`;
}

export function filePath(id: string, path: string): string {
  if (
    !path.startsWith("/") ||
    path.includes("\0") ||
    path.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error("Smol file paths must be absolute without dot segments");
  }
  return `${machinePath(id)}/files/${path.slice(1).split("/").map(encodeURIComponent).join("/")}`;
}
