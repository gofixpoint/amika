import { afterAll, describe } from "vitest";

import { AmikaClient } from "@/index";
import { assertNotProdUrl } from "./prod-guard";
import type { AgentCredentialRef, CreateRigRequest, RemoteRig } from "@/index";

/**
 * Required env vars to enable functional tests:
 *   AMIKA_API_URL    — base URL of the Amika API (e.g. https://app.staging-amika.dev)
 *
 * Optional:
 *   AMIKA_API_TOKEN                      — bearer token; defaults to a dummy
 *                                          value so no-auth servers also work
 *   AMIKA_TEST_REPO_URL                  — repo URL passed to createRig
 *                                          (default: https://github.com/gofixpoint/example-repo)
 *   AMIKA_TEST_RIG_PROVIDER              — infrastructure provider on createRig
 *                                          (default: "e2b", Amika's default cloud)
 *   AMIKA_TEST_PRESET                    — rig preset (default: "coder")
 *   AMIKA_TEST_AGENT_NAME                — agent name for sessions / agentSend (default: "claude")
 *   AMIKA_TEST_AGENT_CREDENTIAL_NAME     — name of an existing agent credential
 *                                          to inject into the rig
 *   AMIKA_TEST_AGENT_CREDENTIAL_TYPE     — "oauth" or "api_key" (default: "api_key")
 *   AMIKA_TEST_RIG_NAME_PREFIX           — prefix used for generated rig names (default: "ts-sdk-fn")
 *   AMIKA_TEST_BRANCH                    — branch checked out in the rig
 *   AMIKA_TEST_GITHUB_TOKEN              — GitHub PAT registered before provisioning
 *                                          a rig (servers that gate rig
 *                                          creation on a per-user GitHub token)
 *   AMIKA_TEST_PROVIDER                  — AI provider used in secrets.test.ts (default: "claude")
 *   AMIKA_TEST_PROVIDER_SECRET_VALUE     — real provider API key. The secrets
 *                                          round-trip test sends it when the
 *                                          target server validates keys upstream
 *                                          (e.g. Anthropic) and falls back to a
 *                                          placeholder otherwise. The rig suite
 *                                          registers it as a temporary agent
 *                                          credential (see resolveAgentCredential).
 *
 * `||` rather than `??` on the two fallbacks below, matching the rule the SDK
 * itself follows: a set-but-empty rig var falls through to the legacy var and
 * then to the default, instead of shadowing both with "".
 *
 * The two rig vars keep their former spellings as aliases:
 * AMIKA_TEST_SANDBOX_PROVIDER and AMIKA_TEST_SANDBOX_NAME_PREFIX are still read
 * when the `RIG` name is unset, so existing shell profiles and CI configs need
 * no edit.
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
  // Defense in depth: also enforced by the functional runner's globalSetup.
  assertNotProdUrl(apiUrl);
  return new AmikaClient({ baseUrl: apiUrl, accessToken: apiToken });
}

export const TEST_REPO_URL =
  process.env["AMIKA_TEST_REPO_URL"] ??
  "https://github.com/gofixpoint/example-repo";
export const TEST_RIG_PROVIDER =
  process.env["AMIKA_TEST_RIG_PROVIDER"] ||
  process.env["AMIKA_TEST_SANDBOX_PROVIDER"] ||
  "e2b";
export const TEST_PRESET = process.env["AMIKA_TEST_PRESET"] ?? "coder";
export const TEST_GITHUB_TOKEN = process.env["AMIKA_TEST_GITHUB_TOKEN"];
export const TEST_AGENT_NAME = process.env["AMIKA_TEST_AGENT_NAME"] ?? "claude";
export const TEST_BRANCH = process.env["AMIKA_TEST_BRANCH"];
const RIG_NAME_PREFIX =
  process.env["AMIKA_TEST_RIG_NAME_PREFIX"] ||
  process.env["AMIKA_TEST_SANDBOX_NAME_PREFIX"] ||
  "ts-sdk-fn";

const agentCredentialName = process.env["AMIKA_TEST_AGENT_CREDENTIAL_NAME"];
const agentCredentialType = (process.env["AMIKA_TEST_AGENT_CREDENTIAL_TYPE"] ||
  "api_key") as "oauth" | "api_key";

/** A short suffix so concurrent test runs don't collide on resource names. */
export function uniqueSuffix(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

const MAX_RIG_NAME_LEN = 40;

/**
 * Generates `${prefix}-${suffix}` capped at 40 chars (server name limit).
 * Truncates the prefix rather than the combined string so the unique suffix
 * is always preserved — otherwise a long `AMIKA_TEST_RIG_NAME_PREFIX`
 * would clip the random suffix and successive runs would collide.
 */
export function uniqueRigName(prefix = RIG_NAME_PREFIX): string {
  const suffix = uniqueSuffix();
  // -1 reserves room for the joining hyphen.
  const maxPrefixLen = MAX_RIG_NAME_LEN - 1 - suffix.length;
  if (maxPrefixLen <= 0) return suffix.slice(0, MAX_RIG_NAME_LEN);
  return `${prefix.slice(0, maxPrefixLen)}-${suffix}`;
}

export function buildCreateRigRequest(
  overrides: Partial<CreateRigRequest> = {},
): CreateRigRequest {
  const req: CreateRigRequest = {
    name: uniqueRigName(),
    provider: TEST_RIG_PROVIDER,
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
 * Pick the agent credential a rig suite injects, in order:
 *   1. AMIKA_TEST_AGENT_CREDENTIAL_NAME (with _TYPE): an existing credential.
 *   2. AMIKA_TEST_PROVIDER_SECRET_VALUE: registered for this run, then deleted.
 *   3. The first api_key credential the org already holds for TEST_AGENT_NAME.
 * Throws with the env vars to set when none applies, so a missing credential
 * fails setup loudly instead of skipping the agent coverage.
 */
export async function resolveAgentCredential(
  client: AmikaClient,
  cleanup: Cleanup,
): Promise<AgentCredentialRef> {
  if (agentCredentialName) {
    return {
      kind: TEST_AGENT_NAME,
      name: agentCredentialName,
      type: agentCredentialType,
    };
  }
  const registered = await ensureAgentCredential(client, cleanup);
  if (registered) return registered;

  const secrets = await client.listProviderSecrets(TEST_AGENT_NAME);
  const apiKeySecret = secrets.find((s) => s.type === "api_key");
  if (!apiKeySecret) {
    throw new Error(
      `No api_key credential found for agent "${TEST_AGENT_NAME}" in the ` +
        "target org. Set AMIKA_TEST_PROVIDER_SECRET_VALUE to a real " +
        `${TEST_AGENT_NAME} API key to register a temporary one, set ` +
        "AMIKA_TEST_AGENT_CREDENTIAL_NAME (and AMIKA_TEST_AGENT_CREDENTIAL_TYPE " +
        "if it is not api_key) to use an existing credential, or add an " +
        `api_key credential for "${TEST_AGENT_NAME}" to the org.`,
    );
  }
  return {
    kind: TEST_AGENT_NAME,
    type: "api_key",
    ...(apiKeySecret.name ? { name: apiKeySecret.name } : {}),
  };
}

/**
 * If AMIKA_TEST_PROVIDER_SECRET_VALUE is set, register it as a provider secret
 * for TEST_AGENT_NAME (default "claude") so the rig can authenticate agent
 * calls. Returns an `AgentCredentialRef` to pass into `createRig`, or null
 * when no value is configured. Deletes the secret through `cleanup`.
 */
export async function ensureAgentCredential(
  client: AmikaClient,
  cleanup: Cleanup,
): Promise<AgentCredentialRef | null> {
  if (!PROVIDER_SECRET_VALUE) return null;
  const name = `ts-sdk-fn-agent-${uniqueSuffix()}`;
  const summary = await client.createProviderSecret(TEST_AGENT_NAME, {
    name,
    value: PROVIDER_SECRET_VALUE,
    type: "api_key",
  });
  cleanup.later(() => client.deleteProviderSecret(TEST_AGENT_NAME, summary.id));
  return { kind: TEST_AGENT_NAME, name, type: "api_key" };
}

/**
 * If AMIKA_TEST_GITHUB_TOKEN is set, register it as a `github` provider secret
 * so the server can clone the test repo, and delete it through `cleanup`. No-op
 * when the env var is unset (assumes the user already configured a token).
 */
export async function ensureGitHubToken(
  client: AmikaClient,
  cleanup: Cleanup,
): Promise<void> {
  if (!TEST_GITHUB_TOKEN) return;
  const name = `ts-sdk-fn-gh-${uniqueSuffix()}`;
  const summary = await client.createProviderSecret("github", {
    name,
    value: TEST_GITHUB_TOKEN,
    type: "api_key",
  });
  cleanup.later(() => client.deleteProviderSecret("github", summary.id));
}

/**
 * Create a rig, wait for it to become active, and delete it through `cleanup`
 * when the describe block finishes. Intended to be called inside a `beforeAll`
 * so the same rig is reused across `it` blocks.
 */
export async function provisionRig(
  client: AmikaClient,
  cleanup: Cleanup,
  overrides: Partial<CreateRigRequest> = {},
): Promise<RemoteRig> {
  const created = await client.createRig(buildCreateRigRequest(overrides));
  // Register cleanup immediately so a failure in waitForRig still tears
  // down the newly created rig.
  cleanup.rig(client, created.name);
  return await client.waitForRig(created.name);
}

/**
 * Best-effort teardown for one describe block. Create it at describe scope:
 * vitest silently skips an `afterAll` registered inside `beforeAll` or `it`,
 * so code that makes a resource there records the delete here instead.
 * Rigs are deleted before everything else, because a snapshot delete fails
 * while the rig it was captured from still exists.
 */
export class Cleanup {
  private readonly rigTasks: Array<() => Promise<unknown>> = [];
  private readonly laterTasks: Array<() => Promise<unknown>> = [];

  constructor() {
    afterAll(() => this.run(), LONG_TIMEOUT_MS);
  }

  /** Delete the named rig. */
  rig(client: AmikaClient, name: string): void {
    this.rigTasks.push(() => client.deleteRig(name));
  }

  /** Run `task` after every rig is deleted. */
  later(task: () => Promise<unknown>): void {
    this.laterTasks.push(task);
  }

  private async run(): Promise<void> {
    const rigsFirst = [
      ...[...this.rigTasks].reverse(),
      ...[...this.laterTasks].reverse(),
    ];
    for (const task of rigsFirst) {
      try {
        await task();
      } catch {
        // Already deleted by the test, or the server is unreachable; ignore.
      }
    }
  }
}

// Most operations finish in <1s, but rig provisioning, stop, start, and
// agent-send may legitimately take many minutes. Use a generous hook timeout
// so long-running setup doesn't time out.
export const LONG_TIMEOUT_MS = 15 * 60 * 1000;
