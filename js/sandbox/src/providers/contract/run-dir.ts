/**
 * Where a contract run keeps its audit ledger.
 *
 * Each run gets `<runs root>/<run id>/audit.jsonl`. The root defaults to
 * `js/sandbox/.contract-runs/` (gitignored) and can be moved with
 * `TEST_SANDBOX_CONTRACT_RUNS_DIR`, for example to a CI artifact directory.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export const AUDIT_FILE_NAME = "audit.jsonl";

export function contractRunsRoot(
  env: Record<string, string | undefined> = process.env,
): string {
  return (
    env.TEST_SANDBOX_CONTRACT_RUNS_DIR ??
    path.join(PACKAGE_ROOT, ".contract-runs")
  );
}

/** A run id that sorts by time and is unique per process. */
export function newRunId(now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `${stamp}-${process.pid.toString(36)}`;
}

export function auditFileFor(runId: string, root = contractRunsRoot()): string {
  return path.join(root, runId, AUDIT_FILE_NAME);
}
