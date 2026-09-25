/** The Amika control-plane endpoints the daemon calls, authenticated by API key. */
import { z } from "zod";
import type { HostSize } from "./config.js";

export interface AmikaApiConfig {
  apiUrl: string;
  apiKey: string;
}

export const registeredHostSchema = z.object({
  id: z.string(),
  hostname: z.string(),
  url: z.string().nullable(),
});
export type RegisteredHost = z.infer<typeof registeredHostSchema>;

/** An Amika API failure; the message is safe to print. */
export class AmikaApiError extends Error {
  override name = "AmikaApiError";
}

/**
 * Register this host by hostname. The endpoint is idempotent: `201` creates
 * the host and stores the secret, `200` returns the existing host and leaves
 * its stored secret unchanged, so this is safe on every boot.
 */
export async function registerHost(
  api: AmikaApiConfig,
  input: { hostname: string; secretKey: string; sizes: HostSizes },
  fetcher: typeof fetch = fetch,
): Promise<{ host: RegisteredHost; created: boolean }> {
  const response = await send(api, fetcher, "POST", "/api/v0beta1/hosts", {
    hostname: input.hostname,
    secret: input.secretKey,
    sizes: input.sizes,
  });
  if (response.status !== 200 && response.status !== 201) {
    throw await apiError("register the host", response);
  }
  return {
    host: await parseHost(response),
    created: response.status === 201,
  };
}

/**
 * Record the host's internet-facing URL, which completes registration. The
 * secret is omitted, so Amika keeps the one it already stores.
 */
export async function setHostUrl(
  api: AmikaApiConfig,
  host: Pick<RegisteredHost, "id" | "hostname">,
  url: string,
  fetcher: typeof fetch = fetch,
): Promise<RegisteredHost> {
  const response = await send(
    api,
    fetcher,
    "PUT",
    `/api/v0beta1/hosts/${encodeURIComponent(host.id)}`,
    { hostname: host.hostname, url },
  );
  if (response.status !== 200) {
    throw await apiError("set the host URL", response);
  }
  return parseHost(response);
}

/**
 * Replace the sizes Amika stores for this host with the configured ones. An
 * existing host's registration leaves them unchanged, so this carries edits
 * to the TOML on later runs.
 */
export async function setHostSizes(
  api: AmikaApiConfig,
  host: Pick<RegisteredHost, "id" | "hostname">,
  sizes: HostSizes,
  fetcher: typeof fetch = fetch,
): Promise<RegisteredHost> {
  const response = await send(
    api,
    fetcher,
    "PUT",
    `/api/v0beta1/hosts/${encodeURIComponent(host.id)}`,
    { hostname: host.hostname, sizes },
  );
  if (response.status !== 200) {
    throw await apiError("update the host's sizes", response);
  }
  return parseHost(response);
}

type HostSizes = Record<string, HostSize>;

const REQUEST_TIMEOUT_MS = 30_000;

async function send(
  api: AmikaApiConfig,
  fetcher: typeof fetch,
  method: string,
  path: string,
  body: unknown,
): Promise<Response> {
  try {
    return await fetcher(`${api.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${api.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      // A redirect would resend the API key and secret to another origin.
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (isRefusedRedirect(error)) {
      throw new AmikaApiError(
        `Amika at ${api.apiUrl} answered with a redirect, which is refused so credentials are not resent; check the API URL (e.g. https rather than http)`,
      );
    }
    throw new AmikaApiError(
      `cannot reach Amika at ${api.apiUrl}: ${transportReason(error)}`,
    );
  }
}

async function parseHost(response: Response): Promise<RegisteredHost> {
  const parsed = registeredHostSchema.safeParse(
    await response.json().catch(() => undefined),
  );
  if (!parsed.success) {
    throw new AmikaApiError("Amika returned an unexpected host response");
  }
  return parsed.data;
}

/**
 * API errors are `{ error_code, message }`; the sign-in check in front of the
 * API answers `401`/`403` with just `{ error }` (e.g. "No organization ID").
 */
const errorBodySchema = z.union([
  z.object({ error_code: z.string(), message: z.string() }),
  z.object({ error: z.string() }),
]);

async function apiError(
  action: string,
  response: Response,
): Promise<AmikaApiError> {
  const body = errorBodySchema.safeParse(
    await response.json().catch(() => undefined),
  );
  const detail = !body.success
    ? `HTTP ${response.status}`
    : "error" in body.data
      ? `HTTP ${response.status}: ${body.data.error}`
      : `${body.data.error_code}: ${body.data.message}`;
  switch (response.status) {
    case 401:
      return new AmikaApiError(
        `Amika rejected the API key while trying to ${action} (${detail})`,
      );
    case 403:
      return new AmikaApiError(
        `Amika refused to ${action} with this API key (${detail})`,
      );
    default:
      return new AmikaApiError(`failed to ${action} (${detail})`);
  }
}

/** `fetch` with `redirect: "error"` fails with this cause on any redirect. */
function isRefusedRedirect(error: unknown): boolean {
  const cause = (error as { cause?: { message?: unknown } } | null)?.cause;
  return cause?.message === "unexpected redirect";
}

function transportReason(error: unknown): string {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return `no response within ${REQUEST_TIMEOUT_MS / 1000}s`;
  }
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === "string" ? cause.code : "network error";
}
