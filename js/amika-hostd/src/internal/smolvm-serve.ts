/**
 * Start and stop the `smolvm serve` process behind `amika-hostd up`, so the
 * daemon and the runtime it forwards to come and go together.
 */
import {
  execFileSync,
  spawn as nodeSpawn,
  type ChildProcess,
} from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { BlockList, connect, isIP } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  DaemonError,
  isSmolvmRunning,
  openLogFile,
  readRunningPid,
  removeSmolvmFiles,
  removeStaleSmolvmFiles,
  type DaemonPaths,
  type Spawn,
} from "./daemon.js";

/** Where smolvm's API is reached unless `SMOL_API_URL` says otherwise. */
export const DEFAULT_SMOL_API_URL = "http://127.0.0.1:23020";

export interface ManagedSmolvm {
  pid: number;
  /** Where smolvm serves, which the daemon must forward to. */
  apiUrl: string;
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
  /** Whether anything accepts TCP connections at `host:port`. */
  isPortInUse?: (host: string, port: number) => Promise<boolean>;
  findSmolvm?: (env: NodeJS.ProcessEnv) => string | undefined;
  isSmolvmRunning?: (pid: number) => boolean;
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
  pollMs?: number;
  /**
   * How long smolvm must stay up after first answering before the answer is
   * trusted: a program that won the race for the port answers too, until
   * smolvm fails to bind and exits.
   */
  bindSettleMs?: number;
  /**
   * Stop looking for a port, or waiting for smolvm to serve, once this
   * aborts (a shutdown signal).
   */
  signal?: AbortSignal;
}

/** smolvm stops each machine cleanly on shutdown, which can take a while. */
export const SMOLVM_STOP_TIMEOUT_MS = 60_000;

/**
 * Where smolvm's own docs have people run it by hand. A smolvm there is not
 * one amika-hostd started, even though the scan from 23020 never reaches it.
 */
const USUAL_SMOLVM_URL = "http://127.0.0.1:8080";

/**
 * Start `smolvm serve` and resolve once it answers `/health`, or as soon as
 * `signal` aborts, so the caller can stop it. It listens at `apiUrl` (i.e.
 * `SMOL_API_URL`) and fails if that port is taken. Without one, it starts at
 * the default port and moves to the next while the port is taken. A port
 * that is taken is never shared: whatever holds it is not ours to stop.
 * Resolves undefined if `signal` aborts before smolvm is spawned.
 */
export async function startSmolvm(
  apiUrl: string | undefined,
  paths: DaemonPaths,
  env: NodeJS.ProcessEnv,
  {
    spawn = nodeSpawn,
    fetch: fetcher = fetch,
    isPortInUse = isTcpPortInUse,
    findSmolvm: find = findSmolvm,
    isSmolvmRunning: isRunning = isSmolvmRunning,
    readyTimeoutMs = 30_000,
    stopTimeoutMs = SMOLVM_STOP_TIMEOUT_MS,
    pollMs = 200,
    bindSettleMs = 500,
    signal,
  }: SmolvmDeps = {},
): Promise<ManagedSmolvm | undefined> {
  const first = smolvmListenAddress(apiUrl);
  const leftover = readRunningPid(paths.smolvmPidFile, isRunning);
  if (leftover !== undefined) {
    throw new DaemonError(
      `a smolvm started by an earlier amika-hostd is still running (pid ${leftover}); stop it with \`amika-hostd down\``,
    );
  }
  // Whatever an earlier run left behind (after a reboot, say) names no live
  // smolvm, so it must not outlive this run if this one fails to start.
  removeStaleSmolvmFiles(paths);
  const binary = find(env);
  if (binary === undefined) {
    throw new DaemonError(
      "smolvm not found on PATH, in ~/.smolvm or in ~/.local/bin; re-run install-amika-hostd.sh to install it",
    );
  }

  /** Start smolvm at `address`, or report that it could not bind there. */
  const launch = async (
    address: SmolvmAddress,
  ): Promise<ManagedSmolvm | typeof ADDRESS_IN_USE> => {
    const log = openLogFile(paths.smolvmLogFile);
    const logStart = fstatSync(log).size;
    let child: ChildProcess;
    try {
      child = spawn(binary, ["serve", "start", "--listen", address.listen], {
        // Its own process group, so Ctrl-C on `up --fg` reaches only the
        // daemon, which then stops smolvm after its own listener.
        detached: true,
        stdio: ["ignore", log, log],
        // Stop running machines on shutdown rather than leave them behind,
        // and keep ANSI color codes out of smolvm.log.
        env: { ...env, SMOLVM_DRAIN_ON_SHUTDOWN: "1", NO_COLOR: "1" },
      });
    } finally {
      closeSync(log);
    }
    const exited = exitOf(child);
    const pid = child.pid;
    if (pid !== undefined) {
      const files: [string, string][] = [
        [paths.smolvmPidFile, `${pid}\n`],
        [paths.smolvmUrlFile, `${address.origin}\n`],
      ];
      for (const [file, contents] of files) {
        try {
          writeFileSync(file, contents, { mode: 0o600 });
        } catch (error) {
          // Without its pidfile, `down` could never find this smolvm.
          child.kill("SIGTERM");
          removeSmolvmFiles(paths, pid);
          throw new DaemonError(
            `cannot write ${file}: ${(error as NodeJS.ErrnoException).code ?? "unknown error"}`,
          );
        }
      }
      void exited.then(() => removeSmolvmFiles(paths, pid));
    }

    let exitReason: string | undefined;
    void exited.then((reason) => (exitReason = reason));
    const stop = async () => {
      if (exitReason !== undefined) return true;
      child.kill("SIGTERM");
      const timeout = new AbortController();
      const stopped = await Promise.race([
        exited.then(() => true),
        sleep(stopTimeoutMs, false, { signal: timeout.signal }).catch(
          () => true,
        ),
      ]);
      timeout.abort();
      // Let the daemon exit; smolvm carries on stopping its machines.
      if (!stopped) child.unref();
      return stopped;
    };

    const deadline = Date.now() + readyTimeoutMs;
    for (;;) {
      if (exitReason !== undefined) {
        // Taken since the check: another program won the race for the port.
        if (failedToBind(paths.smolvmLogFile, logStart)) return ADDRESS_IN_USE;
        throw new DaemonError(
          `smolvm ${exitReason} during startup; see ${paths.smolvmLogFile}`,
        );
      }
      if (signal?.aborted) break;
      if (isHealthy(await probe(address.origin, fetcher))) {
        // A program that took the port first would also answer, so give
        // smolvm time to fail to bind before trusting the answer.
        await sleep(bindSettleMs);
        if (exitReason === undefined) break;
        continue;
      }
      if (Date.now() >= deadline) {
        await stop();
        throw new DaemonError(
          `smolvm did not start serving at ${address.origin} within ${readyTimeoutMs / 1000}s; see ${paths.smolvmLogFile}`,
        );
      }
      await sleep(pollMs);
    }
    return {
      pid: pid as number,
      apiUrl: address.origin,
      exited,
      get running() {
        return exitReason === undefined;
      },
      stop,
    };
  };

  const refuseForeignSmolvm = async (origin: string) => {
    // A smolvm someone else runs shares this host's machines, so starting a
    // second one on another port could reach (and on shutdown drain) them.
    if (await looksLikeSmolvm(origin, fetcher)) {
      throw new DaemonError(
        `a smolvm that amika-hostd did not start is already serving at ${origin}; stop it first, since amika-hostd runs its own`,
      );
    }
  };
  const usual = smolvmListenAddress(USUAL_SMOLVM_URL);
  if (
    usual.origin !== first.origin &&
    (await isPortInUse(usual.address, usual.port))
  ) {
    await refuseForeignSmolvm(usual.origin);
  }

  // Without SMOL_API_URL, any free port from the default up will do.
  const attempts = apiUrl === undefined ? 65_536 - first.port : 1;
  for (let i = 0; i < attempts; i++) {
    // The scan can be long; a shutdown signal must not wait it out.
    if (signal?.aborted) return undefined;
    const address = withPort(first, first.port + i);
    if (!(await isPortInUse(address.address, address.port))) {
      const started = await launch(address);
      if (started !== ADDRESS_IN_USE) return started;
    }
    // The port is held, or was taken since the check.
    await refuseForeignSmolvm(address.origin);
    if (apiUrl !== undefined) {
      throw new DaemonError(
        `another program is already listening at ${address.origin} (SMOL_API_URL); stop it, or set SMOL_API_URL to a free port`,
      );
    }
  }
  const last = first.port + attempts - 1;
  throw new DaemonError(
    `ports ${first.port}-${last} on ${first.address} are all in use, so smolvm has nowhere to listen; set SMOL_API_URL to a free port`,
  );
}

const ADDRESS_IN_USE = Symbol("address in use");

/**
 * Whether smolvm's output since `offset` says it could not bind its port:
 * `Address already in use (os error 48)` on macOS, `98` on Linux. The log
 * is appended to across runs, so only this run's start of it is read.
 */
function failedToBind(logFile: string, offset: number): boolean {
  let fd: number;
  try {
    fd = openSync(logFile, "r");
  } catch {
    return false;
  }
  try {
    const output = Buffer.alloc(BIND_ERROR_WINDOW);
    const read = readSync(fd, output, 0, output.length, offset);
    return /address already in use/i.test(output.toString("utf8", 0, read));
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

/** smolvm reports a failed bind as soon as it starts, well within this. */
const BIND_ERROR_WINDOW = 64 * 1024;

/**
 * Whether `origin` serves smolvm's API rather than some other program that
 * happens to answer `/health` (a dev server, say).
 */
async function looksLikeSmolvm(
  origin: string,
  fetcher: typeof fetch,
): Promise<boolean> {
  return (
    isHealthy(await probe(origin, fetcher)) &&
    isHealthy(await probe(origin, fetcher, "/api/v1/machines"))
  );
}

/**
 * Whether anything accepts a TCP connection at `host:port`. Any listener
 * counts, not only an HTTP server: smolvm cannot bind a port another program
 * (an editor's language server, say) holds.
 */
export function isTcpPortInUse(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 1_000 });
    const done = (inUse: boolean) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.once("connect", () => done(true));
    // A loopback port that neither accepts nor refuses is held by something.
    socket.once("timeout", () => done(true));
    socket.on("error", () => done(false));
  });
}

/**
 * The `--listen` address for `apiUrl`. A managed smolvm serves plain HTTP at
 * the root, so the URL must be `http://host[:port]` with nothing else, and
 * `--listen` takes only an IP address, not a hostname such as `localhost`.
 * smolvm's API has no authentication, so the address must also be loopback:
 * anywhere else would expose it without amika-hostd's bearer check.
 */
export function smolvmListenAddress(
  apiUrl = DEFAULT_SMOL_API_URL,
): SmolvmAddress {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    url = new URL("invalid:");
  }
  const address = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    // Port 0 would have smolvm pick a port the daemon never learns.
    url.port === "0" ||
    isIP(address) === 0
  ) {
    throw new DaemonError(
      "SMOL_API_URL must be http://<IP address>:<port> with no path (e.g. http://127.0.0.1:23020), since `amika-hostd up` starts smolvm listening there",
    );
  }
  if (!LOOPBACK.check(address, isIP(address) === 6 ? "ipv6" : "ipv4")) {
    throw new DaemonError(
      "SMOL_API_URL must be a loopback address (127.0.0.0/8 or [::1]), since smolvm's API has no authentication and `amika-hostd up` starts it listening there",
    );
  }
  return withPort({ address }, Number(url.port || "80"));
}

/** Where smolvm listens: `address` (unbracketed) is what a socket connects to. */
export interface SmolvmAddress {
  origin: string;
  listen: string;
  address: string;
  port: number;
}

function withPort(
  { address }: { address: string },
  port: number,
): SmolvmAddress {
  // `--listen` and URLs take an IPv6 literal in brackets.
  const host = isIP(address) === 6 ? `[${address}]` : address;
  const listen = `${host}:${port}`;
  return { origin: new URL(`http://${listen}`).origin, listen, address, port };
}

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");

function isHealthy(status: number | undefined): boolean {
  return status !== undefined && status >= 200 && status < 300;
}

/** `GET path`'s status, or undefined if nothing answers. */
async function probe(
  origin: string,
  fetcher: typeof fetch,
  path = "/health",
): Promise<number | undefined> {
  try {
    const response = await fetcher(`${origin}${path}`, {
      signal: AbortSignal.timeout(1_000),
      redirect: "manual",
    });
    await response.body?.cancel();
    return response.status;
  } catch {
    return undefined;
  }
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

/**
 * The oldest smolvm whose image cache serves every rig: it seeds a machine
 * with a disk larger than its 20 GiB template (growing the seed), and
 * `smolvm serve` refreshes recently used images' seeds when it starts.
 */
export const MIN_SMOLVM_VERSION = "1.24.0";

/**
 * The version `smolvm --version` reports (`smolvm 1.25.0`), or undefined when
 * smolvm cannot be found or run, or prints something else.
 */
export function smolvmVersion(
  env: NodeJS.ProcessEnv,
  {
    find = findSmolvm,
    run = (binary: string) =>
      execFileSync(binary, ["--version"], {
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
      }),
  }: {
    find?: (env: NodeJS.ProcessEnv) => string | undefined;
    run?: (binary: string) => string;
  } = {},
): string | undefined {
  const binary = find(env);
  if (binary === undefined) return undefined;
  try {
    return /\b(\d+\.\d+\.\d+)\b/.exec(run(binary))?.[1];
  } catch {
    return undefined;
  }
}

/** Whether dotted version `version` comes before `minimum`. */
export function isOlderVersion(version: string, minimum: string): boolean {
  const parts = (v: string) => v.split(".").map(Number);
  const [a, b] = [parts(version), parts(minimum)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff < 0;
  }
  return false;
}

function isExecutableFile(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
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
