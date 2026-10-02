/** Run the daemon as a detached background process and track it by pidfile. */
import {
  execFileSync,
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
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";

/**
 * Set as `process.title`, so a pidfile naming a reused pid is recognized as
 * stale rather than blocking startup.
 */
export const PROCESS_TITLE = "amika-hostd";

export interface DaemonPaths {
  pidFile: string;
  logFile: string;
  /** The `smolvm serve` process the daemon started, while it runs. */
  smolvmPidFile: string;
  /** The URL that smolvm serves at, written next to its pidfile. */
  smolvmUrlFile: string;
  smolvmLogFile: string;
  /** Each machine's service names and guest ports (`service-registry.ts`). */
  servicesFile: string;
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
  /** The child's environment; defaults to this process's. */
  env?: NodeJS.ProcessEnv;
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
    isRunning = isDaemonRunning,
    // Startup includes waiting for smolvm to serve.
    startupTimeoutMs = 60_000,
    env = process.env,
  }: BackgroundDeps = {},
): Promise<{ pid: number; port: number }> {
  ensureNotRunning(paths.pidFile, isRunning);
  const log = openLogFile(paths.logFile);
  let child: ChildProcess;
  try {
    const [command, ...args] = argv;
    child = spawn(command, args, {
      detached: true,
      stdio: ["ignore", log, log, "ipc"],
      env,
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
  isRunning: (pid: number) => boolean = isDaemonRunning,
): () => void {
  onDisk(pidFile, () =>
    mkdirSync(path.dirname(pidFile), { recursive: true, mode: 0o700 }),
  );
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
    removePidFile(pidFile, process.pid);
  };
}

/** Fail if the pidfile names a live process other than this one. */
export function ensureNotRunning(
  pidFile: string,
  isRunning: (pid: number) => boolean = isDaemonRunning,
): void {
  const running = readRunningPid(pidFile, isRunning);
  if (running !== undefined && running !== process.pid) {
    throw alreadyRunning(running, pidFile);
  }
}

/** The live process a pidfile names, if any. */
export function readRunningPid(
  pidFile: string,
  isRunning: (pid: number) => boolean = isDaemonRunning,
): number | undefined {
  const pid = readPid(pidFile);
  return pid !== undefined && isRunning(pid) ? pid : undefined;
}

/** Remove the pidfile, unless it has since been claimed by another pid. */
export function removePidFile(pidFile: string, pid: number): void {
  if (readPid(pidFile) === pid) rmSync(pidFile, { force: true });
}

/** Remove smolvm's pidfile and the URL beside it, if they are `pid`'s. */
export function removeSmolvmFiles(paths: DaemonPaths, pid: number): void {
  if (readPid(paths.smolvmPidFile) !== pid) return;
  try {
    rmSync(paths.smolvmUrlFile, { force: true });
  } catch {
    // Only informational; the pidfile is what `up` and `down` act on.
  }
  rmSync(paths.smolvmPidFile, { force: true });
}

/**
 * Send `SIGTERM` and wait for the process to exit. Resolves false if it is
 * still running after `timeoutMs`; it is never killed outright, since smolvm
 * may still be stopping its machines.
 */
export async function stopProcess(
  pid: number,
  isRunning: (pid: number) => boolean,
  { timeoutMs, pollMs = 100 }: { timeoutMs: number; pollMs?: number },
): Promise<boolean> {
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw new DaemonError(
      `cannot stop pid ${pid}: ${(error as NodeJS.ErrnoException).code ?? "unknown error"}`,
    );
  }
  const deadline = Date.now() + timeoutMs;
  while (isRunning(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(pollMs);
  }
  return true;
}

export function daemonPaths(env: NodeJS.ProcessEnv = {}): DaemonPaths {
  const stateHome = env.XDG_STATE_HOME || path.join(homedir(), ".local/state");
  const dir = path.join(stateHome, "amika-hostd");
  return {
    pidFile: path.join(dir, "amika-hostd.pid"),
    logFile: path.join(dir, "amika-hostd.log"),
    smolvmPidFile: path.join(dir, "smolvm.pid"),
    smolvmUrlFile: path.join(dir, "smolvm.url"),
    smolvmLogFile: path.join(dir, "smolvm.log"),
    servicesFile: path.join(dir, "services.json"),
  };
}

/** Open `file` for appending, creating it and its directory privately. */
export function openLogFile(file: string): number {
  return onDisk(file, () => {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    return openSync(file, "a", 0o600);
  });
}

/**
 * Whether `pid` is a live amika-hostd. Pids are reused (the pidfile survives
 * reboots), so where `/proc` exists the process must carry `PROCESS_TITLE`;
 * elsewhere any live process counts, and the error says how to recover.
 */
export function isDaemonRunning(pid: number): boolean {
  if (!isAlive(pid)) return false;
  let cmdline: string;
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return true;
  }
  return cmdline.split("\0")[0] === PROCESS_TITLE;
}

/**
 * Whether `pid` is confirmed to be a live amika-hostd. `down` signals it, so
 * unlike `isDaemonRunning` a process that cannot be confirmed never counts;
 * without `/proc`, `ps` shows the title the daemon set.
 */
export function isDaemonProcess(pid: number): boolean {
  return isAlive(pid) && programOf(pid, "command") === PROCESS_TITLE;
}

/**
 * Whether `pid` is a live smolvm. `down` signals it, so, as with
 * `isDaemonProcess`, a pid whose program cannot be confirmed as smolvm never
 * counts.
 */
export function isSmolvmRunning(pid: number): boolean {
  if (!isAlive(pid)) return false;
  const program = programOf(pid, "comm");
  return (
    program !== undefined && SMOLVM_PROGRAMS.includes(path.basename(program))
  );
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

/**
 * Run a step that creates `file` or its directory, reporting a failure (e.g.
 * `ENOTDIR` when `XDG_STATE_HOME` is a file, or `EACCES`) as a printable
 * `DaemonError` rather than a stack trace.
 */
function onDisk<T>(file: string, step: () => T): T {
  try {
    return step();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new DaemonError(`cannot create ${file}: ${code ?? "unknown error"}`);
  }
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

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The smolvm launcher `exec`s `smolvm-bin`, so a running smolvm is either. */
const SMOLVM_PROGRAMS = ["smolvm", "smolvm-bin"];

/**
 * The program `pid` runs, from `/proc` or else `ps`; undefined if unknown.
 * `ps` reports it as `comm` (the executable) or as the first word of
 * `command` (the argv, which `process.title` rewrites).
 */
function programOf(
  pid: number,
  psField: "comm" | "command",
): string | undefined {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0];
  } catch {
    // No /proc (e.g. macOS), or the process just exited.
  }
  try {
    const shown = execFileSync("ps", ["-o", `${psField}=`, "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const program = psField === "command" ? shown.split(/\s+/)[0] : shown;
    return program === "" ? undefined : program;
  } catch {
    return undefined;
  }
}
