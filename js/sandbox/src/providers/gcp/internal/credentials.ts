/**
 * Service account credentials: parse the JSON key and trade it for an OAuth
 * access token with the JWT bearer grant
 * (https://developers.google.com/identity/protocols/oauth2/service-account#httprest).
 *
 * The grant needs no Google library: we sign the assertion with the key's
 * RSA private key (`node:crypto`) and post it to the key's `token_uri`.
 * Tokens last an hour. We keep each one in memory, per key, until five
 * minutes before it ends.
 */
import { createHash, createSign } from "node:crypto";
import { z } from "zod";
import type { GcpConfig } from "../config";

export const GCP_DEFAULT_ZONE = "us-central1-a";

const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";

/** Read and change Compute Engine resources; nothing else. */
const COMPUTE_SCOPE = "https://www.googleapis.com/auth/compute";

const TOKEN_LIFETIME_S = 3600;

/** Get a new token when the cached one has less than this left. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

const TOKEN_REQUEST_TIMEOUT_MS = 30_000;

/** Zone names, such as `europe-west1-b`. */
const ZONE_PATTERN = /^[a-z]+-[a-z]+[0-9]+-[a-z]$/;

const serviceAccountKeySchema = z.object({
  type: z.literal("service_account"),
  project_id: z.string().min(1),
  private_key_id: z.string().optional(),
  private_key: z.string().min(1),
  client_email: z.string().min(1),
  token_uri: z.string().url().optional(),
  // Not part of Google's key format: an Amika extension so one pasted key
  // can also pick the zone.
  zone: z.string().optional(),
});

/** A parsed service account key, with the zone VMs run in. */
export interface GcpCredentials {
  projectId: string;
  zone: string;
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
  /** A short hash of the key: tells two keys apart without revealing one. */
  keyHash: string;
}

/**
 * Parse `config.apiKey`, which is the JSON key or the JSON in base64. Throws
 * a message that names what is wrong but never repeats the key.
 */
export function parseGcpCredentials(config: GcpConfig): GcpCredentials {
  const raw = config.apiKey.trim();
  const json = raw.startsWith("{")
    ? raw
    : Buffer.from(raw, "base64").toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error(
      "The GCP key is not JSON: use a service account's JSON key, or that JSON in base64",
    );
  }
  const parsed = serviceAccountKeySchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `The GCP key is not a service account JSON key (${parsed.error.issues
        .map((issue) => issue.path.join(".") || issue.message)
        .join(", ")})`,
    );
  }
  const key = parsed.data;
  const zone = key.zone ?? config.zone ?? GCP_DEFAULT_ZONE;
  if (!ZONE_PATTERN.test(zone)) {
    throw new Error(`"${zone}" is not a Compute Engine zone name`);
  }
  return {
    projectId: key.project_id,
    zone,
    clientEmail: key.client_email,
    privateKey: key.private_key,
    tokenUri: key.token_uri ?? DEFAULT_TOKEN_URI,
    keyHash: createHash("sha256")
      .update(key.private_key)
      .digest("hex")
      .slice(0, 16),
  };
}

/** The signed JWT the token endpoint takes. Exported for tests. */
export function signedAssertion(
  credentials: GcpCredentials,
  nowS: number,
): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned =
    encode({ alg: "RS256", typ: "JWT" }) +
    "." +
    encode({
      iss: credentials.clientEmail,
      scope: COMPUTE_SCOPE,
      aud: credentials.tokenUri,
      iat: nowS,
      exp: nowS + TOKEN_LIFETIME_S,
    });
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .sign(credentials.privateKey)
    .toString("base64url");
  return `${unsigned}.${signature}`;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** A Compute Engine access token for `credentials`. */
export async function gcpAccessToken(
  credentials: GcpCredentials,
): Promise<string> {
  const cacheKey = `${credentials.clientEmail}:${credentials.keyHash}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
    return cached.token;
  }
  const res = await fetch(credentials.tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: signedAssertion(credentials, Math.floor(Date.now() / 1000)),
    }),
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    // Google's answer names the problem (`invalid_grant`, a disabled key)
    // and never echoes the assertion.
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(
      `Google refused the GCP service account key (${res.status}): ${detail}`,
    );
  }
  const body = tokenResponseSchema.parse(await res.json());
  tokenCache.set(cacheKey, {
    token: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  });
  return body.access_token;
}
