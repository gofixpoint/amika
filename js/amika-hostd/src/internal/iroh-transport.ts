/**
 * The iroh transport on a `tunnel_iroh` host (spec 035, track B phase 1):
 * `amika-net host`, the control socket it talks to, the rules hostd checks
 * it against, and the report that tells Amika how to reach it.
 *
 * The daemon starts this only when `up` found the host in `tunnel_iroh`
 * mode and its org allowing the mode. It runs beside the gateway tunnel,
 * which keeps running in every case.
 *
 * It stops `amika-net` when Amika says the org no longer allows the mode:
 * the rules answer `404`, or a report's answer leaves `tunnel_iroh` out.
 * The rules loop goes on, and when an answer shows the org allows the mode
 * again, `amika-net` starts again.
 *
 * What `amika-net` last reported stays on disk when the daemon stops, so
 * the next `up` reports the same endpoint and the control plane never
 * loses it during a restart. It is removed when the org stops allowing the
 * mode.
 */
import { readFileSync, rmSync } from "node:fs";
import { parseEndpointId } from "@amika/iroh-rules";
import { z } from "zod";
import type { IrohRulesAnswer } from "./amika-api.js";
import {
  amikaNetArgs,
  amikaNetSupervisor,
  type AmikaNetSupervisorOptions,
} from "./amika-net-supervisor.js";
import { startControlServer, type ControlServer } from "./amika-net-control.js";
import { irohAccess, type IrohAccessDeps } from "./iroh-access.js";
import { rulesSync, type RulesRefusal } from "./iroh-rules-sync.js";
import { writePrivateFile } from "./private-file.js";
import type { AmikaNetReport } from "./runtimes.js";

export interface IrohTransportOptions {
  /** The host's iroh key: the 32-byte seed `amika-net` serves as. */
  hostKey: Uint8Array;
  /** The `amika-net` binary (`findAmikaNet`). */
  binary: string;
  /** Passed as `--relay-url`, when set. */
  relayUrl?: string;
  orgId: string;
  /** The keys that may sign this host's rules (`trustedRulesKeys`). */
  trustedKeys: readonly string[];
  paths: IrohTransportPaths;
  /** `amika-net`'s environment, without hostd's keys. */
  env: NodeJS.ProcessEnv;
  /** Ask the control plane for rules newer than `have`. */
  fetchRules: (have: number | null) => Promise<IrohRulesAnswer>;
  /**
   * Tell Amika what this host runs, `amika-net` included. Resolves with
   * whether the org still allows `tunnel_iroh`.
   */
  report: (amikaNet: AmikaNetReport) => Promise<{ allowed: boolean }>;
  /** How check 2 reaches rigs and hostd. */
  access: Omit<IrohAccessDeps, "rules">;
  out: (line: string) => void;
  err: (line: string) => void;
  /** For tests: the rules fetch interval and the supervisor's timings. */
  rulesIntervalMs?: number;
  reportRetryMs?: number;
  supervisor?: Pick<
    AmikaNetSupervisorOptions,
    "restartDelayMs" | "maxRestartDelayMs" | "stableMs" | "stopTimeoutMs"
  >;
}

export interface IrohTransportPaths {
  /** The control socket, in a directory hostd makes mode 0700. */
  socketPath: string;
  /** The newest accepted rules envelope. */
  rulesFile: string;
  /** What `amika-net` last reported, for `readAmikaNetState`. */
  stateFile: string;
  /** `amika-net`'s output. */
  logFile: string;
}

export interface IrohTransport {
  /** Stop `amika-net`, the rules loop and the control socket. */
  stop(): Promise<void>;
  /** Whether `amika-net` runs: false while the org does not allow it. */
  readonly active: boolean;
}

export async function startIrohTransport(
  options: IrohTransportOptions,
): Promise<IrohTransport> {
  const { out, err, paths } = options;
  let control: ControlServer | undefined;
  let active = false;
  let stopped = false;
  // One change at a time, in order: a start never races a stop.
  let changing = Promise.resolve();
  const change = (step: () => Promise<void>) => {
    changing = changing.then(step);
    return changing;
  };

  const rules = rulesSync({
    file: paths.rulesFile,
    orgId: options.orgId,
    trustedKeys: options.trustedKeys,
    fetchRules: options.fetchRules,
    revoke: (ids) => control?.revoke(ids),
    orgAllows: (allowed) => void (allowed ? activate() : deactivate()),
    refusalChanged: (refusal) => reporter.refusal(refusal),
    out,
    err,
    intervalMs: options.rulesIntervalMs,
  });
  await rules.load();
  if (options.trustedKeys.length === 0) {
    err(
      "amika-hostd: no keys are trusted to sign iroh rules for this API, so amika-net refuses every connection",
    );
  }
  const access = irohAccess({ ...options.access, rules: rules.rules });
  const reporter = amikaNetReporter(options, () => void deactivate());
  const supervisor = amikaNetSupervisor({
    binary: options.binary,
    args: amikaNetArgs(paths.socketPath, options.relayUrl),
    key: options.hostKey,
    env: options.env,
    logFile: paths.logFile,
    out,
    err,
    ...options.supervisor,
  });
  await activate();
  rules.start();

  function activate(): Promise<void> {
    return change(async () => {
      if (stopped || active) return;
      control = await startControlServer(paths.socketPath, {
        ready: (info) =>
          reporter.update({
            endpoint_id: info.endpointId,
            relay_url: info.relayUrl,
            version: info.version,
          }),
        homeRelay: (relayUrl) => reporter.relay(relayUrl),
        checkPeer: (endpointId) => access.checkPeer(endpointId),
        open: (endpointId, target) => access.open(endpointId, target),
        warn: (line) => err(`amika-hostd: ${line}`),
      });
      reporter.resume();
      supervisor.start();
      active = true;
    });
  }

  function deactivate(): Promise<void> {
    return change(async () => {
      if (stopped || !active) return;
      out(
        "amika-hostd: this host's org no longer allows tunnel_iroh; stopping amika-net. The gateway tunnel keeps running.",
      );
      active = false;
      reporter.pause();
      await supervisor.stop();
      await control?.close();
      control = undefined;
      // Started again once an answer shows the org allows the mode.
      out("amika-hostd: amika-net starts again if the org allows tunnel_iroh");
    });
  }

  return {
    get active() {
      return active;
    },
    stop: () => {
      stopped = true;
      rules.stop();
      reporter.stop();
      return change(async () => {
        active = false;
        await supervisor.stop();
        await control?.close();
        control = undefined;
      });
    },
  };
}

/**
 * Report `amika-net` to Amika when it says it is ready, when its home relay
 * changes and when the rules refusal changes, and again later if a report
 * fails. A report that says the org no longer allows `tunnel_iroh` calls
 * `disallowed`.
 */
function amikaNetReporter(
  options: Pick<
    IrohTransportOptions,
    "report" | "paths" | "out" | "err" | "reportRetryMs"
  >,
  disallowed: () => void,
) {
  const retryMs = options.reportRetryMs ?? 60_000;
  let latest: Omit<AmikaNetReport, "rules_refusal"> | undefined;
  let refusal: RulesRefusal | null = null;
  let reported: string | undefined;
  let retry: NodeJS.Timeout | undefined;
  let stopped = false;
  let paused = false;
  let sending = Promise.resolve();

  const send = () => {
    // One report at a time, in order, so an older one never lands last.
    sending = sending.then(sendLatest);
  };

  return {
    update(next: Omit<AmikaNetReport, "rules_refusal">) {
      if (parseEndpointId(next.endpoint_id) === null) {
        options.err(
          "amika-hostd: amika-net reported an endpoint id that is not 64 hex characters; not reporting it",
        );
        return;
      }
      latest = next;
      send();
    },
    relay(relayUrl: string) {
      if (latest === undefined) return;
      latest = { ...latest, relay_url: relayUrl };
      send();
    },
    refusal(next: RulesRefusal | null) {
      refusal = next;
      send();
    },
    /** `amika-net` stopped for the org: forget it, and remove its state. */
    pause() {
      paused = true;
      reported = undefined;
      clearTimeout(retry);
      rmSync(options.paths.stateFile, { force: true });
    },
    resume() {
      paused = false;
    },
    stop() {
      stopped = true;
      clearTimeout(retry);
    },
  };

  async function sendLatest(): Promise<void> {
    clearTimeout(retry);
    if (stopped || paused || latest === undefined) return;
    const report: AmikaNetReport = {
      ...latest,
      ...(refusal === null ? {} : { rules_refusal: refusal }),
    };
    const key = JSON.stringify(report);
    if (key === reported) return;
    try {
      writePrivateFile(options.paths.stateFile, `${key}\n`);
    } catch {
      // Only for `amika-hostd reload`'s report; the daemon's own goes on.
    }
    let answer: { allowed: boolean };
    try {
      answer = await options.report(report);
    } catch (error) {
      options.err(
        `amika-hostd: cannot report amika-net to Amika; retrying in ${retryMs / 1000}s: ${error instanceof Error ? error.message : String(error)}`,
      );
      retry = setTimeout(send, retryMs);
      retry.unref();
      return;
    }
    reported = key;
    options.out(
      `amika-hostd: reported amika-net ${report.version} as endpoint ${report.endpoint_id}${report.relay_url === null ? "" : ` on relay ${report.relay_url}`}`,
    );
    if (!answer.allowed && !paused) disallowed();
  }
}

/**
 * What the running daemon's `amika-net` last reported, for a report the
 * CLI sends (after `amika-hostd reload`). Undefined when it has none.
 */
export function readAmikaNetState(file: string): AmikaNetReport | undefined {
  let contents: string;
  try {
    contents = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = stateSchema.safeParse(JSON.parse(contents));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

const stateSchema = z.object({
  endpoint_id: z.string().regex(/^[0-9a-f]{64}$/),
  relay_url: z.string().nullable(),
  version: z.string(),
  rules_refusal: z
    .object({
      reason: z.string(),
      version: z.number().int().nullable(),
      at: z.number().int(),
    })
    .optional(),
});
