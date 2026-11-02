/**
 * Build a real provider from the environment, for the integration entry and
 * the sweep. Both need the same thing: the provider named on the command
 * line, enabled, with its credentials read the way the control plane reads
 * them (`../../config-from-env.ts`).
 */
import { createHash } from "node:crypto";
import {
  sandboxProviderConfigsFromEnv,
  type SandboxProviderConfigs,
} from "../../config-from-env";
import type { SandboxProviderName } from "../../types";
import { isSandboxProviderName } from "../capabilities";
import type { SnapshotIdResolver } from "../provider";
import type { SandboxProviderDeps } from "../registry";

/**
 * The env var that enables each provider in `sandboxProviderConfigsFromEnv`.
 * `null` means the provider is always configured. Exhaustive over the name
 * union, so adding a provider without an entry here does not compile.
 */
const ENABLE_VAR: Record<SandboxProviderName, string | null> = {
  daytona: null,
  e2b: "E2B_ENABLED",
  freestyle: "FREESTYLE_ENABLED",
  vercel: "VERCEL_ENABLED",
  smol: "SMOL_ENABLED",
  "amika-hostd": "AMIKA_HOSTD_ENABLED",
  "amika-hostd-bare-metal": "AMIKA_HOSTD_ENABLED",
  simulate: "SIMULATE_ENABLED",
};

/** Parse a provider name from the command line or a ledger; reject what the suite cannot run. */
export function realProviderName(raw: string): SandboxProviderName {
  if (!isSandboxProviderName(raw)) {
    throw new Error(`${raw} is not a known provider`);
  }
  if (raw === "simulate") {
    throw new Error(
      "simulate has no shell to run the suite's commands; `pnpm test` already runs the contract against it",
    );
  }
  return raw;
}

/** Registry deps for `providerName`, with that provider enabled. */
export function providerDepsFromEnv(
  providerName: SandboxProviderName,
  env: Record<string, string | undefined>,
  resolveSnapshotId: SnapshotIdResolver = async () => null,
): SandboxProviderDeps {
  const enabled: Record<string, string | undefined> = { ...env };
  const enableVar = ENABLE_VAR[providerName];
  if (enableVar) enabled[enableVar] = "true";
  // The env contract always requires a Daytona key. Any value satisfies it
  // when Daytona is not the provider under test.
  if (providerName !== "daytona") enabled.DAYTONA_API_KEY ??= "unused";
  return { ...sandboxProviderConfigsFromEnv(enabled), resolveSnapshotId };
}

/** The `SandboxProviderConfigs` key holding each provider's config slice. */
const CONFIG_KEY: Record<SandboxProviderName, keyof SandboxProviderConfigs> = {
  daytona: "daytona",
  e2b: "e2b",
  freestyle: "freestyle",
  vercel: "vercel",
  smol: "smol",
  "amika-hostd": "amikaHostd",
  "amika-hostd-bare-metal": "amikaHostd",
  simulate: "simulate",
};

/**
 * The config fields that decide WHERE a provider's resources live (an
 * endpoint, an org, a project), as opposed to how it behaves. Exhaustive over
 * the name union, so a new provider must say what identifies its account.
 */
const IDENTITY_FIELDS: Record<SandboxProviderName, string[]> = {
  daytona: ["apiUrl", "target", "organizationId"],
  e2b: [],
  freestyle: ["apiUrl"],
  vercel: ["teamId", "projectId"],
  smol: ["apiUrl"],
  "amika-hostd": ["apiUrl"],
  "amika-hostd-bare-metal": ["apiUrl"],
  simulate: ["worldId"],
};

/** Credential fields. Only a short hash of each is recorded, never the value. */
const CREDENTIAL_FIELDS = ["apiKey", "secretKey"];

/**
 * A non-secret description of the account and endpoint `deps` points at.
 * The run records it in its ledger; the sweep refuses to touch a run whose
 * identity differs from its own, because a by-name lookup in the wrong
 * account finds nothing and would mark a live resource deleted.
 *
 * Credentials appear only as the first 12 hex characters of their SHA-256,
 * which tells two keys apart without revealing either.
 */
export function targetIdentity(
  providerName: SandboxProviderName,
  deps: SandboxProviderConfigs,
): Record<string, string> {
  const slice = (deps[CONFIG_KEY[providerName]] ?? {}) as Record<
    string,
    unknown
  >;
  const identity: Record<string, string> = { provider: providerName };
  for (const field of IDENTITY_FIELDS[providerName]) {
    identity[field] = slice[field] == null ? "" : String(slice[field]);
  }
  for (const field of CREDENTIAL_FIELDS) {
    const value = slice[field];
    if (typeof value === "string" && value !== "") {
      identity[`${field}Sha256`] = createHash("sha256")
        .update(value)
        .digest("hex")
        .slice(0, 12);
    }
  }
  return identity;
}

/** The fields where two identities differ, for an error message. */
export function identityDifferences(
  recorded: Record<string, string>,
  current: Record<string, string>,
): string[] {
  const keys = new Set([...Object.keys(recorded), ...Object.keys(current)]);
  return [...keys]
    .sort()
    .filter((key) => recorded[key] !== current[key])
    .map(
      (key) =>
        `${key}: run had ${JSON.stringify(recorded[key] ?? null)}, now ${JSON.stringify(current[key] ?? null)}`,
    );
}
