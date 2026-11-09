/**
 * The iroh rules this host holds, and how it keeps them current (spec 035,
 * `iroh-contracts.md`, "The rules record" and "Rules delivery").
 *
 * - hostd asks the control plane for a newer version after it registers,
 *   and then every 60 s while `amika-net` runs.
 * - Each record is verified (`verifyRules`) before hostd reads it: a
 *   trusted signature on the exact payload bytes, a format and features
 *   this host knows, this host's org, and a higher version.
 * - The newest accepted record is kept on disk (mode 0600) and verified
 *   again when the daemon starts.
 * - A refused record leaves the old rules in place. The refusal is logged,
 *   and reported in the next `amika_net` report (`rules_refusal`) until a
 *   record is accepted.
 * - When new rules drop a device or a service, `amika-net` is told to
 *   close its connections at once (`revoke`).
 *
 * The signer and version of each accepted record are logged, for audit.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  AMIKA_SIGNER_KIND,
  SUPPORTED_FEATURES,
  SUPPORTED_FORMATS,
  verifyRules,
  type RulesPayload,
  type VerifyRefusal,
  type VerifyResult,
} from "@amika/iroh-rules";
import type { IrohRulesAnswer } from "./amika-api.js";
import { writePrivateFile } from "./private-file.js";

/** How often hostd asks for newer rules while `amika-net` runs. */
export const RULES_FETCH_INTERVAL_MS = 60_000;

/**
 * Amika's rules public keys (64 lowercase hex), for each API environment.
 * A list can hold more than one key, for rotation.
 *
 * Empty for now: a human makes the staging and prod key pairs and adds each
 * public key here. Until then a host accepts no rules unless the config
 * key `iroh_rules_trusted_keys` names the keys, which is for tests and
 * local development only.
 */
export const BUILT_IN_TRUSTED_KEYS: Readonly<
  Record<string, readonly string[]>
> = {
  "https://app.amika.dev": [],
  "https://app.staging-amika.dev": [],
};

/** The keys a host on `apiUrl` trusts: the configured list, else built in. */
export function trustedRulesKeys(
  apiUrl: string,
  configured: readonly string[] | undefined,
): readonly string[] {
  return configured ?? BUILT_IN_TRUSTED_KEYS[apiUrl] ?? [];
}

export interface RulesSyncOptions {
  /** Where the newest accepted envelope is kept. */
  file: string;
  /** This host's org. Rules for another org are refused. */
  orgId: string;
  trustedKeys: readonly string[];
  /** Ask the control plane for rules newer than `have`. */
  fetchRules: (have: number | null) => Promise<IrohRulesAnswer>;
  /** Close every connection from these endpoints (`revoke`). */
  revoke: (endpointIds: string[]) => void;
  /**
   * What each answer says about the org: `false` for a `404` (the org does
   * not allow `tunnel_iroh`), `true` for any other answer. The loop goes
   * on either way, so it sees the org allow the mode again.
   */
  orgAllows?: (allowed: boolean) => void;
  /** The refusal to report changed: a new one, or null once one is accepted. */
  refusalChanged?: (refusal: RulesRefusal | null) => void;
  out: (line: string) => void;
  err: (line: string) => void;
  intervalMs?: number;
}

/** A refused record, as the `amika_net` report's `rules_refusal` says it. */
export interface RulesRefusal {
  reason: VerifyRefusal;
  /** The refused record's version, or null when it could not be read. */
  version: number | null;
  /** When hostd refused it, in milliseconds since the Unix epoch. */
  at: number;
}

/** What one round of `sync` did. */
export type SyncOutcome =
  | "accepted"
  | "unchanged"
  | "refused"
  | "not_allowed"
  | "failed";

export interface RulesSync {
  /** The rules held now, or null before any were accepted. */
  rules(): RulesPayload | null;
  /** The last refusal, until a record is accepted. */
  refusal(): RulesRefusal | null;
  /** Read and verify the rules kept on disk. */
  load(): Promise<void>;
  /** Ask once for newer rules, and apply them. */
  sync(): Promise<SyncOutcome>;
  /** Sync now, and then every `intervalMs`, until `stop`. */
  start(): void;
  stop(): void;
}

export function rulesSync(options: RulesSyncOptions): RulesSync {
  const intervalMs = options.intervalMs ?? RULES_FETCH_INTERVAL_MS;
  let current: RulesPayload | null = null;
  let refusal: RulesRefusal | null = null;
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let inFlight: Promise<SyncOutcome> | undefined;

  const sync = (): Promise<SyncOutcome> => {
    // One round at a time: a slow answer never overlaps the next tick.
    inFlight ??= syncOnce().finally(() => (inFlight = undefined));
    return inFlight;
  };

  return {
    rules: () => current,
    refusal: () => refusal,
    async load() {
      let envelope: unknown;
      try {
        envelope = JSON.parse(readFileSync(options.file, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        options.err(
          `amika-hostd: cannot read the stored iroh rules; waiting for new ones`,
        );
        return;
      }
      const result = await verify(envelope, null);
      if (!result.ok) {
        options.err(
          `amika-hostd: ignoring the stored iroh rules (${result.reason}: ${result.detail})`,
        );
        return;
      }
      current = result.rules;
      options.out(
        `amika-hostd: loaded iroh rules version ${result.rules.version}, signed by ${signerText(result)}`,
      );
    },
    sync,
    start() {
      if (running) return;
      running = true;
      const tick = () => {
        void sync().then((outcome) => {
          if (!running) return;
          if (outcome !== "failed") {
            options.orgAllows?.(outcome !== "not_allowed");
          }
          timer = setTimeout(tick, intervalMs);
          timer.unref();
        });
      };
      tick();
    },
    stop() {
      running = false;
      clearTimeout(timer);
      timer = undefined;
    },
  };

  async function syncOnce(): Promise<SyncOutcome> {
    const have = current?.version ?? null;
    let answer: IrohRulesAnswer;
    try {
      answer = await options.fetchRules(have);
    } catch (error) {
      options.err(
        `amika-hostd: cannot fetch iroh rules: ${error instanceof Error ? error.message : String(error)}`,
      );
      return "failed";
    }
    switch (answer.kind) {
      case "unchanged":
        return "unchanged";
      case "not_allowed":
        return "not_allowed";
      case "rules":
        return apply(answer.envelope);
      default:
        return assertNever(answer);
    }
  }

  async function apply(envelope: unknown): Promise<SyncOutcome> {
    const before = current;
    const result = await verify(envelope, before?.version ?? null);
    if (!result.ok) {
      options.err(
        `amika-hostd: refused iroh rules (${result.reason}: ${result.detail}); keeping ${before === null ? "no rules" : `version ${before.version}`}`,
      );
      const version = readableVersion(envelope);
      // The same record refused again is the same refusal, with its time.
      if (refusal?.reason !== result.reason || refusal.version !== version) {
        refusal = { reason: result.reason, version, at: Date.now() };
        options.refusalChanged?.(refusal);
      }
      return "refused";
    }
    try {
      writePrivateFile(options.file, `${JSON.stringify(envelope)}\n`);
    } catch (error) {
      // Applied anyway: the next start fetches them again.
      options.err(
        `amika-hostd: cannot keep the iroh rules in ${options.file}: ${(error as NodeJS.ErrnoException).code ?? "unknown error"}`,
      );
    }
    current = result.rules;
    if (refusal !== null) {
      refusal = null;
      options.refusalChanged?.(null);
    }
    options.out(
      `amika-hostd: accepted iroh rules version ${result.rules.version}, signed by ${signerText(result)}`,
    );
    const dropped = droppedEndpoints(before, result.rules);
    if (dropped.length > 0) {
      options.out(
        `amika-hostd: closing the connections of ${dropped.length} endpoint${dropped.length === 1 ? "" : "s"} the new rules dropped`,
      );
      options.revoke(dropped);
    }
    return "accepted";
  }

  function verify(
    envelope: unknown,
    haveVersion: number | null,
  ): Promise<VerifyResult> {
    return verifyRules(envelope, {
      trustedKeys: options.trustedKeys,
      trustedKinds: [AMIKA_SIGNER_KIND],
      orgId: options.orgId,
      haveVersion,
      knownFormats: SUPPORTED_FORMATS,
      knownFeatures: SUPPORTED_FEATURES,
    });
  }
}

/**
 * The `version` of a refused envelope's payload, read without trusting it,
 * or null when it cannot be read. Only for the report.
 */
function readableVersion(envelope: unknown): number | null {
  const outer = z.object({ payload: z.string() }).safeParse(envelope);
  if (!outer.success) return null;
  let json: unknown;
  try {
    json = JSON.parse(
      Buffer.from(outer.data.payload, "base64url").toString("utf8"),
    );
  } catch {
    return null;
  }
  const inner = z
    .object({ version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) })
    .safeParse(json);
  return inner.success ? inner.data.version : null;
}

/** The devices and services in `before` that `after` leaves out. */
export function droppedEndpoints(
  before: RulesPayload | null,
  after: RulesPayload,
): string[] {
  if (before === null) return [];
  const kept = new Set(endpointsOf(after));
  return [...new Set(endpointsOf(before))].filter((id) => !kept.has(id));
}

function endpointsOf(rules: RulesPayload): string[] {
  return [
    ...rules.devices.map((d) => d.endpoint_id),
    ...rules.services.map((s) => s.endpoint_id),
  ];
}

/** Who signed an accepted record: its kind and public key. */
function signerText(result: Extract<VerifyResult, { ok: true }>): string {
  return `${result.signer.kind} key ${result.signer.key_id}`;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
}
