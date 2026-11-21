/**
 * Service URLs through Runtime previews
 * (https://withruntime.com/docs/reference/previews.md).
 *
 * Each service port gets a **private** preview: its URL answers only
 * requests that carry a preview token, as the `x-runtime-preview-token`
 * header or the `?runtime_preview_token=` query. A refresh signs a new
 * token (`:sign`), which leaves the old ones working until they expire.
 *
 * Every preview on a sandbox Amika created is Amika's, so route reconcile
 * deletes the previews no desired service uses.
 */
import { z } from "zod";
import type { RefreshUrlsResult, SandboxService } from "../../provider";
import type { RuntimeConfig } from "../config";
import { isNotFound, requestJson, sandboxPath, send } from "./client";

/** Preview URLs are HTTPS on the default port. */
const PUBLIC_HTTPS_PORT = 443;

/** How long a signed preview token lasts. */
const TOKEN_TTL_S = 7 * 24 * 60 * 60;

/** Refresh a day before tokens expire. */
export const RUNTIME_URL_TTL_S = TOKEN_TTL_S - 24 * 60 * 60;

/** The query parameter a browser sends a preview token in. */
const TOKEN_QUERY_PARAM = "runtime_preview_token";

const previewSchema = z.object({
  name: z.string(),
  port: z.number(),
  url: z.string(),
  token: z.string().nullish(),
});
const previewListSchema = z.object({
  items: z.array(previewSchema),
  next: z.string().nullish(),
});
const signedSchema = z.object({ token: z.string() });

function checkService(service: SandboxService): void {
  if (service.protocol !== "tcp") {
    throw new Error(
      `Runtime previews serve HTTP only; service "${service.name}" uses ${service.protocol}`,
    );
  }
}

async function ensurePreview(
  config: RuntimeConfig,
  sandboxId: string,
  port: number,
): Promise<z.infer<typeof previewSchema>> {
  // Idempotent per port: the same preview comes back.
  return requestJson(
    config,
    previewSchema,
    "POST",
    sandboxPath(sandboxId, "/previews"),
    { json: { port, visibility: "private", ttlSeconds: TOKEN_TTL_S } },
  );
}

/** The preview URL with a token in its query. Exported for tests. */
export function tokenUrl(url: string, token: string): string {
  const withToken = new URL(url);
  withToken.searchParams.set(TOKEN_QUERY_PARAM, token);
  return withToken.toString();
}

/** Make each service's preview and return a freshly signed URL for it. */
export async function refreshRuntimeUrls(
  config: RuntimeConfig,
  sandboxId: string,
  services: SandboxService[],
): Promise<RefreshUrlsResult> {
  const urls = new Map<number, string>();
  const refreshed: SandboxService[] = [];
  for (const service of services) {
    checkService(service);
    let url = urls.get(service.containerPort);
    if (url === undefined) {
      const preview = await ensurePreview(
        config,
        sandboxId,
        service.containerPort,
      );
      const signed = await requestJson(
        config,
        signedSchema,
        "POST",
        `/previews/${encodeURIComponent(preview.name)}:sign`,
        { query: { ttlSeconds: String(TOKEN_TTL_S) } },
      );
      url = tokenUrl(preview.url, signed.token);
      urls.set(service.containerPort, url);
    }
    refreshed.push({ ...service, url, hostPort: PUBLIC_HTTPS_PORT });
  }
  return { services: refreshed };
}

async function listPreviews(
  config: RuntimeConfig,
  sandboxId: string,
): Promise<z.infer<typeof previewSchema>[]> {
  const all: z.infer<typeof previewSchema>[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const res = await requestJson(
      config,
      previewListSchema,
      "GET",
      "/previews",
      {
        query: { sandboxId, limit: "200", cursor },
      },
    );
    all.push(...res.items);
    if (!res.next) return all;
    cursor = res.next;
  }
  throw new Error("Runtime preview listing did not end within 100 pages");
}

/** Make the sandbox's previews match `desired`. */
export async function syncRuntimeRoutes(
  config: RuntimeConfig,
  sandboxId: string,
  desired: SandboxService[],
): Promise<void> {
  for (const service of desired) checkService(service);
  const wanted = new Set(desired.map((s) => s.containerPort));
  const existing = await listPreviews(config, sandboxId);
  for (const preview of existing) {
    if (wanted.has(preview.port)) continue;
    try {
      const res = await send(
        config,
        "DELETE",
        `/previews/${encodeURIComponent(preview.name)}`,
      );
      await res.body?.cancel();
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  const have = new Set(existing.map((p) => p.port));
  for (const port of wanted) {
    if (!have.has(port)) await ensurePreview(config, sandboxId, port);
  }
}
