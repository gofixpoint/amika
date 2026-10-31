/**
 * The `amikad serve` a bare-metal host runs for its one rig: hostd's own
 * child, restarted when it crashes, stopped when the rig stops or the daemon
 * does.
 *
 * amikad's `--bg` would detach a process hostd then could not stop or
 * restart, so hostd runs `amikad serve` in the foreground itself and answers
 * the control plane's `serve --bg` exec once that child is up.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { closeSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { openLogFile, type Spawn } from "./daemon.js";

export interface AmikadSupervisor {
  /**
   * Start `amikad serve`, stopping one already running first. Resolves once
   * it answers `/healthz`, or is still running after `readyTimeoutMs`; or
   * with why it did not start (it exited).
   */
  start(): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Stop it, and stop restarting it. */
  stop(): Promise<void>;
  /** Whether hostd wants it running (a crashed child is being restarted). */
  readonly wanted: boolean;
}

export interface AmikadSupervisorOptions {
  /** The amikad binary, by absolute path: never found through a shell. */
  binary: string;
  args: readonly string[];
  /** Read at each (re)start: the rig's ports are its own. */
  env: () => NodeJS.ProcessEnv;
  cwd: string;
  /** Where its output is appended. */
  logFile: string;
  /** amikad's `/healthz`, on its loopback listener. */
  healthUrl: () => string;
  /** How long `start` waits for `/healthz`; a running child is ok after. */
  readyTimeoutMs?: number;
  /** The first restart's delay, doubled per crash up to `maxRestartDelayMs`. */
  restartDelayMs?: number;
  maxRestartDelayMs?: number;
  /** A child that ran this long crashed once, not repeatedly. */
  stableMs?: number;
  /** How long `stop` waits for `SIGTERM` before `SIGKILL`. */
  stopTimeoutMs?: number;
  err?: (line: string) => void;
  spawn?: Spawn;
  fetch?: typeof fetch;
}

export function amikadSupervisor({
  binary,
  args,
  env,
  cwd,
  logFile,
  healthUrl,
  readyTimeoutMs = 10_000,
  restartDelayMs = 1_000,
  maxRestartDelayMs = 30_000,
  stableMs = 60_000,
  stopTimeoutMs = 5_000,
  err = () => {},
  spawn = nodeSpawn,
  fetch: fetcher = fetch,
}: AmikadSupervisorOptions): AmikadSupervisor {
  let child: ChildProcess | undefined;
  let wanted = false;
  let restartTimer: NodeJS.Timeout | undefined;
  let crashes = 0;

  const supervisor: AmikadSupervisor = {
    get wanted() {
      return wanted;
    },
    async start() {
      await stopChild();
      wanted = true;
      crashes = 0;
      const started = launch();
      if (!started) return { ok: false, reason: "amikad serve did not start" };
      return waitUntilReady(started);
    },
    async stop() {
      wanted = false;
      await stopChild();
    },
  };
  return supervisor;

  /** Spawn the child and supervise it; undefined if it cannot be spawned. */
  function launch(): ChildProcess | undefined {
    let log: number;
    try {
      log = openLogFile(logFile);
    } catch (error) {
      err(`amika-hostd: cannot open ${logFile}: ${describe(error)}`);
      return undefined;
    }
    let spawned: ChildProcess;
    try {
      spawned = spawn(binary, args, {
        cwd,
        env: env(),
        stdio: ["ignore", log, log],
      });
    } finally {
      closeSync(log);
    }
    const startedAt = Date.now();
    child = spawned;
    // A spawn failure (no such binary) arrives as `error`, then `close`.
    spawned.on("error", (error) => {
      err(`amika-hostd: amikad serve failed: ${describe(error)}`);
    });
    spawned.on("close", (code, signal) => {
      if (child !== spawned) return;
      child = undefined;
      if (!wanted) return;
      crashes = Date.now() - startedAt >= stableMs ? 1 : crashes + 1;
      const delay = Math.min(
        restartDelayMs * 2 ** (crashes - 1),
        maxRestartDelayMs,
      );
      err(
        `amika-hostd: amikad serve exited (${signal ?? `code ${code}`}); restarting in ${delay / 1000}s; see ${logFile}`,
      );
      restartTimer = setTimeout(() => {
        restartTimer = undefined;
        if (wanted && child === undefined) launch();
      }, delay);
      restartTimer.unref();
    });
    return spawned;
  }

  async function waitUntilReady(
    started: ChildProcess,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const deadline = Date.now() + readyTimeoutMs;
    for (;;) {
      if (child !== started) {
        // One that cannot even start (a broken binary, a port taken) would
        // only crash again: the control plane's next `serve` retries.
        wanted = false;
        await stopChild();
        return {
          ok: false,
          reason: `amikad serve exited as it started; see ${logFile}`,
        };
      }
      if (await healthy()) return { ok: true };
      if (Date.now() >= deadline) return { ok: true };
      await sleep(100);
    }
  }

  async function healthy(): Promise<boolean> {
    try {
      const response = await fetcher(healthUrl(), {
        redirect: "error",
        signal: AbortSignal.timeout(1_000),
      });
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  }

  async function stopChild(): Promise<void> {
    clearTimeout(restartTimer);
    restartTimer = undefined;
    const running = child;
    child = undefined;
    if (!running || running.exitCode !== null || running.signalCode !== null) {
      return;
    }
    const exited = new Promise<void>((resolve) =>
      running.once("close", () => resolve()),
    );
    running.kill("SIGTERM");
    const stopped = await Promise.race([
      exited.then(() => true),
      sleep(stopTimeoutMs).then(() => false),
    ]);
    if (!stopped) {
      running.kill("SIGKILL");
      await exited;
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
