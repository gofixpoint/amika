/**
 * Runs the provider contract against a real sandbox vendor.
 *
 *   TEST_SANDBOX_CONTRACT_PROVIDER=e2b \
 *   TEST_SANDBOX_CONTRACT_SNAPSHOT=<a snapshot the vendor can boot> \
 *   E2B_API_KEY=... pnpm --filter @amika/sandbox test:integration
 *
 * The vendor's own credentials come from the same env vars the control plane
 * uses (see `../../config-from-env.ts`). The suite turns the selected
 * provider's `*_ENABLED` flag on by itself. Every sandbox and snapshot the
 * suite creates is deleted after its test, and names carry a per-run id so
 * two runs never collide.
 *
 * With `TEST_SANDBOX_CONTRACT_PROVIDER` unset this file skips.
 */
import { describe, it } from "vitest";
import { sandboxProviderConfigsFromEnv } from "../../config-from-env";
import type { SandboxProviderName } from "../../types";
import { isSandboxProviderName } from "../capabilities";
import { createSandboxProvider } from "../registry";
import { describeProviderContract } from "./contract";

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

/** How long to keep polling for a vendor-side change, such as a listing update. */
const VENDOR_SETTLE_MS = 2 * 60_000;

const providerName = process.env.TEST_SANDBOX_CONTRACT_PROVIDER;

if (!providerName) {
  describe("provider contract against a real vendor", () => {
    it.skip("set TEST_SANDBOX_CONTRACT_PROVIDER to run", () => {});
  });
} else {
  if (!isSandboxProviderName(providerName)) {
    throw new Error(
      `TEST_SANDBOX_CONTRACT_PROVIDER=${providerName} is not a known provider`,
    );
  }
  if (providerName === "simulate") {
    throw new Error(
      "simulate has no shell to run the suite's commands; `pnpm test` already runs the contract against it",
    );
  }
  const bootSnapshot = process.env.TEST_SANDBOX_CONTRACT_SNAPSHOT;
  if (!bootSnapshot) {
    throw new Error(
      "TEST_SANDBOX_CONTRACT_SNAPSHOT must name a snapshot the provider can boot",
    );
  }

  const env: Record<string, string | undefined> = { ...process.env };
  const enableVar = ENABLE_VAR[providerName];
  if (enableVar) env[enableVar] = "true";
  // The env contract always requires a Daytona key. Any value satisfies it
  // when Daytona is not the provider under test.
  if (providerName !== "daytona") env.DAYTONA_API_KEY ??= "unused";
  const configs = sandboxProviderConfigsFromEnv(env);

  describeProviderContract({
    createProvider: (resolveSnapshotId) =>
      createSandboxProvider(providerName, { ...configs, resolveSnapshotId }),
    bootSnapshot,
    settleMs: VENDOR_SETTLE_MS,
  });
}
