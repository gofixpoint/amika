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

export type ResourceKind = "sandbox" | "snapshot";

export type LedgerEvent =
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
      event: "deleted";
      kind: ResourceKind;
      id: string;
      /** `true` once the provider confirmed it is gone; `"unsupported"` when it cannot be asked. */
      verified: true | "unsupported";
      at: string;
    }
  | {
      event: "delete_failed";
      kind: ResourceKind;
      id: string;
      error: string;
      at: string;
    };

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

  /** Record that `resource` exists. Call right after the provider returns its id. */
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

  /**
   * Delete everything tracked since the last release, newest first, and
   * record each outcome. Never throws: a failed delete is an event, not an
   * error, so one failure does not stop the others.
   */
  async release(): Promise<void> {
    for (const resource of this.pending.splice(0).reverse()) {
      const outcome = await this.deleteAndVerify(resource);
      this.write(outcome);
    }
  }

  /** Resources with a `created` event and no outcome yet. */
  get leaked(): LedgerEvent[] {
    const settled = new Set(
      this.events
        .filter((e) => e.event !== "created")
        .map((e) => `${e.kind}:${e.id}`),
    );
    return this.events.filter(
      (e) => e.event === "created" && !settled.has(`${e.kind}:${e.id}`),
    );
  }

  private async deleteAndVerify(
    resource: TrackedResource,
  ): Promise<LedgerEvent> {
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

  private write(event: LedgerEvent): void {
    this.events.push(event);
    this.sink(JSON.stringify(event));
  }
}

/** A sink that appends each line to `file`, creating its directory. */
export function fileSink(file: string): LedgerSink {
  mkdirSync(path.dirname(file), { recursive: true });
  return (line) => appendFileSync(file, `${line}\n`);
}

/** Parse a ledger file's contents back into events. Blank lines are skipped. */
export function parseLedger(contents: string): LedgerEvent[] {
  return contents
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as LedgerEvent);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
