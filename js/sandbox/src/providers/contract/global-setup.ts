/**
 * Vitest global setup for the integration config: owns the run's audit file
 * and prints the audit summary once, after every test file, even when tests
 * failed.
 *
 * `setup` picks the run id, hands the audit file path to the test files
 * through vitest's `provide`, and warns about leftovers from earlier runs.
 * `teardown` prints the summary to stdout, appends it to
 * `$GITHUB_STEP_SUMMARY` on GitHub Actions, and throws when any resource
 * leaked so the run exits non-zero: a leaked sandbox costs money every hour,
 * and nobody reads the stdout of a green run.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { TestProject } from "vitest/node";
import { renderMarkdown, renderText, summarize } from "./audit-report";
import { parseLedger } from "./ledger";
import {
  AUDIT_FILE_NAME,
  auditFileFor,
  contractRunsRoot,
  newRunId,
} from "./run-dir";

declare module "vitest" {
  export interface ProvidedContext {
    contractAuditFile: string;
  }
}

let runId = "";
let auditFile = "";

export function setup(project: TestProject): void {
  // A fixed id lets a pre-written ledger drive the teardown, for checking
  // the summary and the leak failure by hand.
  runId = process.env.TEST_SANDBOX_CONTRACT_RUN_ID ?? newRunId();
  auditFile = auditFileFor(runId);
  project.provide("contractAuditFile", auditFile);
  warnAboutEarlierRuns(contractRunsRoot(), runId);
}

export function teardown(): void {
  const contents = existsSync(auditFile) ? readFileSync(auditFile, "utf8") : "";
  const summary = summarize(parseLedger(contents));
  console.log(`\n${renderText(summary, { runId, file: auditFile })}\n`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `${renderMarkdown(summary, { runId })}\n\n`,
    );
  }
  if (process.env.GITHUB_ACTIONS) {
    for (const row of summary.rows.filter((r) => r.outcome === "LEAKED")) {
      console.log(
        `::warning::leaked ${row.kind} ${row.id} (${row.provider}): ${row.detail}`,
      );
    }
  }
  if (summary.leaked > 0) {
    // Vitest logs a teardown error but keeps its own exit code, so set it
    // here as well: a leak must make the run red.
    process.exitCode = 1;
    throw new Error(
      `${summary.leaked} resource(s) leaked; see the audit above and ${auditFile}`,
    );
  }
}

/** Print one line per earlier run whose ledger still has leaked resources. */
function warnAboutEarlierRuns(root: string, currentRunId: string): void {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === currentRunId) continue;
    const file = path.join(root, entry.name, AUDIT_FILE_NAME);
    if (!existsSync(file)) continue;
    const { leaked } = summarize(parseLedger(readFileSync(file, "utf8")));
    if (leaked > 0) {
      console.warn(
        `earlier contract run ${entry.name} left ${leaked} resource(s); ` +
          `run \`pnpm --filter @amika/sandbox sweep:contract\` to delete them`,
      );
    }
  }
}
