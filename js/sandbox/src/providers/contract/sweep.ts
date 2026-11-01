/**
 * Delete the resources that earlier contract runs left behind.
 *
 * A run that is killed (SIGKILL, a CI timeout) leaves `created` lines in its
 * ledger with no outcome. The sweep reads every run directory, finds those
 * resources, deletes them through the provider named in the ledger, and
 * appends the outcome to the same ledger, marked `swept`. A run whose process
 * is still alive is skipped: its ledger looks the same as a dead run's, and
 * deleting its sandboxes would break the test in flight.
 *
 * Sweeping is never automatic. Run it by hand:
 *
 *   pnpm --filter @amika/sandbox sweep:contract            # delete
 *   pnpm --filter @amika/sandbox sweep:contract --dry-run  # only list
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { SandboxProviderName } from "../../types";
import type { SandboxProvider, SnapshotIdResolver } from "../provider";
import { summarize, type AuditRow } from "./audit-report";
import { fileSink, Ledger, parseLedger, type OutcomeEvent } from "./ledger";
import { AUDIT_FILE_NAME } from "./run-dir";

export interface SweepOptions {
  /** Build the provider a leaked resource belongs to. */
  providerFor(
    name: SandboxProviderName,
    resolveSnapshotId: SnapshotIdResolver,
  ): SandboxProvider;
  /** Whether the run that wrote a ledger is still running. */
  isRunAlive(runId: string): boolean;
  /** List what would be deleted without deleting. */
  dryRun?: boolean;
  /** How long to poll a listing to confirm a delete; default 0. */
  settleMs?: number;
  log?(line: string): void;
}

export interface SweepRunResult {
  runId: string;
  leaked: AuditRow[];
  outcomes: OutcomeEvent[];
  skipped?: "alive";
}

/** Sweep every run directory under `root`. */
export async function sweepRuns(
  root: string,
  options: SweepOptions,
): Promise<SweepRunResult[]> {
  if (!existsSync(root)) return [];
  const results: SweepRunResult[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, AUDIT_FILE_NAME);
    if (!existsSync(file)) continue;
    results.push(await sweepRun(entry.name, file, options));
  }
  return results;
}

/** Sweep one run's ledger file. */
export async function sweepRun(
  runId: string,
  file: string,
  options: SweepOptions,
): Promise<SweepRunResult> {
  const log = options.log ?? (() => {});
  const leaked = summarize(parseLedger(readFileSync(file, "utf8"))).rows.filter(
    (row) => row.outcome === "LEAKED",
  );
  if (leaked.length === 0) return { runId, leaked, outcomes: [] };
  if (options.isRunAlive(runId)) {
    log(
      `run ${runId}: still running, skipped (${leaked.length} open resource(s))`,
    );
    return { runId, leaked, outcomes: [], skipped: "alive" };
  }
  if (options.dryRun) {
    for (const row of leaked) {
      log(`run ${runId}: would delete ${row.kind} ${row.id} (${row.provider})`);
    }
    return { runId, leaked, outcomes: [] };
  }

  // Snapshot names resolve to the ids the ledger recorded, so providers with
  // opaque snapshot ids can look them up.
  const snapshotIds = new Map(
    leaked.filter((r) => r.kind === "snapshot").map((r) => [r.name, r.id]),
  );
  const providers = new Map<string, SandboxProvider>();
  const providerFor = (name: SandboxProviderName) => {
    let provider = providers.get(name);
    if (!provider) {
      provider = options.providerFor(
        name,
        async (n) => snapshotIds.get(n) ?? null,
      );
      providers.set(name, provider);
    }
    return provider;
  };

  const outcomes: OutcomeEvent[] = [];
  // Newest first, as the run itself would have deleted them.
  for (const row of [...leaked].reverse()) {
    const provider = providerFor(row.provider as SandboxProviderName);
    const ledger = new Ledger(row.provider, fileSink(file));
    const outcome = await ledger.sweep({
      kind: row.kind,
      id: row.id,
      name: row.name,
      test: row.test,
      delete: () => deleteResource(provider, row),
      verifyGone: verifier(provider, row, options.settleMs ?? 0),
    });
    outcomes.push(outcome);
    log(
      outcome.event === "deleted"
        ? `run ${runId}: deleted ${row.kind} ${row.id} (${row.provider})`
        : `run ${runId}: FAILED to delete ${row.kind} ${row.id} (${row.provider}): ${outcome.error}`,
    );
  }
  return { runId, leaked, outcomes };
}

async function deleteResource(
  provider: SandboxProvider,
  row: AuditRow,
): Promise<void> {
  if (row.kind === "sandbox") {
    await provider.sandboxes.get(row.id).delete();
    return;
  }
  // A snapshot already gone is a finished job, not an error.
  const snapshot = await provider.snapshots?.get(row.name);
  await snapshot?.delete();
}

function verifier(
  provider: SandboxProvider,
  row: AuditRow,
  settleMs: number,
): (() => Promise<boolean>) | undefined {
  const check =
    row.kind === "sandbox"
      ? provider.capabilities.listSandboxes
        ? async () =>
            !(await provider.sandboxes.list()).some(
              (l) => l.providerSandboxId === row.id,
            )
        : undefined
      : async () => (await provider.snapshots!.get(row.name)) === null;
  if (!check) return undefined;
  return async () => {
    const deadline = Date.now() + settleMs;
    for (;;) {
      if (await check()) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  };
}

/** Whether the process that owns `runId` (see `newRunId`) is still alive. */
export function runProcessAlive(runId: string): boolean {
  const pid = parseInt(runId.split("-").at(-1) ?? "", 36);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
