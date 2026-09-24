/** Run the daemon as a detached background process and track it by pidfile. */
import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

/**
 * Set as `process.title`, so a pidfile naming a reused pid is recognized as
 * stale rather than blocking startup.
 */
export const PROCESS_TITLE = "amika-hostd";

export interface DaemonPaths {
  pidFile: string;
  logFile: string;
}

export type Spawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface BackgroundDeps {
  spawn?: Spawn;
  isRunning?: (pid: number) => boolean;
  startupTimeoutMs?: number;
}

/**
 * Spawn `argv` detached, logging to the log file, and wait for it to report
 * that it is listening. Startup failures surface here, in the caller's
 * terminal, instead of only in the log.
 */
export async function startInBackground(
  argv: readonly [string, ...string[]],
  paths: DaemonPaths,
  {
    spawn = nodeSpawn,
    isRunning = isProcessRunning,
    startupTimeoutMs = 30_000,
  }: BackgroundDeps = {},
): Promise<{ pid: number; port: number }> {
  const running = readRunningPid(paths.pidFile, isRunning);
  if (running !== undefined) throw alreadyRunning(running, paths.pidFile);
  mkdirSync(path.dirname(paths.logFile), { recursive: true, mode: 0o700 });
  const log = openSync(paths.logFile, "a", 0o600);
  let child: ChildProcess;
  try {
    const [command, ...args] = argv;
    child = spawn(command, args, {
      detached: true,
      stdio: ["ignore", log, log, "ipc"],
    });
  } finally {
    closeSync(log);
  }
  const port = await waitForReady(child, startupTimeoutMs, paths.logFile);
  child.disconnect?.();
  child.unref();
  return { pid: child.pid as number, port };
}

/**
 * Called by the background process once it is serving. Rejects if the
 * launching `up` went away first (e.g. Ctrl-C), so the daemon can shut down
 * cleanly instead of crashing on a broken IPC channel.
 */
export function notifyReady(port: number): Promise<void> {
  const send = process.send?.bind(process);
  if (!send) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const abandoned = () =>
      reject(
        new DaemonError(
          "the launching `amika-hostd up` exited before startup finished",
        ),
      );
    if (!process.connected) return abandoned();
    send({ type: "ready", port } satisfies ReadyMessage, (error) => {
      if (error) return abandoned();
      process.disconnect?.();
      resolve();
    });
  });
}

/**
 * Record this process in the pidfile unless another live daemon holds it.
 * Returns a cleanup to run on shutdown.
 *
 * The pidfile is created atomically (a complete temp file hard-linked into
 * place, which fails if the pidfile exists), so two daemons starting at once
 * cannot both claim it. A stale pidfile is removed and the claim retried once.
 */
export function claimPidFile(
  pidFile: string,
  isRunning: (pid: number) => boolean = isProcessRunning,
): () => void {
  mkdirSync(path.dirname(pidFile), { recursive: true, mode: 0o700 });
  for (let attempt = 0; ; attempt++) {
    if (createPidFile(pidFile)) break;
    const holder = readPid(pidFile);
    if (holder === process.pid) break;
    if (holder !== undefined && isRunning(holder)) {
      throw alreadyRunning(holder, pidFile);
    }
    if (attempt > 0) {
      throw new DaemonError(
        `cannot claim ${pidFile}; another daemon is starting`,
      );
    }
    // Only remove what we judged stale, not a pidfile claimed meanwhile.
    if (readPid(pidFile) === holder) rmSync(pidFile, { force: true });
  }
  return () => {
    // Only remove the file if a newer daemon has not replaced it.
    if (readPid(pidFile) === process.pid) rmSync(pidFile, { force: true });
  };
}

export function daemonPaths(env: NodeJS.ProcessEnv = {}): DaemonPaths {
  const stateHome = env.XDG_STATE_HOME || path.join(homedir(), ".local/state");
  const dir = path.join(stateHome, "amika-hostd");
  return {
    pidFile: path.join(dir, "amika-hostd.pid"),
    logFile: path.join(dir, "amika-hostd.log"),
  };
}

/** A background start failure; the message is safe to print. */
export class DaemonError extends Error {
  override name = "DaemonError";
}

const readyMessageSchema = z.object({
  type: z.literal("ready"),
  port: z.number().int(),
});
type ReadyMessage = z.infer<typeof readyMessageSchema>;

function waitForReady(
  child: ChildProcess,
  timeoutMs: number,
  logFile: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const fail = (reason: string) => {
      cleanup();
      reject(new DaemonError(`amika-hostd ${reason}; see ${logFile}`));
    };
    const onMessage = (message: unknown) => {
      const ready = readyMessageSchema.safeParse(message);
      if (!ready.success) return;
      cleanup();
      resolve(ready.data.port);
    };
    const onExit = (code: number | null, signal: string | null) =>
      fail(`exited during startup (${signal ?? `code ${code}`})`);
    const onError = () => fail("could not be started");
    const timer = setTimeout(() => {
      child.kill();
      fail(`did not start within ${timeoutMs / 1000}s`);
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
    }
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

/** Link a fully written temp file into place; false if the pidfile exists. */
function createPidFile(pidFile: string): boolean {
  const temp = `${pidFile}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${process.pid}\n`, { mode: 0o600 });
    linkSync(temp, pidFile);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    // e.g. EACCES, or a filesystem without hard links (EPERM, ENOTSUP).
    throw new DaemonError(
      `cannot create ${pidFile}: ${code ?? "unknown error"}`,
    );
  } finally {
    rmSync(temp, { force: true });
  }
}

function alreadyRunning(pid: number, pidFile: string): DaemonError {
  return new DaemonError(
    `amika-hostd is already running (pid ${pid}); if it is not, remove ${pidFile}`,
  );
}

function readRunningPid(
  pidFile: string,
  isRunning: (pid: number) => boolean,
): number | undefined {
  const pid = readPid(pidFile);
  return pid !== undefined && isRunning(pid) ? pid : undefined;
}

function readPid(pidFile: string): number | undefined {
  let contents: string;
  try {
    contents = readFileSync(pidFile, "utf8");
  } catch {
    return undefined;
  }
  const pid = Number(contents.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Whether `pid` is a live amika-hostd. Pids are reused (the pidfile survives
 * reboots), so where `/proc` exists the process must carry `PROCESS_TITLE`;
 * elsewhere any live process counts, and the error says how to recover.
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  let cmdline: string;
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return true;
  }
  return cmdline.split("\0")[0] === PROCESS_TITLE;
}
