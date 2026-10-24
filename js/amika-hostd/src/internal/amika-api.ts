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
  // How Amika reaches this host. Absent from a control plane older than the
  // field, which only ever served listening hosts, so its silence is read as
  // `listen` rather than left undefined for every caller to interpret.
  //
  // A plain string, not an enum: the schema is shared by every call, so
  // rejecting an unrecognised transport would fail `up`, `register-url` and
  // `setup` outright against a control plane that has added one, including
  // for the listening hosts on it. Callers test for the transport they
  // handle and leave the rest to the control plane, as the Go client does.
  transport_mode: z.string().default("listen"),
});
export type RegisteredHost = z.infer<typeof registeredHostSchema>;

/**
 * An Amika API failure, or a request this daemon refuses on the API's behalf
 * because the answer is already known. The message is safe to print.
 */
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
  cancel?: AbortSignal,
): Promise<{ host: RegisteredHost; created: boolean }> {
  const response = await send(
    api,
    fetcher,
    "POST",
    "/api/v0beta1/hosts",
    { hostname: input.hostname, secret: input.secretKey, sizes: input.sizes },
    cancel,
  );
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

/**
 * Replace the secret Amika stores for this host, which registration never
 * changes. Amika expires its rigs' cached service URLs with it, so the next
 * request to the host carries the new secret.
 */
export async function setHostSecret(
  api: AmikaApiConfig,
  host: Pick<RegisteredHost, "id" | "hostname">,
  secretKey: string,
  fetcher: typeof fetch = fetch,
  cancel?: AbortSignal,
): Promise<RegisteredHost> {
  const response = await send(
    api,
    fetcher,
    "PUT",
    `/api/v0beta1/hosts/${encodeURIComponent(host.id)}`,
    { hostname: host.hostname, secret: secretKey },
    cancel,
  );
  if (response.status !== 200) {
    throw await apiError("update the host's secret key", response);
  }
  return parseHost(response);
}

/**
 * What the control plane hands a tunnel host so it can dial out.
 *
 * `transport_mode` is a literal here, unlike `registeredHostSchema`'s
 * permissive string. That schema is shared by every call and must not fail
 * a listening host against a control plane that added a transport; this one
 * answers a single question -- may this host dial, and where -- and an
 * answer naming any other transport is one the daemon cannot act on.
 */
export const hostEnrolmentSchema = z.object({
  credential: z.string().min(1),
  generation: z.number().int().min(0),
  gateway_url: z.string().min(1),
  transport_mode: z.literal("tunnel"),
});
export type HostEnrolment = z.infer<typeof hostEnrolmentSchema>;

/**
 * Enrol this host for tunnel mode, and get what it needs to dial.
 *
 * Three things in one call: the credential, the generation the gateway
 * fences stale connections on, and the gateway's address. The address comes
 * from here rather than from a config file because the gateway for an
 * environment is deployment configuration Amika owns -- hosts move between
 * staging and production, and that should not mean editing a file on every
 * operator's laptop.
 *
 * Not idempotent in the way `registerHost` is. The control plane answers
 * with the credential it holds; a caller that wanted a *new* one rotates
 * instead. So calling this twice is safe and returns the same credential.
 */
export async function enrolHostTunnel(
  api: AmikaApiConfig,
  host: Pick<RegisteredHost, "id">,
  fetcher: typeof fetch = fetch,
  cancel?: AbortSignal,
): Promise<HostEnrolment> {
  const response = await send(
    api,
    fetcher,
    "POST",
    `/api/v0beta1/hosts/${encodeURIComponent(host.id)}/enrolment`,
    {},
    cancel,
  );
  if (response.status !== 200) {
    throw await apiError("enrol this host for tunnel mode", response);
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new AmikaApiError(
      "Amika's enrolment answer was not JSON. Check the API URL.",
    );
  }
  const parsed = hostEnrolmentSchema.safeParse(raw);
  if (!parsed.success) {
    // By field name. The body carries this host's credential, and a
    // message quoting the value it could not read would put the
    // credential wherever the message goes.
    const fields = parsed.error.issues.map((issue) =>
      issue.path.map(String).join("."),
    );
    throw new AmikaApiError(
      `Amika's enrolment answer has unexpected fields: ${[...new Set(fields)].join(", ")}`,
    );
  }
  return parsed.data;
}

type HostSizes = Record<string, HostSize>;

const REQUEST_TIMEOUT_MS = 30_000;

async function send(
  api: AmikaApiConfig,
  fetcher: typeof fetch,
  method: string,
  path: string,
  body: unknown,
  /** Stops the request early, e.g. on the operator's Ctrl-C. */
  cancel?: AbortSignal,
): Promise<Response> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
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
      signal: cancel ? AbortSignal.any([timeout, cancel]) : timeout,
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
