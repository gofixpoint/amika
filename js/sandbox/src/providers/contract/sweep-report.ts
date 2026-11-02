/** Print cleanup totals and fail the command when manual work remains. */
import type { SweepRunResult } from "./sweep";

export function reportSweepResults(
  results: SweepRunResult[],
  root: string,
  dryRun: boolean,
): void {
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
