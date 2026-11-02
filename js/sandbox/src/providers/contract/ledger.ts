/**
 * An append-only record of every resource the contract suite creates, and
 * what happened when the suite tried to delete it.
 *
 * Each event is one JSON line, written the moment it happens. The file is
 * never rewritten, so a run that is killed still leaves every `created` line
 * on disk. A `created` line with no matching `deleted` line is a leak.
 *
 * Deleting is not trusted on its own: when the provider can be asked, the
 * ledger polls until the resource is really gone and records that. A resource
 * that is still there after the wait is recorded as `delete_failed`, the same
 * as a delete call that threw.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

/**
 * What the suite creates. `ssh-access` is a minted SSH credential; on some
 * providers it is a separate identity that outlives the sandbox, so it is
 * revoked and audited like any other resource. Its token is a secret and is
 * never written to the ledger.
 */
export type ResourceKind = "sandbox" | "snapshot" | "ssh-access";

export type LedgerEvent =
  | {
      /**
       * The run's header: which account and endpoint it ran against (see
       * `targetIdentity`). Written once, before anything is created. The
       * sweep refuses a ledger whose header does not match its own target.
       */
      event: "run";
      provider: string;
      target: Record<string, string>;
      at: string;
    }
  | {
      event: "created";
      kind: ResourceKind;
      provider: string;
      id: string;
      name: string;
      /** The test that created it, for the audit summary. */
      test: string;
      at: string;
    }
  | {
      /**
       * The provider's own id for a resource recorded before it had one. A
       * sandbox or snapshot is recorded by name before create/capture can
       * reach the vendor; its provider id follows once the call returns or
       * cleanup recovers it by name.
       */
      event: "identified";
      kind: ResourceKind;
      id: string;
      providerId: string;
      at: string;
    }
  | {
      event: "deleted";
      kind: ResourceKind;
      id: string;
      /** `true` once the provider confirmed it is gone; `"unsupported"` when it cannot be asked. */
      verified: true | "unsupported";
      /** Set when the sweep, not the run itself, deleted it. */
      swept?: true;
      at: string;
    }
  | {
      event: "delete_failed";
      kind: ResourceKind;
      id: string;
      error: string;
      swept?: true;
      at: string;
    };

/** The line that records a resource exists. */
export type CreatedEvent = Extract<LedgerEvent, { event: "created" }>;

/** The two ways a tracked resource ends up. */
export type OutcomeEvent = Extract<
  LedgerEvent,
  { event: "deleted" | "delete_failed" }
>;

/** One resource the suite created and must delete. */
export interface TrackedResource {
  kind: ResourceKind;
  id: string;
  name: string;
  test: string;
  delete(): Promise<void>;
  /**
   * Resolve `true` when the provider no longer reports the resource, `false`
   * when it still does after waiting. Leave unset when the provider has no
   * way to check (no listing).
   */
  verifyGone?(): Promise<boolean>;
}

/** Where ledger lines go. */
export type LedgerSink = (line: string) => void;

export class Ledger {
  /** Every event so far, oldest first. */
  readonly events: LedgerEvent[] = [];
  private readonly pending: TrackedResource[] = [];

  constructor(
    private readonly provider: string,
    private readonly sink: LedgerSink,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Record that `resource` exists. Call right after the provider returns its
   * id. The resource is pending before the line is written, so it is deleted
   * after the test even if writing the line throws.
   */
  track(resource: TrackedResource): void {
    this.pending.push(resource);
    this.write({
      event: "created",
      kind: resource.kind,
      provider: this.provider,
      id: resource.id,
      name: resource.name,
      test: resource.test,
      at: this.now().toISOString(),
    });
  }

  /** Write the run header. Call once, before the first `track`. */
  begin(target: Record<string, string>): void {
    this.write({
      event: "run",
      provider: this.provider,
      target,
      at: this.now().toISOString(),
    });
  }

  /** Record the provider's own id for a resource tracked before it had one. */
  identify(kind: ResourceKind, id: string, providerId: string): void {
    this.write({
      event: "identified",
      kind,
      id,
      providerId,
      at: this.now().toISOString(),
    });
  }

  /**
   * Delete everything tracked since the last release, newest first, and
   * record each outcome. A failed delete is an event, not an error, so it
   * never stops the others.
   *
   * A resource leaves the pending list only once its outcome is on disk. If
   * writing an outcome fails, the rest are still deleted, the unrecorded ones
   * stay pending (a later release deletes them again; deletes are idempotent),
   * and the write errors are thrown together at the end.
   */
  async release(): Promise<void> {
    const writeErrors: unknown[] = [];
    for (const resource of [...this.pending].reverse()) {
      const outcome = await this.deleteAndVerify(resource);
      try {
        this.write(outcome);
      } catch (error) {
        writeErrors.push(error);
        continue;
      }
      this.pending.splice(this.pending.indexOf(resource), 1);
    }
    if (writeErrors.length > 0) {
      throw new AggregateError(
        writeErrors,
        `could not record ${writeErrors.length} cleanup outcome(s) in the audit ledger`,
      );
    }
  }

  /**
   * Delete one resource an earlier run left behind and record the outcome,
   * marked as swept. The resource's `created` line is already in the file.
   */
  async sweep(resource: TrackedResource): Promise<OutcomeEvent> {
    const outcome = {
      ...(await this.deleteAndVerify(resource)),
      swept: true as const,
    };
    this.write(outcome);
    return outcome;
  }

  /** Resources with a `created` event and no outcome yet. */
  get leaked(): CreatedEvent[] {
    const settled = new Set(
      this.events
        .filter((e) => e.event === "deleted" || e.event === "delete_failed")
        .map((e) => `${e.kind}:${e.id}`),
    );
    return this.events.filter(
      (e): e is CreatedEvent =>
        e.event === "created" && !settled.has(`${e.kind}:${e.id}`),
    );
  }

  private async deleteAndVerify(
    resource: TrackedResource,
  ): Promise<OutcomeEvent> {
    const { kind, id } = resource;
    const at = () => this.now().toISOString();
    try {
      await resource.delete();
    } catch (error) {
      return {
        event: "delete_failed",
        kind,
        id,
        error: message(error),
        at: at(),
      };
    }
    if (!resource.verifyGone) {
      return { event: "deleted", kind, id, verified: "unsupported", at: at() };
    }
    let gone: boolean;
    try {
      gone = await resource.verifyGone();
    } catch (error) {
      return {
        event: "delete_failed",
        kind,
        id,
        error: `could not confirm deletion: ${message(error)}`,
        at: at(),
      };
    }
    if (!gone) {
      return {
        event: "delete_failed",
        kind,
        id,
        error: "delete returned but the provider still reports the resource",
        at: at(),
      };
    }
    return { event: "deleted", kind, id, verified: true, at: at() };
  }

  /** Write to the sink first, so `events` holds only what is on disk. */
  private write(event: LedgerEvent): void {
    this.sink(JSON.stringify(event));
    this.events.push(event);
  }
}

/** A sink that appends each line to `file`, creating its directory. */
export function fileSink(file: string): LedgerSink {
  mkdirSync(path.dirname(file), { recursive: true });
  return (line) => appendFileSync(file, `${line}\n`);
}

/**
 * Parse a ledger file's contents back into events. Blank lines are skipped.
 * Any other line that is not a JSON object with an `event` field throws, so
 * a truncated or corrupt ledger is reported, never read as "nothing leaked".
 */
export function parseLedger(contents: string): LedgerEvent[] {
  const events: LedgerEvent[] = [];
  contents.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `audit ledger line ${index + 1} is not valid JSON: ${message(error)}`,
      );
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { event?: unknown }).event !== "string"
    ) {
      throw new Error(`audit ledger line ${index + 1} has no "event" field`);
    }
    events.push(parsed as LedgerEvent);
  });
  return events;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
