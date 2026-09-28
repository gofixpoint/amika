/**
 * Start and stop the `smolvm serve` process behind `amika-hostd up`, so the
 * daemon and the runtime it forwards to come and go together.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  DaemonError,
  isSmolvmRunning,
  openLogFile,
  removePidFile,
  readRunningPid,
  type DaemonPaths,
  type Spawn,
} from "./daemon.js";
import { DEFAULT_SMOL_API_URL } from "./smol.js";

export interface ManagedSmolvm {
  pid: number;
  /** Resolves, with why, once smolvm has exited for any reason. */
  exited: Promise<string>;
  /** False once smolvm has exited. */
  readonly running: boolean;
  /**
   * Send `SIGTERM`, which makes smolvm stop its machines before exiting, and
   * wait for it. Resolves false if it is still running after the timeout.
   */
  stop(): Promise<boolean>;
}

export interface SmolvmDeps {
  spawn?: Spawn;
  fetch?: typeof fetch;
  findSmolvm?: (env: NodeJS.ProcessEnv) => string | undefined;
  isSmolvmRunning?: (pid: number) => boolean;
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
  pollMs?: number;
}

/** smolvm stops each machine cleanly on shutdown, which can take a while. */
export const SMOLVM_STOP_TIMEOUT_MS = 60_000;

/**
 * Start `smolvm serve` listening where the daemon expects it (`apiUrl`,
 * i.e. `SMOL_API_URL`), and resolve once it answers `/health`. Fails if
 * anything already answers there: that smolvm is not ours to stop.
 */
export async function startSmolvm(
  apiUrl: string | undefined,
  paths: DaemonPaths,
  env: NodeJS.ProcessEnv,
  {
    spawn = nodeSpawn,
    fetch: fetcher = fetch,
    findSmolvm: find = findSmolvm,
    isSmolvmRunning: isRunning = isSmolvmRunning,
    readyTimeoutMs = 30_000,
    stopTimeoutMs = SMOLVM_STOP_TIMEOUT_MS,
    pollMs = 200,
  }: SmolvmDeps = {},
): Promise<ManagedSmolvm> {
  const { origin, listen } = smolvmListenAddress(apiUrl);
  const leftover = readRunningPid(paths.smolvmPidFile, isRunning);
  if (leftover !== undefined) {
    throw new DaemonError(
      `a smolvm started by an earlier amika-hostd is still running (pid ${leftover}); stop it with \`amika-hostd down\``,
    );
  }
  if ((await probe(origin, fetcher)) !== undefined) {
    throw new DaemonError(
      `something is already listening at ${origin} (SMOL_API_URL); amika-hostd starts its own smolvm there, so stop it first`,
    );
  }
  const binary = find(env);
  if (binary === undefined) {
    throw new DaemonError(
      "smolvm not found on PATH, in ~/.smolvm or in ~/.local/bin; re-run install-amika-hostd.sh to install it",
    );
  }

  const log = openLogFile(paths.smolvmLogFile);
  let child: ChildProcess;
  try {
    child = spawn(binary, ["serve", "start", "--listen", listen], {
      // Its own process group, so Ctrl-C on `up --fg` reaches only the
      // daemon, which then stops smolvm after its own listener.
      detached: true,
      stdio: ["ignore", log, log],
      // Stop running machines on shutdown rather than leave them behind.
      env: { ...env, SMOLVM_DRAIN_ON_SHUTDOWN: "1" },
    });
  } finally {
    closeSync(log);
  }
  const exited = exitOf(child);
  const pid = child.pid;
  if (pid !== undefined) {
    writeFileSync(paths.smolvmPidFile, `${pid}\n`, { mode: 0o600 });
    void exited.then(() => removePidFile(paths.smolvmPidFile, pid));
  }

  let exitReason: string | undefined;
  void exited.then((reason) => (exitReason = reason));
  const stop = async () => {
    if (exitReason !== undefined) return true;
    child.kill("SIGTERM");
    const timeout = new AbortController();
    const stopped = await Promise.race([
      exited.then(() => true),
      sleep(stopTimeoutMs, false, { signal: timeout.signal }).catch(() => true),
    ]);
    timeout.abort();
    // Let the daemon exit; smolvm carries on stopping its machines.
    if (!stopped) child.unref();
    return stopped;
  };

  const deadline = Date.now() + readyTimeoutMs;
  for (;;) {
    if (exitReason !== undefined) {
      throw new DaemonError(
        `smolvm ${exitReason} during startup; see ${paths.smolvmLogFile}`,
      );
    }
    const status = await probe(origin, fetcher);
    if (status !== undefined && status >= 200 && status < 300) break;
    if (Date.now() >= deadline) {
      await stop();
      throw new DaemonError(
        `smolvm did not start serving at ${origin} within ${readyTimeoutMs / 1000}s; see ${paths.smolvmLogFile}`,
      );
    }
    await sleep(pollMs);
  }
  return {
    pid: pid as number,
    exited,
    get running() {
      return exitReason === undefined;
    },
    stop,
  };
}

/**
 * The `--listen` address for `apiUrl`. A managed smolvm serves plain HTTP at
 * the root, so the URL must be `http://host[:port]` with nothing else.
 */
export function smolvmListenAddress(apiUrl = DEFAULT_SMOL_API_URL): {
  origin: string;
  listen: string;
} {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    url = new URL("invalid:");
  }
  if (
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new DaemonError(
      "SMOL_API_URL must be http://<host>:<port> with no path, since `amika-hostd up` starts smolvm listening there",
    );
  }
  // `hostname` keeps an IPv6 literal's brackets, as `--listen` expects.
  return { origin: url.origin, listen: `${url.hostname}:${url.port || "80"}` };
}

/**
 * Where the smolvm installer puts it: on `PATH`, else `~/.smolvm/smolvm` or
 * its `~/.local/bin` symlink, which a service manager's `PATH` often lacks.
 */
export function findSmolvm(env: NodeJS.ProcessEnv): string | undefined {
  const home = env.HOME || homedir();
  const onPath = (env.PATH ?? "")
    .split(path.delimiter)
    .filter((dir) => path.isAbsolute(dir))
    .map((dir) => path.join(dir, "smolvm"));
  return [
    ...onPath,
    path.join(home, ".smolvm", "smolvm"),
    path.join(home, ".local", "bin", "smolvm"),
  ].find(isExecutableFile);
}

function isExecutableFile(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** `/health`'s status, or undefined if nothing answers. */
async function probe(
  origin: string,
  fetcher: typeof fetch,
): Promise<number | undefined> {
  try {
    const response = await fetcher(`${origin}/health`, {
      signal: AbortSignal.timeout(1_000),
      redirect: "manual",
    });
    await response.body?.cancel();
    return response.status;
  } catch {
    return undefined;
  }
}

function exitOf(child: ChildProcess): Promise<string> {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) =>
      resolve(signal ? `was killed by ${signal}` : `exited with code ${code}`),
    );
    child.once("error", (error) =>
      resolve(
        `could not be started (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`,
      ),
    );
  });
}
