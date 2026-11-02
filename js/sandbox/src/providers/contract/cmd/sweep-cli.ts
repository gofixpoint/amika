/** Command-line entry for local ledgers; see `../sweep.ts`. */
import { contractRunsRoot } from "../run-dir";
import { sweepRuns } from "../sweep";
import { sweepOptionsFromEnv } from "../sweep-options";
import { reportSweepResults } from "../sweep-report";

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const root = contractRunsRoot();
  const results = await sweepRuns(
    root,
    sweepOptionsFromEnv(process.env, dryRun),
  );
  reportSweepResults(results, root, dryRun);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
