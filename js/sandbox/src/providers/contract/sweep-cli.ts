/** Command-line entry for the sweep; see `./sweep.ts`. */
import { createSandboxProvider } from "../registry";
import { providerDepsFromEnv, realProviderName } from "./env-target";
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
    isRunAlive: runProcessAlive,
    dryRun,
    settleMs: VENDOR_SETTLE_MS,
    log: (line) => console.log(line),
  });

  const open = results.reduce((n, r) => n + r.leaked.length, 0);
  const failed = results
    .flatMap((r) => r.outcomes)
    .filter((o) => o.event === "delete_failed");
  if (open === 0) {
    console.log(`No leaked resources under ${root}.`);
    return;
  }
  if (dryRun) {
    console.log(
      `${open} resource(s) would be deleted. Run without --dry-run to delete them.`,
    );
    return;
  }
  console.log(`${open - failed.length} deleted, ${failed.length} failed.`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
