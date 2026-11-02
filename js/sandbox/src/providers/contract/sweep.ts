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
 * The sweep only acts on a run whose recorded target (account, endpoint,
 * credential fingerprint; see `targetIdentity`) matches the one it is
 * configured for. In any other account a by-name lookup finds nothing, and
 * that would mark a live resource deleted.
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
import { identityDifferences } from "./env-target";
import { fileSink, Ledger, parseLedger, type OutcomeEvent } from "./ledger";
import { AUDIT_FILE_NAME } from "./run-dir";

export interface SweepOptions {
  /** Build the provider a leaked resource belongs to. */
  providerFor(
    name: SandboxProviderName,
    resolveSnapshotId: SnapshotIdResolver,
  ): SandboxProvider;
  /** The target the sweep is configured for (`targetIdentity`). */
  identityFor(name: SandboxProviderName): Record<string, string>;
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
  /** Leaked resources the sweep cannot delete; a person must. */
  manual: AuditRow[];
  skipped?: "alive";
  /** Why the sweep would not touch this run; its leaks stay as they are. */
  refused?: string;
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
  const events = parseLedger(readFileSync(file, "utf8"));
  const leaked = summarize(events).rows.filter(
    (row) => row.outcome === "LEAKED",
  );
  if (leaked.length === 0) return { runId, leaked, outcomes: [], manual: [] };
  if (options.isRunAlive(runId)) {
    log(
      `run ${runId}: still running, skipped (${leaked.length} open resource(s))`,
    );
    return { runId, leaked, outcomes: [], manual: [], skipped: "alive" };
  }
  const refused = refusal(events, options);
  if (refused) {
    log(`run ${runId}: refused, ${refused}`);
    return { runId, leaked, outcomes: [], manual: [], refused };
  }

  // SSH access is revoked with its token, which is never written to disk.
  const manual = leaked.filter((row) => row.kind === "ssh-access");
  for (const row of manual) {
    log(
      `run ${runId}: cannot revoke ${row.name} (${row.provider}) without its token; ` +
        "revoke it in the vendor console, then delete this run's directory",
    );
  }
  const sweepable = leaked.filter((row) => row.kind !== "ssh-access");
  if (options.dryRun) {
    for (const row of sweepable) {
      log(`run ${runId}: would delete ${row.kind} ${row.id} (${row.provider})`);
    }
    return { runId, leaked, outcomes: [], manual };
  }

  // Snapshot names resolve to the bootable ids the ledger recorded, so
  // providers with opaque snapshot ids can look them up.
  const snapshotIds = new Map(
    leaked
      .filter((r) => r.kind === "snapshot" && r.providerId)
      .map((r) => [r.name, r.providerId!]),
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
  for (const row of [...sweepable].reverse()) {
    const provider = providerFor(row.provider as SandboxProviderName);
    const ledger = new Ledger(row.provider, fileSink(file));
    const outcome = await ledger.sweep({
      kind: row.kind,
      id: row.id,
      name: row.name,
      test: row.test,
      delete: () => deleteResource(provider, row, snapshotIds, ledger),
      verifyGone: verifier(provider, row, snapshotIds, options.settleMs ?? 0),
    });
    outcomes.push(outcome);
    log(
      outcome.event === "deleted"
        ? `run ${runId}: deleted ${row.kind} ${row.id} (${row.provider})`
        : `run ${runId}: FAILED to delete ${row.kind} ${row.id} (${row.provider}): ${outcome.error}`,
    );
  }
  return { runId, leaked, outcomes, manual };
}

/**
 * Why the sweep must not act on this run, or `undefined` when it may. A
 * ledger with no header, more than one provider, or a different target is
 * refused: the sweep cannot know it is looking in the right account.
 */
function refusal(
  events: ReturnType<typeof parseLedger>,
  options: SweepOptions,
): string | undefined {
  const header = events.find((e) => e.event === "run");
  if (!header || header.event !== "run") {
    return "the ledger has no run header recording its target; sweep it by hand";
  }
  const providers = new Set(
    events.flatMap((e) => (e.event === "created" ? [e.provider] : [])),
  );
  if ([...providers].some((p) => p !== header.provider)) {
    return `the ledger mixes providers (${[...providers].join(", ")}); sweep it by hand`;
  }
  const differences = identityDifferences(
    header.target,
    options.identityFor(header.provider as SandboxProviderName),
  );
  if (differences.length > 0) {
    return `the sweep is configured for a different target than the run used: ${differences.join("; ")}`;
  }
  return undefined;
}

/**
 * Find a snapshot by name with the registration-tolerant lookup. On a
 * provider with opaque ids, try name lookup before requiring a recorded id.
 * A null lookup without either id is ambiguous, so it fails closed.
 */
async function findSnapshot(
  provider: SandboxProvider,
  row: AuditRow,
  snapshotIds: Map<string, string>,
) {
  const snapshot = await provider.snapshots!.find(row.name);
  if (snapshot?.providerSnapshotId)
    snapshotIds.set(row.name, snapshot.providerSnapshotId);
  if (
    !snapshot &&
    provider.capabilities.snapshotIdsAreOpaque &&
    !snapshotIds.has(row.name)
  ) {
    throw new Error(
      `no bootable id was recorded for snapshot ${row.name}, so it cannot be looked up; check the provider by hand`,
    );
  }
  return snapshot;
}

async function deleteResource(
  provider: SandboxProvider,
  row: AuditRow,
  snapshotIds: Map<string, string>,
  ledger: Ledger,
): Promise<void> {
  switch (row.kind) {
    case "sandbox": {
      // New ledgers record the name before create and identify its id later.
      // Older ledgers already used the provider id as their resource id.
      let id = row.providerId ?? (row.id !== row.name ? row.id : undefined);
      if (!id && provider.capabilities.listSandboxes) {
        const found = (await provider.sandboxes.list()).find(
          (s) => s.name === row.name,
        );
        id = found?.providerSandboxId;
      }
      if (!id)
        throw new Error(
          `no provider id was recorded or recovered for sandbox ${row.name}; check the provider by hand`,
        );
      if (!row.providerId) ledger.identify("sandbox", row.id, id);
      row.providerId = id;
      await provider.sandboxes.get(id).delete();
      return;
    }
    case "snapshot": {
      // A snapshot already gone is a finished job, not an error.
      const snapshot = await findSnapshot(provider, row, snapshotIds);
      if (snapshot?.providerSnapshotId)
        ledger.identify("snapshot", row.id, snapshot.providerSnapshotId);
      await snapshot?.delete();
      return;
    }
    case "ssh-access":
      throw new Error("ssh access cannot be swept; see `manual`");
    default:
      assertNever(row.kind);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled resource kind: ${String(value)}`);
}

function verifier(
  provider: SandboxProvider,
  row: AuditRow,
  snapshotIds: Map<string, string>,
  settleMs: number,
): (() => Promise<boolean>) | undefined {
  const check =
    row.kind === "sandbox"
      ? provider.capabilities.listSandboxes
        ? async () =>
            !(await provider.sandboxes.list()).some(
              (l) => l.providerSandboxId === (row.providerId ?? row.id),
            )
        : undefined
      : async () => (await findSnapshot(provider, row, snapshotIds)) === null;
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
