/** Parse `amika-hostd` commands and run them against injectable effects. */
import { parseArgs } from "node:util";
import {
  AmikaApiError,
  registerHost as registerHostWithAmika,
} from "./amika-api.js";
import {
  ConfigError,
  ENV_NAMES,
  loadConfigFile as loadConfigFileFromDisk,
  requireSettings,
  resolveConfig,
  type HostdConfigWith,
  type HostdFlags,
} from "./config.js";
import {
  DaemonError,
  claimPidFile as claimPidFileOnDisk,
  daemonPaths,
  ensureNotRunning,
  notifyReady as notifyParent,
  startInBackground as spawnInBackground,
} from "./daemon.js";
import {
  startServer as startServerOnPort,
  type RunningServer,
} from "./server.js";

export const USAGE = `Usage: amika-hostd <command> [options]

Commands:
  up      Register this host with Amika, then start the daemon in the background
  serve   Run the HTTP server in the foreground without registering

Options:
  --fg           (up) Stay in the foreground instead of backgrounding
  --port <port>  Port to listen on (AMIKA_HOSTD_PORT, TOML port; default 3020)
  --host <host>  Address to bind (AMIKA_HOSTD_HOST, TOML host; default 127.0.0.1)
  -h, --help     Show this help
`;

export interface CliDeps {
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  /** The argv that re-runs this CLI: `[node, ...execArgv, script]`. */
  self: readonly [string, ...string[]];
  /** Resolves when the foreground server should shut down (e.g. SIGTERM). */
  shutdownSignal: () => Promise<void>;
  loadConfigFile?: typeof loadConfigFileFromDisk;
  startServer?: typeof startServerOnPort;
  startInBackground?: typeof spawnInBackground;
  claimPidFile?: typeof claimPidFileOnDisk;
  notifyReady?: typeof notifyParent;
  isRunning?: (pid: number) => boolean;
  registerHost?: typeof registerHostWithAmika;
}

/** Run one command and return its exit code. Expected failures never throw. */
export async function runCli(
  args: readonly string[],
  deps: CliDeps,
): Promise<number> {
  try {
    const parsed = parseCommand(args);
    if (parsed.help) {
      deps.out(USAGE);
      return 0;
    }
    const resolved = resolveConfig({
      flags: parsed.flags,
      env: deps.env,
      file: (deps.loadConfigFile ?? loadConfigFileFromDisk)(deps.env),
    });
    if (parsed.command === "up") {
      const registration = requireSettings(resolved, [
        "apiKey",
        "hostname",
        "secretKey",
      ]);
      // Check first so a second `up` fails without calling Amika.
      ensureNotRunning(daemonPaths(deps.env).pidFile, deps.isRunning);
      await register(registration, deps);
    }
    const config = requireSettings(resolved, ["secretKey"]);
    if (parsed.command === "up" && !parsed.fg) {
      await startBackground(parsed.flags, deps);
    } else {
      await serveInForeground(config, deps);
    }
    return 0;
  } catch (error) {
    if (
      error instanceof UsageError ||
      error instanceof ConfigError ||
      error instanceof DaemonError ||
      error instanceof AmikaApiError
    ) {
      deps.err(`amika-hostd: ${error.message}`);
      if (error instanceof UsageError) deps.err(USAGE);
      return error instanceof UsageError ? 2 : 1;
    }
    throw error;
  }
}

type ParsedCommand =
  | { help: true }
  | { help: false; command: "up" | "serve"; fg: boolean; flags: HostdFlags };

class UsageError extends Error {}

function parseCommand(args: readonly string[]): ParsedCommand {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        fg: { type: "boolean" },
        port: { type: "string" },
        host: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  const [command, ...extra] = positionals;
  if (command !== "up" && command !== "serve") {
    throw new UsageError(
      command === undefined ? "missing command" : `unknown command: ${command}`,
    );
  }
  if (extra.length > 0) {
    throw new UsageError(`unexpected argument: ${extra[0]}`);
  }
  if (command === "serve" && values.fg) {
    throw new UsageError("--fg only applies to `up`");
  }
  return {
    help: false,
    command,
    fg: values.fg ?? false,
    flags: { port: values.port, host: values.host },
  };
}

/**
 * Register before serving, so an unregistered host never accepts traffic. Only
 * the hostname and secret are sent; an existing host's secret is never changed.
 */
async function register(
  config: HostdConfigWith<"apiKey" | "hostname" | "secretKey">,
  deps: CliDeps,
) {
  const { host, created } = await (deps.registerHost ?? registerHostWithAmika)(
    { apiUrl: config.apiUrl, apiKey: config.apiKey },
    { hostname: config.hostname, secretKey: config.secretKey },
  );
  if (created) {
    deps.out(
      `Registered host ${host.hostname} with ${config.apiUrl} (${host.id})`,
    );
  } else {
    deps.out(
      `Host ${host.hostname} is already registered with ${config.apiUrl} (${host.id})`,
    );
    // Registration never changes an existing host's secret (see AGENTS.md).
    deps.out(
      "Amika keeps the secret key stored when the host was first registered; if yours has changed since, Amika's requests to this host will be rejected.",
    );
  }
}

/**
 * The background daemon only serves; registration happens in `up` itself.
 * Keep the API key out of the background daemon's environment.
 */
function withoutApiKey(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const apiKeyNames: readonly string[] = ENV_NAMES.apiKey;
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !apiKeyNames.includes(name)),
  );
}

/** Forward the operator's own flags so the child resolves config identically. */
async function startBackground(flags: HostdFlags, deps: CliDeps) {
  const paths = daemonPaths(deps.env);
  const forwarded = [
    ...(flags.port === undefined ? [] : ["--port", flags.port]),
    ...(flags.host === undefined ? [] : ["--host", flags.host]),
  ];
  const { pid, port } = await (deps.startInBackground ?? spawnInBackground)(
    [...deps.self, "serve", ...forwarded],
    paths,
    { isRunning: deps.isRunning, env: withoutApiKey(deps.env) },
  );
  deps.out(
    `amika-hostd started in the background on port ${port} (pid ${pid})`,
  );
  deps.out(`Logs: ${paths.logFile}`);
  deps.out(`Stop it with: kill $(cat ${paths.pidFile})`);
}

async function serveInForeground(
  config: HostdConfigWith<"secretKey">,
  deps: CliDeps,
) {
  const { pidFile } = daemonPaths(deps.env);
  const claim = deps.claimPidFile ?? claimPidFileOnDisk;
  const release = claim(pidFile, deps.isRunning);
  let server: RunningServer;
  try {
    server = await (deps.startServer ?? startServerOnPort)(config);
  } catch (error) {
    release();
    throw new DaemonError(
      `cannot listen on ${config.host}:${config.port}: ${errorCode(error)}`,
    );
  }
  deps.out(`amika-hostd listening on http://${config.host}:${server.port}`);
  try {
    await (deps.notifyReady ?? notifyParent)(server.port);
  } catch (error) {
    try {
      await server.close();
    } finally {
      release();
    }
    throw error;
  }
  try {
    await deps.shutdownSignal();
    await server.close();
  } finally {
    release();
  }
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "unknown error";
}
