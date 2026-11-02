/** Provider configuration shared by local and Actions ledger cleanup. */
import { createSandboxProvider } from "../registry";
import {
  providerDepsFromEnv,
  realProviderName,
  targetIdentity,
} from "./env-target";
import { runProcessAlive, type SweepOptions } from "./sweep";

export function sweepOptionsFromEnv(
  env: Record<string, string | undefined>,
  dryRun: boolean,
): SweepOptions {
  return {
    providerFor: (name, resolveSnapshotId) =>
      createSandboxProvider(
        name,
        providerDepsFromEnv(realProviderName(name), env, resolveSnapshotId),
      ),
    identityFor: (name) =>
      targetIdentity(name, providerDepsFromEnv(realProviderName(name), env)),
    isRunAlive: runProcessAlive,
    dryRun,
    settleMs: 2 * 60_000,
    log: (line) => console.log(line),
  };
}
