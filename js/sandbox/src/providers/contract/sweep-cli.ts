/** Command-line entry for the sweep; see `./sweep.ts`. */
import { createSandboxProvider } from "../registry";
import {
  providerDepsFromEnv,
  realProviderName,
  targetIdentity,
} from "./env-target";
import { contractRunsRoot } from "./run-dir";
import { runProcessAlive, sweepRuns } from "./sweep";

const VENDOR_SETTLE_MS = 2 * 60_000;

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const root = contractRunsRoot();
  const results = await sweepRuns(root, {
    providerFor: (name, resolveSnapshotId) =>
      createSandboxProvider(
        name,
        providerDepsFromEnv(
          realProviderName(name),
          process.env,
          resolveSnapshotId,
        ),
      ),
    identityFor: (name) =>
      targetIdentity(
        name,
        providerDepsFromEnv(realProviderName(name), process.env),
      ),
    isRunAlive: runProcessAlive,
    dryRun,
    settleMs: VENDOR_SETTLE_MS,
    log: (line) => console.log(line),
  });

  const open = results.reduce((n, r) => n + r.leaked.length, 0);
  const manual = results.reduce((n, r) => n + r.manual.length, 0);
  const refused = results.filter((r) => r.refused).length;
  if (refused > 0) process.exitCode = 1;
  const failed = results
    .flatMap((r) => r.outcomes)
    .filter((o) => o.event === "delete_failed");
  if (open === 0) {
    console.log(`No leaked resources under ${root}.`);
    return;
  }
  if (manual > 0) process.exitCode = 1;
  if (dryRun) {
    console.log(
      `${open - manual} resource(s) would be deleted, ${manual} need manual action. ` +
        "Run without --dry-run to delete them.",
    );
    return;
  }
  const deleted = results.flatMap((r) => r.outcomes).length - failed.length;
  console.log(
    `${deleted} deleted, ${failed.length} failed, ${manual} need manual action.`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
