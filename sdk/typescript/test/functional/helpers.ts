import { afterAll, describe } from "vitest";

import { AmikaClient } from "@/client";
import type {
  AgentCredentialRef,
  CreateSandboxRequest,
  RemoteSandbox,
} from "@/types";

/**
 * Required env vars to enable functional tests:
 *   AMIKA_API_URL    — base URL of the Amika API (e.g. https://app.amika.dev)
 *
 * Optional:
 *   AMIKA_API_TOKEN                      — bearer token; defaults to a dummy
 *                                          value so no-auth servers also work
 *   AMIKA_TEST_REPO_URL                  — repo URL passed to createSandbox
 *                                          (default: https://github.com/gofixpoint/example-repo)
 *   AMIKA_TEST_SANDBOX_PROVIDER          — infrastructure provider on createSandbox (default: "docker")
 *   AMIKA_TEST_PRESET                    — sandbox preset (default: "coder")
 *   AMIKA_TEST_AGENT_NAME                — agent name for sessions / agentSend (default: "claude")
 *   AMIKA_TEST_AGENT_CREDENTIAL_NAME     — credential `name` injected into the sandbox
 *   AMIKA_TEST_AGENT_CREDENTIAL_TYPE     — "oauth" or "api_key"
 *   AMIKA_TEST_SANDBOX_NAME_PREFIX       — prefix used for generated sandbox names (default: "ts-sdk-fn")
 *   AMIKA_TEST_BRANCH                    — branch checked out in the sandbox
 *   AMIKA_TEST_GITHUB_TOKEN              — GitHub PAT registered before provisioning
 *                                          a sandbox (servers that gate sandbox
 *                                          creation on a per-user GitHub token)
 *   AMIKA_TEST_PROVIDER                  — AI provider used in secrets.test.ts (default: "claude")
 *   AMIKA_TEST_PROVIDER_SECRET_VALUE     — real provider API key for the secrets
 *                                          round-trip test; required when the
 *                                          target server validates keys upstream
 *                                          (e.g. Anthropic). Falls back to a
 *                                          placeholder otherwise.
 *
 * When AMIKA_API_URL is unset, the helpers below cause every functional `describe`
 * to be skipped — `pnpm test:functional` becomes a no-op rather than failing.
 */

const apiUrl = process.env["AMIKA_API_URL"];
// AmikaClient requires a token. When the target server runs in no-auth mode,
// fall back to a dummy value so the SDK constructs without forcing the user to
// export AMIKA_API_TOKEN. Real deployments should still set a real token.
const apiToken = process.env["AMIKA_API_TOKEN"] ?? "no-auth-dummy-token";

export const functionalEnabled = Boolean(apiUrl);

/**
 * Wrap a `describe` block so it is skipped (with no setup cost) unless
 * AMIKA_API_URL is set.
 */
export const describeFunctional: typeof describe | typeof describe.skip =
  functionalEnabled ? describe : describe.skip;

/** Build an AmikaClient from env. Throws if functional tests are disabled. */
export function makeClient(): AmikaClient {
  if (!apiUrl) {
    throw new Error("makeClient(): AMIKA_API_URL must be set");
  }
  return new AmikaClient({ baseUrl: apiUrl, accessToken: apiToken });
}

export const TEST_REPO_URL =
  process.env["AMIKA_TEST_REPO_URL"] ??
  "https://github.com/gofixpoint/example-repo";
export const TEST_SANDBOX_PROVIDER =
  process.env["AMIKA_TEST_SANDBOX_PROVIDER"] ?? "docker";
export const TEST_PRESET = process.env["AMIKA_TEST_PRESET"] ?? "coder";
export const TEST_GITHUB_TOKEN = process.env["AMIKA_TEST_GITHUB_TOKEN"];
export const TEST_AGENT_NAME = process.env["AMIKA_TEST_AGENT_NAME"] ?? "claude";
export const TEST_BRANCH = process.env["AMIKA_TEST_BRANCH"];
const SANDBOX_NAME_PREFIX =
  process.env["AMIKA_TEST_SANDBOX_NAME_PREFIX"] ?? "ts-sdk-fn";

const agentCredentialName = process.env["AMIKA_TEST_AGENT_CREDENTIAL_NAME"];
const agentCredentialType = process.env["AMIKA_TEST_AGENT_CREDENTIAL_TYPE"] as
  | "oauth"
  | "api_key";

/** A short suffix so concurrent test runs don't collide on resource names. */
export function uniqueSuffix(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

const MAX_SANDBOX_NAME_LEN = 40;

/**
 * Generates `${prefix}-${suffix}` capped at 40 chars (server name limit).
 * Truncates the prefix rather than the combined string so the unique suffix
 * is always preserved — otherwise a long `AMIKA_TEST_SANDBOX_NAME_PREFIX`
 * would clip the random suffix and successive runs would collide.
 */
export function uniqueSandboxName(prefix = SANDBOX_NAME_PREFIX): string {
  const suffix = uniqueSuffix();
  // -1 reserves room for the joining hyphen.
  const maxPrefixLen = MAX_SANDBOX_NAME_LEN - 1 - suffix.length;
  if (maxPrefixLen <= 0) return suffix.slice(0, MAX_SANDBOX_NAME_LEN);
  return `${prefix.slice(0, maxPrefixLen)}-${suffix}`;
}

export function buildCreateSandboxRequest(
  overrides: Partial<CreateSandboxRequest> = {},
): CreateSandboxRequest {
  const req: CreateSandboxRequest = {
    name: uniqueSandboxName(),
    provider: TEST_SANDBOX_PROVIDER,
    repoUrl: TEST_REPO_URL,
    preset: TEST_PRESET,
    ...overrides,
  };
  if (TEST_BRANCH !== undefined && req.branch === undefined) {
    req.branch = TEST_BRANCH;
  }
  if (agentCredentialName !== undefined && req.agentCredentials === undefined) {
    req.agentCredentials = [
      {
        kind: TEST_AGENT_NAME,
        name: agentCredentialName,
        type: agentCredentialType,
      },
    ];
  }
  return req;
}

const PROVIDER_SECRET_VALUE = process.env["AMIKA_TEST_PROVIDER_SECRET_VALUE"];

/**
 * If AMIKA_TEST_PROVIDER_SECRET_VALUE is set, register it as a provider secret
 * for TEST_AGENT_NAME (default "claude") so the sandbox can authenticate agent
 * calls. Returns an `AgentCredentialRef` to pass into `createSandbox`, or null
 * when no value is configured. Registers afterAll cleanup.
 */
export async function ensureAgentCredential(
  client: AmikaClient,
): Promise<AgentCredentialRef | null> {
  if (!PROVIDER_SECRET_VALUE) return null;
  const name = `ts-sdk-fn-agent-${uniqueSuffix()}`;
  const summary = await client.createProviderSecret(TEST_AGENT_NAME, {
    name,
    value: PROVIDER_SECRET_VALUE,
    type: "api_key",
  });
  afterAll(async () => {
    try {
      await client.deleteProviderSecret(TEST_AGENT_NAME, summary.id);
    } catch {
      // Already deleted, or the server is unreachable; ignore.
    }
  });
  return { kind: TEST_AGENT_NAME, name, type: "api_key" };
}

/**
 * If AMIKA_TEST_GITHUB_TOKEN is set, register it as a `github` provider secret
 * so the server can clone the test repo. Registers an afterAll cleanup. No-op
 * when the env var is unset (assumes the user already configured a token).
 */
export async function ensureGitHubToken(client: AmikaClient): Promise<void> {
  if (!TEST_GITHUB_TOKEN) return;
  const name = `ts-sdk-fn-gh-${uniqueSuffix()}`;
  const summary = await client.createProviderSecret("github", {
    name,
    value: TEST_GITHUB_TOKEN,
    type: "api_key",
  });
  afterAll(async () => {
    try {
      await client.deleteProviderSecret("github", summary.id);
    } catch {
      // Already deleted, or the server is unreachable; ignore.
    }
  });
}

/**
 * Create a sandbox, wait for it to become active, and register an afterAll hook
 * that deletes it (best-effort) when the test file finishes. Intended to be
 * called inside a `beforeAll` so the same sandbox is reused across `it` blocks.
 */
export async function provisionSandbox(
  client: AmikaClient,
  overrides: Partial<CreateSandboxRequest> = {},
): Promise<RemoteSandbox> {
  const created = await client.createSandboxAndWait(
    buildCreateSandboxRequest(overrides),
  );
  // Register cleanup immediately so a failure after provisioning still tears
  // down the sandbox.
  afterAll(async () => {
    try {
      await client.deleteSandbox(created.name);
    } catch {
      // Already deleted by the test, or the server is unreachable; ignore.
    }
  });
  return created;
}

// Most operations finish in <1s, but sandbox provisioning, stop, start, and
// agent-send may legitimately take many minutes. Use a generous hook timeout
// so long-running setup doesn't time out.
export const LONG_TIMEOUT_MS = 15 * 60 * 1000;
