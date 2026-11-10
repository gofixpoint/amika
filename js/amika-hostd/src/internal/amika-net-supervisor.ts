/**
 * The `amika-net host` hostd runs beside the tunnel in `tunnel_iroh` mode:
 * hostd's own child, restarted with a backoff when it exits, stopped when
 * the org no longer allows the mode or the daemon stops.
 *
 * The host's iroh key reaches the child on file descriptor 3, as 32 raw
 * bytes, and that end is then closed (`--key-fd 3`). The key never goes in
 * the child's arguments or environment, which other users can read.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { accessSync, closeSync, constants } from "node:fs";
import path from "node:path";
import type { Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { openLogFile, type Spawn } from "./daemon.js";

/** The binary's name, next to hostd or on `PATH`. */
export const AMIKA_NET_BINARY = "amika-net";

/**
 * Where `amika-net` is: in the directory of the hostd script that is
 * running (`selfDir`), else on `PATH`. Undefined when neither has it.
 */
export function findAmikaNet(
  env: NodeJS.ProcessEnv,
  selfDir: string | undefined,
): string | undefined {
  const dirs = [
    ...(selfDir === undefined ? [] : [selfDir]),
    ...(env.PATH ?? "").split(path.delimiter).filter(Boolean),
  ];
  for (const dir of dirs) {
    const candidate = path.join(dir, AMIKA_NET_BINARY);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return undefined;
}

/** The arguments of `amika-net host`, as `iroh-contracts.md` fixes them. */
export function amikaNetArgs(
  socketPath: string,
  relayUrl: string | undefined,
): string[] {
  return [
    "host",
    "--control-socket",
    socketPath,
    "--key-fd",
    "3",
    ...(relayUrl === undefined ? [] : ["--relay-url", relayUrl]),
  ];
}

export interface AmikaNetSupervisor {
  /** Start the child, and restart it when it exits, until `stop`. */
  start(): void;
  /** Stop it, and stop restarting it. */
  stop(): Promise<void>;
  /** Whether hostd wants it running (an exited child is being restarted). */
  readonly wanted: boolean;
}

export interface AmikaNetSupervisorOptions {
  /** The `amika-net` binary, by path: never run through a shell. */
  binary: string;
  args: readonly string[];
  /** The host's iroh key: the 32-byte seed. */
  key: Uint8Array;
  /** The child's environment, without hostd's keys. */
  env: NodeJS.ProcessEnv;
  /** Where its output is appended. */
  logFile: string;
  /** The first restart's delay, doubled per exit up to `maxRestartDelayMs`. */
  restartDelayMs?: number;
  maxRestartDelayMs?: number;
  /** A child that ran this long exited once, not repeatedly. */
  stableMs?: number;
  /** How long `stop` waits for `SIGTERM` before `SIGKILL`. */
  stopTimeoutMs?: number;
  out?: (line: string) => void;
  err?: (line: string) => void;
  spawn?: Spawn;
}

export function amikaNetSupervisor({
  binary,
  args,
  key,
  env,
  logFile,
  restartDelayMs = 1_000,
  maxRestartDelayMs = 30_000,
  stableMs = 60_000,
  stopTimeoutMs = 5_000,
  out = () => {},
  err = () => {},
  spawn = nodeSpawn,
}: AmikaNetSupervisorOptions): AmikaNetSupervisor {
  let child: ChildProcess | undefined;
  let wanted = false;
  let restartTimer: NodeJS.Timeout | undefined;
  let exits = 0;

  return {
    get wanted() {
      return wanted;
    },
    start() {
      if (wanted) return;
      wanted = true;
      exits = 0;
      launch();
    },
    async stop() {
      wanted = false;
      await stopChild();
    },
  };

  /** Spawn the child, hand it the key, and restart it when it exits. */
  function launch(): void {
    let log: number;
    try {
      log = openLogFile(logFile);
    } catch (error) {
      err(`amika-hostd: cannot open ${logFile}: ${describe(error)}`);
      scheduleRestart(Date.now());
      return;
    }
    let spawned: ChildProcess;
    try {
      spawned = spawn(binary, args, {
        env,
        stdio: ["ignore", log, log, "pipe"],
      });
    } finally {
      closeSync(log);
    }
    const startedAt = Date.now();
    child = spawned;
    handKey(spawned.stdio[3] as Writable | null | undefined);
    out(`amika-hostd: started amika-net (pid ${spawned.pid ?? "unknown"})`);
    // A spawn failure (no such binary) arrives as `error`, then `close`.
    spawned.on("error", (error) => {
      err(`amika-hostd: amika-net failed: ${describe(error)}`);
    });
    spawned.on("close", (code, signal) => {
      if (child !== spawned) return;
      child = undefined;
      if (!wanted) return;
      err(
        `amika-hostd: amika-net exited (${signal ?? `code ${code}`}); see ${logFile}`,
      );
      scheduleRestart(startedAt);
    });
  }

  /** Write the 32 key bytes to the child's fd 3, then close our end. */
  function handKey(pipe: Writable | null | undefined): void {
    if (!pipe) return;
    // The child may exit before it reads; its exit is reported, not this.
    pipe.on("error", () => {});
    pipe.end(Buffer.from(key));
  }

  function scheduleRestart(startedAt: number): void {
    exits = Date.now() - startedAt >= stableMs ? 1 : exits + 1;
    const delay = Math.min(
      restartDelayMs * 2 ** (exits - 1),
      maxRestartDelayMs,
    );
    err(`amika-hostd: restarting amika-net in ${delay / 1000}s`);
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      if (wanted && child === undefined) launch();
    }, delay);
    restartTimer.unref();
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
