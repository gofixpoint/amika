/**
 * Build a real provider from the environment, for the integration entry: the
 * provider named in env, enabled, with its credentials read the way the
 * control plane reads them (`../../config-from-env.ts`).
 */
import { sandboxProviderConfigsFromEnv } from "../../config-from-env";
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
  simulate: "SIMULATE_ENABLED",
};

/** Parse a provider name from env; reject what the suite cannot run. */
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
