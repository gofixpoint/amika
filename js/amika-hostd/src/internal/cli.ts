/** Parse `amika-hostd` commands and run them against injectable effects. */
import { parseArgs } from "node:util";
import {
  AmikaApiError,
  registerHost as registerHostWithAmika,
  setHostUrl as setHostUrlInAmika,
  type RegisteredHost,
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
  up                  Register this host with Amika, then start the daemon in
                      the background
  serve               Run the HTTP server in the foreground without registering
  register-url <url>  Set this host's internet-facing URL (e.g. an ngrok or
                      Cloudflare Tunnel URL) to complete registration

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
  setHostUrl?: typeof setHostUrlInAmika;
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
    switch (parsed.command) {
      case "up": {
        const config = requireSettings(resolved, REGISTRATION_SETTINGS);
        // Check first so a second `up` fails without calling Amika.
        ensureNotRunning(daemonPaths(deps.env).pidFile, deps.isRunning);
        await register(config, deps);
        if (parsed.fg) await serveInForeground(config, deps);
        else await startBackground(parsed.flags, deps);
        break;
      }
      case "serve":
        await serveInForeground(requireSettings(resolved, ["secretKey"]), deps);
        break;
      case "register-url": {
        const config = requireSettings(resolved, REGISTRATION_SETTINGS);
        await saveUrl(config, await register(config, deps), parsed.url, deps);
        break;
      }
      default:
        assertNever(parsed);
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
  | { help: false; command: "up"; fg: boolean; flags: HostdFlags }
  | { help: false; command: "serve"; flags: HostdFlags }
  | { help: false; command: "register-url"; url: string; flags: HostdFlags };

const REGISTRATION_SETTINGS = ["apiKey", "hostname", "secretKey"] as const;

type RegistrationConfig = HostdConfigWith<
  (typeof REGISTRATION_SETTINGS)[number]
>;

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
  const [command, ...rest] = positionals;
  const flags = { port: values.port, host: values.host };
  switch (command) {
    case "up":
      expectArguments(rest, 0);
      return { help: false, command, fg: values.fg ?? false, flags };
    case "serve":
      rejectOptions(command, values, ["fg"]);
      expectArguments(rest, 0);
      return { help: false, command, flags };
    case "register-url": {
      rejectOptions(command, values, ["fg", "port", "host"]);
      expectArguments(rest, 1);
      const url = parseHostUrl(rest[0]);
      if (url === undefined) {
        throw new UsageError(`not an http(s) URL: ${rest[0]}`);
      }
      return { help: false, command, url, flags: {} };
    }
    case undefined:
      throw new UsageError("missing command");
    default:
      throw new UsageError(`unknown command: ${command}`);
  }
}

function expectArguments(rest: string[], count: number) {
  if (rest.length > count) {
    throw new UsageError(`unexpected argument: ${rest[count]}`);
  }
  if (rest.length < count) throw new UsageError("missing <url>");
}

function rejectOptions(
  command: string,
  values: Record<string, unknown>,
  names: readonly string[],
) {
  const given = names.find((name) => values[name] !== undefined);
  if (given !== undefined) {
    throw new UsageError(`--${given} does not apply to \`${command}\``);
  }
}

/** Accept only an absolute http(s) URL without embedded credentials. */
function parseHostUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (!["http:", "https:"].includes(url.protocol)) return undefined;
  if (url.username || url.password) return undefined;
  return url.pathname === "/" && !url.search && !url.hash
    ? url.origin
    : url.toString();
}

/**
 * Register before serving, so an unregistered host never accepts traffic. Only
 * the hostname and secret are sent; an existing host's secret is never changed.
 */
async function register(
  config: RegistrationConfig,
  deps: CliDeps,
): Promise<RegisteredHost> {
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
  return host;
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

async function saveUrl(
  config: RegistrationConfig,
  host: RegisteredHost,
  url: string,
  deps: CliDeps,
) {
  const saved = await (deps.setHostUrl ?? setHostUrlInAmika)(
    { apiUrl: config.apiUrl, apiKey: config.apiKey },
    host,
    url,
  );
  deps.out(`Set the public URL of host ${saved.hostname} to ${saved.url}`);
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

function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
}
