/** HTTP boundary for smolvm serve (not the smol cloud API). */
import { z } from "zod";
import type { SmolConfig } from "../config";

export const machineSchema = z.object({
  name: z.string().min(1),
  state: z.string(),
  cpus: z.number().positive(),
  memoryMb: z.number().positive(),
  storageGb: z.number().positive().optional(),
});
export const execSchema = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
});

export class SmolApiError extends Error {
  constructor(
    readonly status: number,
    method: string,
    path: string,
    runtime = "smolvm",
  ) {
    // Do not include response bodies: exec errors may contain command input.
    super(`${runtime} ${method} ${path} failed (HTTP ${status})`);
    this.name = "SmolApiError";
  }
}

export class SmolClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    config: SmolConfig,
    private readonly fetcher = fetch,
    private readonly runtime = "smolvm",
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
      `${this.baseUrl}/api/v1/machines${path}`,
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
      await response.body?.cancel();
      throw new SmolApiError(response.status, method, path, this.runtime);
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
