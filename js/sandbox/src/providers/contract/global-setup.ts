/**
 * Vitest global setup for the integration config: owns the run's audit file
 * and prints the audit summary once, after every test file, even when tests
 * failed.
 *
 * `setup` picks the run id, hands the audit file path to the test files
 * through vitest's `provide`, and warns about leftovers from earlier runs.
 * `teardown` prints the summary to stdout, appends it to
 * `$GITHUB_STEP_SUMMARY` on GitHub Actions, and fails the run when any
 * resource leaked: a leaked sandbox costs money every hour, and nobody reads
 * the stdout of a green run.
 *
 * The teardown fails closed. Vitest only logs a teardown error and keeps its
 * own exit code, so every failure path sets `process.exitCode = 1` before
 * anything else can throw: an unreadable ledger counts as a leak, a leak is
 * marked failed before the report is written, and a report that cannot be
 * written fails the run too.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { TestProject } from "vitest/node";
import {
  renderMarkdown,
  renderText,
  summarize,
  type AuditSummary,
} from "./audit-report";
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
  let summary: AuditSummary;
  try {
    const contents = existsSync(auditFile)
      ? readFileSync(auditFile, "utf8")
      : "";
    summary = summarize(parseLedger(contents));
  } catch (error) {
    process.exitCode = 1;
    console.error(
      `\nProvider contract audit  run=${runId}\n` +
        `Could not read the audit ledger ${auditFile}: ${message(error)}\n` +
        "Treating the run as leaked. Inspect the file by hand.\n",
    );
    throw error;
  }
  if (summary.leaked > 0) process.exitCode = 1;

  console.log(`\n${renderText(summary, { runId, file: auditFile })}\n`);
  const reportErrors: unknown[] = [];
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `${renderMarkdown(summary, { runId })}\n\n`,
      );
    } catch (error) {
      reportErrors.push(error);
    }
  }
  if (process.env.GITHUB_ACTIONS) {
    for (const row of summary.rows.filter((r) => r.outcome === "LEAKED")) {
      console.log(
        `::warning::leaked ${row.kind} ${row.id} (${row.provider}): ${row.detail}`,
      );
    }
  }

  if (reportErrors.length > 0) {
    process.exitCode = 1;
    throw new AggregateError(
      reportErrors,
      "could not write the audit to $GITHUB_STEP_SUMMARY",
    );
  }
  if (summary.leaked > 0) {
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
    let leaked: number;
    try {
      leaked = summarize(parseLedger(readFileSync(file, "utf8"))).leaked;
    } catch (error) {
      console.warn(
        `earlier contract run ${entry.name} has an unreadable ledger ` +
          `(${message(error)}); inspect ${file} by hand`,
      );
      continue;
    }
    if (leaked > 0) {
      console.warn(
        `earlier contract run ${entry.name} left ${leaked} resource(s); ` +
          `delete them by hand; see ${file}`,
      );
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
