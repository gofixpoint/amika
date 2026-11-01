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
 * two runs never collide. Every resource and its deletion outcome is recorded
 * in `.contract-runs/<run id>/audit.jsonl` (see `./ledger.ts`), and
 * `./global-setup.ts` prints the summary when the run ends.
 *
 * With `TEST_SANDBOX_CONTRACT_PROVIDER` unset this file skips.
 */
import { describe, inject, it } from "vitest";
import { createSandboxProvider, getSandboxAdapter } from "../registry";
import { describeProviderContract } from "./contract";
import { providerDepsFromEnv, realProviderName } from "./env-target";

/** How long to keep polling for a vendor-side change, such as a listing update. */
const VENDOR_SETTLE_MS = 2 * 60_000;

const rawProviderName = process.env.TEST_SANDBOX_CONTRACT_PROVIDER;

if (!rawProviderName) {
  describe("provider contract against a real vendor", () => {
    it.skip("set TEST_SANDBOX_CONTRACT_PROVIDER to run", () => {});
  });
} else {
  const providerName = realProviderName(rawProviderName);
  const bootSnapshot = process.env.TEST_SANDBOX_CONTRACT_SNAPSHOT;
  if (!bootSnapshot) {
    throw new Error(
      "TEST_SANDBOX_CONTRACT_SNAPSHOT must name a snapshot the provider can boot",
    );
  }
  const deps = providerDepsFromEnv(providerName, process.env);

  describeProviderContract({
    createProvider: (resolveSnapshotId) =>
      createSandboxProvider(providerName, { ...deps, resolveSnapshotId }),
    openAdapter: (id) => getSandboxAdapter(providerName, deps, id),
    bootSnapshot,
    settleMs: VENDOR_SETTLE_MS,
    auditFile: inject("contractAuditFile"),
  });
}
