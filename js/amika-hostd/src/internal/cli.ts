/** Parse `amika-hostd` commands and run them against injectable effects. */
import { isIPv6 } from "node:net";
import { parseArgs } from "node:util";
import {
  AmikaApiError,
  registerHost as registerHostWithAmika,
  setHostSizes as setHostSizesInAmika,
  setHostUrl as setHostUrlInAmika,
  type RegisteredHost,
} from "./amika-api.js";
import {
  ConfigError,
  ENV_NAMES,
  loadConfigFile as loadConfigFileFromDisk,
  requireSettings,
  resolveConfig,
  type HostdConfig,
  type HostdConfigWith,
  type HostdFlags,
} from "./config.js";
import { openSecrets as openSecretStore, type Secrets } from "./credentials.js";
import {
  DaemonError,
  claimPidFile as claimPidFileOnDisk,
  daemonPaths,
  ensureNotRunning,
  isDaemonProcess,
  isDaemonRunning,
  isSmolvmRunning as isSmolvmProcess,
  notifyReady as notifyParent,
  receiveSecretKey as receiveSecretKeyFromUp,
  readRunningPid,
  removeSmolvmFiles,
  removeStaleSmolvmFiles,
  startInBackground as spawnInBackground,
  stopProcess as stopProcessByPid,
  type DaemonPaths,
} from "./daemon.js";
import {
  SHUTDOWN_GRACE_MS,
  startServer as startServerOnPort,
  type RunningServer,
} from "./server.js";
import { providerRuntime } from "./machine-runtime.js";
import { PromptCancelled, type Prompt } from "./prompt.js";
import { runSetup, withoutInvalidSecret, type SetupDeps } from "./setup.js";
import {
  DEFAULT_SMOL_API_URL,
  SMOLVM_STOP_TIMEOUT_MS,
  startSmolvm as startSmolvmServe,
  type ManagedSmolvm,
} from "./smolvm-serve.js";

export const USAGE = `Usage: amika-hostd <command> [options]

Commands:
  setup               Set this host's hostname, secret key and Amika API key,
                      and write default rig sizes to the config file
  up                  Register this host with Amika, then start smolvm and the
                      daemon in the background (running setup first if needed)
  down                Stop the daemon and its smolvm, which stops every machine
  serve               Run the HTTP server in the foreground without registering
  register-url <url>  Set this host's internet-facing URL (e.g. an ngrok or
                      Cloudflare Tunnel URL) to complete registration

Options:
  --fg           (up) Stay in the foreground instead of backgrounding
  --smolvm       (serve) Also start smolvm, and stop it on exit, as \`up\` does
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
  startSmolvm?: typeof startSmolvmServe;
  stopProcess?: typeof stopProcessByPid;
  isSmolvmRunning?: (pid: number) => boolean;
  claimPidFile?: typeof claimPidFileOnDisk;
  notifyReady?: typeof notifyParent;
  isRunning?: (pid: number) => boolean;
  registerHost?: typeof registerHostWithAmika;
  setHostSizes?: typeof setHostSizesInAmika;
  setHostUrl?: typeof setHostUrlInAmika;
  /**
   * Ask the operator a question (see `Prompt`). Absent when stdin or stdout
   * is not a terminal, so `up` never blocks.
   */
  prompt?: Prompt;
  /** `prompt` without echoing the answer; absent without a terminal. */
  promptSecret?: Prompt;
  /** Opens the secret store the config chose; defaults to `openSecrets`. */
  openSecrets?: (
    kind: HostdConfig["secretStore"],
    env: NodeJS.ProcessEnv,
  ) => Secrets;
  /** How a background daemon gets the secret key from the `up` that started it. */
  receiveSecretKey?: () => Promise<string>;
  writeConfigFile?: SetupDeps["writeConfigFile"];
  systemHostname?: SetupDeps["systemHostname"];
  generateSecretKey?: SetupDeps["generateSecretKey"];
}

export { PromptCancelled };

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
    // Stopping needs only the pidfiles, not a valid configuration.
    if (parsed.command === "down") return await down(deps);
    if (parsed.command === "setup") return await setup(deps);
    // `up` reads a placeholder secret (the example's `REPLACE_ME`) as unset,
    // as setup does, so it can run setup to replace it rather than fail.
    const resolve = ({ tolerant = false } = {}) => {
      const file = (deps.loadConfigFile ?? loadConfigFileFromDisk)(deps.env);
      return resolveConfig({
        flags: parsed.flags,
        env: deps.env,
        file: tolerant && file ? withoutInvalidSecret(file) : file,
      });
    };
    // So does the daemon `up` starts: it uses the secret key `up` hands it,
    // so a placeholder left in the file must not stop it.
    const resolved = resolve({
      tolerant:
        parsed.command === "up" ||
        (parsed.command === "serve" && parsed.secretKeyFromUp),
    });
    switch (parsed.command) {
      case "up": {
        // Check first so a second `up` fails without calling Amika.
        ensureNotRunning(daemonPaths(deps.env).pidFile, deps.isRunning);
        let filled = withSecrets(resolved, deps);
        if (
          (!hasSettings(filled.config) || filled.strayFileSecret) &&
          deps.prompt &&
          deps.promptSecret
        ) {
          deps.out("amika-hostd is not set up yet, so running setup first.");
          const code = await setup(deps, { fromUp: true });
          if (code !== 0) return code;
          filled = withSecrets(resolve(), deps);
        }
        const config = requireSettings(
          placedSecrets(filled, deps),
          REGISTRATION_SETTINGS,
        );
        const host = await register(config, deps);
        // Start the daemon first, so the operator can expose it (and check the
        // tunnel reaches it) before giving Amika its public URL.
        const finish = (port: number) =>
          completeRegistration(config, host, port, deps);
        if (parsed.fg) {
          await serveInForeground(config, deps, {
            smolvm: true,
            afterStart: finish,
          });
          break;
        }
        const port = await startBackground(parsed.flags, config, deps);
        try {
          return (await finish(port)) ? 0 : 1;
        } catch (error) {
          if (!(error instanceof PromptCancelled)) throw error;
          deps.err(
            `amika-hostd: cancelled; the daemon is still running. ${FINISH_LATER}`,
          );
          return 130;
        }
      }
      case "serve": {
        // A daemon `up` started gets the secret key from it; run by hand, it
        // reads the secret store itself.
        const secretKey = parsed.secretKeyFromUp
          ? await (deps.receiveSecretKey ?? receiveSecretKeyFromUp)()
          : undefined;
        const config =
          secretKey === undefined
            ? placedSecrets(
                withSecrets(resolved, deps, { apiKey: false }),
                deps,
              )
            : { ...resolved, secretKey };
        await serveInForeground(requireSettings(config, ["secretKey"]), deps, {
          smolvm: parsed.smolvm,
        });
        break;
      }
      case "register-url": {
        const config = requireSettings(
          placedSecrets(withSecrets(resolved, deps), deps),
          REGISTRATION_SETTINGS,
        );
        await saveUrl(config, await register(config, deps), parsed.url, deps);
        break;
      }
      default:
        assertNever(parsed);
    }
    return 0;
  } catch (error) {
    if (error instanceof PromptCancelled) {
      deps.err(`amika-hostd: cancelled; the daemon stopped. ${FINISH_LATER}`);
      return 130;
    }
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
  | { help: false; command: "setup" }
  | { help: false; command: "up"; fg: boolean; flags: HostdFlags }
  | { help: false; command: "down" }
  | {
      help: false;
      command: "serve";
      smolvm: boolean;
      secretKeyFromUp: boolean;
      flags: HostdFlags;
    }
  | { help: false; command: "register-url"; url: string; flags: HostdFlags };

const REGISTRATION_SETTINGS = ["apiKey", "hostname", "secretKey"] as const;

type RegistrationConfig = HostdConfigWith<
  (typeof REGISTRATION_SETTINGS)[number]
>;

class UsageError extends Error {}

/** Run `setup`, reporting Ctrl-C as a setup that changed nothing. */
async function setup(
  deps: CliDeps,
  options: { fromUp?: boolean } = {},
): Promise<number> {
  if (!deps.prompt || !deps.promptSecret) {
    throw new ConfigError(
      "`amika-hostd setup` asks questions, so run it in a terminal",
    );
  }
  try {
    await runSetup(
      {
        ...deps,
        prompt: deps.prompt,
        promptSecret: deps.promptSecret,
        secrets: secretsFor(resolveTolerant(deps), deps),
      },
      options,
    );
    return 0;
  } catch (error) {
    if (!(error instanceof PromptCancelled)) throw error;
    deps.err("amika-hostd: setup cancelled; nothing was changed.");
    return 130;
  }
}

/** The config as `up` and `setup` read it: a placeholder secret as unset. */
function resolveTolerant(deps: CliDeps): HostdConfig {
  const file = (deps.loadConfigFile ?? loadConfigFileFromDisk)(deps.env);
  return resolveConfig({
    env: deps.env,
    file: file && withoutInvalidSecret(file),
  });
}

function secretsFor(config: HostdConfig, deps: CliDeps): Secrets {
  return (deps.openSecrets ?? openSecretStore)(config.secretStore, deps.env);
}

interface Filled {
  config: HostdConfig;
  /**
   * With the keychain store, the config file still holds a `secret_key`,
   * which is never used: setup moves it into the keychain, or removes it.
   */
  strayFileSecret?: string;
}

/**
 * Fill in the secrets the environment does not set from the secret store
 * the config chose. The environment always wins, and the store is opened
 * only for a secret it does not set, so exported secrets work on a machine
 * with no keychain. In the keychain, a `secret_key` left in the config file
 * is never used. The background daemon never calls this; `up` hands it the
 * secret key.
 */
function withSecrets(
  config: HostdConfig,
  deps: CliDeps,
  { apiKey: wantApiKey = true } = {},
): Filled {
  const keychain = config.secretStore === "keychain";
  let apiKey = config.apiKey;
  let secretKey =
    keychain && config.secretKeyFrom === "file" ? undefined : config.secretKey;
  const needApiKey = wantApiKey && apiKey === undefined;
  // With the file store a secret key not set by now is simply missing.
  const needSecretKey = keychain && secretKey === undefined;
  if (needApiKey || needSecretKey) {
    const secrets = secretsFor(config, deps);
    if (needApiKey) apiKey = secrets.apiKey.get();
    if (needSecretKey) secretKey = secrets.secretKey?.get();
  }
  return {
    config: { ...config, apiKey, secretKey },
    strayFileSecret:
      keychain && config.secretKeyInFile
        ? (config.configPath ?? "the config file")
        : undefined,
  };
}

/**
 * `filled.config`, after dealing with a stray `secret_key` in the file: a
 * refusal naming setup if there is no other secret key, else a warning, so
 * it is not left in plain text unnoticed.
 */
function placedSecrets(
  { config, strayFileSecret }: Filled,
  deps: CliDeps,
): HostdConfig {
  if (strayFileSecret === undefined) return config;
  if (config.secretKey === undefined) {
    throw new ConfigError(
      `${strayFileSecret} holds secret_key, but secrets are kept in the keychain: run \`amika-hostd setup\` to move it there, or set \`secret_store = "file"\` to keep it in the file`,
    );
  }
  deps.err(
    `amika-hostd: ${strayFileSecret} still holds a secret_key, which is not used since secrets are kept in the keychain; run \`amika-hostd setup\` to remove it.`,
  );
  return config;
}

function hasSettings(config: HostdConfig): boolean {
  return REGISTRATION_SETTINGS.every((key) => config[key] !== undefined);
}

function parseCommand(args: readonly string[]): ParsedCommand {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        fg: { type: "boolean" },
        smolvm: { type: "boolean" },
        port: { type: "string" },
        host: { type: "string" },
        // Internal: how `up` starts the background daemon (see startBackground).
        "secret-key-from-up": { type: "boolean" },
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
    case "setup":
      rejectOptions(command, values, [
        "fg",
        "smolvm",
        "port",
        "host",
        "secret-key-from-up",
      ]);
      expectArguments(rest, 0);
      return { help: false, command };
    case "up":
      rejectOptions(command, values, ["smolvm", "secret-key-from-up"]);
      expectArguments(rest, 0);
      return { help: false, command, fg: values.fg ?? false, flags };
    case "down":
      rejectOptions(command, values, [
        "fg",
        "smolvm",
        "port",
        "host",
        "secret-key-from-up",
      ]);
      expectArguments(rest, 0);
      return { help: false, command };
    case "serve":
      rejectOptions(command, values, ["fg"]);
      expectArguments(rest, 0);
      return {
        help: false,
        command,
        smolvm: values.smolvm ?? false,
        secretKeyFromUp: values["secret-key-from-up"] ?? false,
        flags,
      };
    case "register-url": {
      rejectOptions(command, values, [
        "fg",
        "smolvm",
        "port",
        "host",
        "secret-key-from-up",
      ]);
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
 * Register before serving, so an unregistered host never accepts traffic. The
 * hostname, secret and sizes are sent; an existing host's secret is never
 * changed, but its sizes are replaced with the configured ones.
 */
async function register(
  config: RegistrationConfig,
  deps: CliDeps,
): Promise<RegisteredHost> {
  const api = { apiUrl: config.apiUrl, apiKey: config.apiKey };
  const { sizes } = config;
  const { host, created } = await (deps.registerHost ?? registerHostWithAmika)(
    api,
    { hostname: config.hostname, secretKey: config.secretKey, sizes },
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
    // Nor its sizes, so bring those up to date with the config separately.
    await (deps.setHostSizes ?? setHostSizesInAmika)(api, host, sizes);
    deps.out(
      `Updated the sizes of host ${host.hostname} (${describeSizes(sizes)})`,
    );
  }
  return host;
}

function describeSizes(sizes: Record<string, unknown>): string {
  const names = Object.keys(sizes);
  return names.length === 0 ? "none" : names.join(", ");
}

/**
 * `env` without the given variables. The background daemon only serves, so
 * it never needs the API key; smolvm needs neither it nor the secret key.
 */
function withoutEnv(
  env: NodeJS.ProcessEnv,
  names: readonly string[],
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !names.includes(name)),
  );
}

const FINISH_LATER =
  "Run `amika-hostd register-url <url>` to complete registration.";

/**
 * Registration is complete once Amika knows the host's internet-facing URL.
 * Runs once the daemon is up: without a URL, ask the operator to expose the
 * daemon and enter the public URL (or say how to finish without a terminal);
 * with one, remind them where Amika expects to reach it. Returns false if
 * saving the URL failed; the daemon keeps running either way.
 */
async function completeRegistration(
  config: RegistrationConfig,
  host: RegisteredHost,
  port: number,
  deps: CliDeps,
): Promise<boolean> {
  const local = localUrl(config.host, port);
  if (host.url !== null) {
    deps.out(
      `Amika reaches this host at ${host.url}; make sure it is exposed there and forwards to ${local}.`,
    );
    return true;
  }
  deps.out("");
  deps.out(
    `To complete registration, expose ${local} to the internet (e.g. \`ngrok http ${port}\` or \`cloudflared tunnel --url ${local}\`) and give Amika its public URL.`,
  );
  if (!deps.prompt) {
    deps.out(FINISH_LATER);
    return true;
  }
  for (;;) {
    const answer = (
      await deps.prompt("Public URL for this host, or Enter to skip: ")
    )?.trim();
    if (!answer) {
      deps.out(`Skipped. ${FINISH_LATER}`);
      return true;
    }
    const url = parseHostUrl(answer);
    if (url === undefined) {
      deps.err(`Not an http(s) URL: ${answer}`);
      continue;
    }
    try {
      await saveUrl(config, host, url, deps);
      return true;
    } catch (error) {
      if (!(error instanceof AmikaApiError)) throw error;
      deps.err(`amika-hostd: ${error.message}`);
      deps.err(`The daemon is still running. ${FINISH_LATER}`);
      return false;
    }
  }
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

/**
 * Forward the operator's own flags so the child resolves config identically,
 * and hand it the secret key over IPC: `up` read it from the secret store,
 * where an unlock prompt can reach the operator. Neither secret goes in the
 * child's environment.
 */
async function startBackground(
  flags: HostdFlags,
  config: HostdConfigWith<"secretKey">,
  deps: CliDeps,
) {
  const paths = daemonPaths(deps.env);
  const forwarded = [
    ...(flags.port === undefined ? [] : ["--port", flags.port]),
    ...(flags.host === undefined ? [] : ["--host", flags.host]),
  ];
  const { pid, port } = await (deps.startInBackground ?? spawnInBackground)(
    [...deps.self, "serve", "--smolvm", "--secret-key-from-up", ...forwarded],
    paths,
    {
      isRunning: deps.isRunning,
      env: withoutEnv(deps.env, [...ENV_NAMES.apiKey, ...ENV_NAMES.secretKey]),
      secretKey: config.secretKey,
    },
  );
  deps.out(
    `amika-hostd started in the background on port ${port} (pid ${pid})`,
  );
  deps.out(`Logs: ${paths.logFile}`);
  deps.out("To stop the daemon and its VMs, run `amika-hostd down`.");
  return port;
}

/**
 * Serve until a shutdown signal. With `smolvm`, start smolvm first and stop it
 * last, and stop serving if it exits. `afterStart` runs once the server is
 * listening (e.g. to complete registration); if it throws, the server stops.
 */
async function serveInForeground(
  config: HostdConfigWith<"secretKey">,
  deps: CliDeps,
  {
    smolvm = false,
    afterStart,
  }: { smolvm?: boolean; afterStart?: (port: number) => Promise<unknown> } = {},
) {
  const paths = daemonPaths(deps.env);
  const claim = deps.claimPidFile ?? claimPidFileOnDisk;
  const release = claim(paths.pidFile, deps.isRunning);
  // Listen for the signal first, so Ctrl-C during startup (or during
  // `afterStart`'s request to Amika) still stops smolvm on the way out.
  const signalled = deps.shutdownSignal();
  const interrupted = new AbortController();
  void signalled.then(() => interrupted.abort());
  let runtime: ManagedSmolvm | undefined;
  let server: RunningServer | undefined;
  const stopAll = async () => {
    try {
      await server?.close();
    } finally {
      try {
        await stopSmolvm(runtime, deps);
      } finally {
        release();
      }
    }
  };
  try {
    if (smolvm) {
      runtime = await startSmolvm(config, paths, deps, interrupted.signal);
    }
    if (!interrupted.signal.aborted) {
      // Forward to wherever smolvm ended up, which may not be the default.
      const serving = runtime
        ? { ...config, smolApiUrl: runtime.apiUrl }
        : config;
      server = await listen(serving, paths.servicesFile, deps);
    }
    // Signalled during startup: stop without telling `up` it is ready.
    if (server === undefined || interrupted.signal.aborted) {
      await stopAll();
      return;
    }
    deps.out(`amika-hostd listening on ${localUrl(config.host, server.port)}`);
    await (deps.notifyReady ?? notifyParent)(server.port);
  } catch (error) {
    await stopAll();
    throw error;
  }
  const port = server.port;
  const shutdown = Promise.race([
    signalled,
    ...(runtime
      ? [
          runtime.exited.then((reason) => {
            throw new DaemonError(
              `smolvm ${reason}, so amika-hostd stopped too; see ${paths.smolvmLogFile}`,
            );
          }),
        ]
      : []),
  ]);
  // Handled below; this only keeps a smolvm exit after `afterStart` throws
  // from being reported as an unhandled rejection.
  shutdown.catch(() => {});
  try {
    if (afterStart) await Promise.race([afterStart(port), shutdown]);
    await shutdown;
  } finally {
    await stopAll();
  }
}

async function startSmolvm(
  config: HostdConfigWith<"secretKey">,
  paths: DaemonPaths,
  deps: CliDeps,
  signal: AbortSignal,
): Promise<ManagedSmolvm | undefined> {
  const runtime = await (deps.startSmolvm ?? startSmolvmServe)(
    config.smolApiUrl,
    paths,
    withoutEnv(deps.env, [...ENV_NAMES.apiKey, ...ENV_NAMES.secretKey]),
    { signal },
  );
  if (runtime !== undefined && !signal.aborted) {
    deps.out(
      `smolvm serving at ${runtime.apiUrl} (pid ${runtime.pid}); logs: ${paths.smolvmLogFile}`,
    );
  }
  return runtime;
}

async function listen(
  config: HostdConfigWith<"secretKey">,
  servicesFile: string,
  deps: CliDeps,
): Promise<RunningServer> {
  // Machines run through the `smol` provider, on the smolvm this daemon
  // started (or `SMOL_API_URL`, for plain `serve`).
  const runtime = providerRuntime({
    apiUrl: config.smolApiUrl ?? DEFAULT_SMOL_API_URL,
    requestTimeoutMs: config.smolRequestTimeoutMs,
  });
  try {
    return await (deps.startServer ?? startServerOnPort)(config, runtime, {
      servicesFile,
    });
  } catch (error) {
    throw new DaemonError(
      `cannot listen on ${config.host}:${config.port}: ${errorCode(error)}`,
    );
  }
}

async function stopSmolvm(runtime: ManagedSmolvm | undefined, deps: CliDeps) {
  if (!runtime?.running) return;
  deps.out(`Stopping smolvm (pid ${runtime.pid}) and its machines`);
  if (!(await runtime.stop())) {
    deps.err(
      `amika-hostd: smolvm (pid ${runtime.pid}) is still stopping its machines; \`amika-hostd down\` waits for it`,
    );
  }
}

/** Long enough for the daemon's own shutdown, which includes smolvm's. */
const DOWN_TIMEOUT_MS = SHUTDOWN_GRACE_MS + SMOLVM_STOP_TIMEOUT_MS + 5_000;

/**
 * Stop the daemon, which stops its smolvm, and then any smolvm a daemon left
 * behind (one that was killed, or gave up waiting for smolvm to exit).
 */
async function down(deps: CliDeps): Promise<number> {
  const paths = daemonPaths(deps.env);
  const stop = deps.stopProcess ?? stopProcessByPid;
  const isDaemon = deps.isRunning ?? isDaemonProcess;
  const isSmolvm = deps.isSmolvmRunning ?? isSmolvmProcess;
  const daemon = readRunningPid(paths.pidFile, isDaemon);
  const unconfirmed = readRunningPid(paths.pidFile, isDaemonRunning);
  if (daemon === undefined && unconfirmed !== undefined) {
    // `up` refuses to start while this pidfile names a live process.
    deps.err(
      `amika-hostd: ${paths.pidFile} names pid ${unconfirmed}, which is not amika-hostd; remove it if it is stale`,
    );
  }
  if (daemon !== undefined) {
    deps.out(`Stopping amika-hostd (pid ${daemon})`);
    if (!(await stop(daemon, isDaemon, { timeoutMs: DOWN_TIMEOUT_MS }))) {
      throw new DaemonError(
        `amika-hostd (pid ${daemon}) did not exit within ${DOWN_TIMEOUT_MS / 1000}s; see ${paths.logFile}`,
      );
    }
  }
  const smolvm = readRunningPid(paths.smolvmPidFile, isSmolvm);
  if (smolvm !== undefined) {
    deps.out(`Stopping smolvm (pid ${smolvm}) and its machines`);
    const timeoutMs = SMOLVM_STOP_TIMEOUT_MS;
    if (!(await stop(smolvm, isSmolvm, { timeoutMs }))) {
      throw new DaemonError(
        `smolvm (pid ${smolvm}) is still stopping its machines after ${timeoutMs / 1000}s; see ${paths.smolvmLogFile}, and run \`amika-hostd down\` again to keep waiting`,
      );
    }
    // No daemon is left to remove them when smolvm exits.
    removeSmolvmFiles(paths, smolvm);
  } else {
    // Left by a run that never got to clean up (a reboot, say).
    removeStaleSmolvmFiles(paths);
  }
  const stopped = [
    ...(daemon === undefined ? [] : ["amika-hostd"]),
    ...(smolvm === undefined ? [] : ["smolvm"]),
  ];
  deps.out(
    stopped.length === 0
      ? "amika-hostd is not running"
      : `Stopped ${stopped.join(" and ")}`,
  );
  return 0;
}

/** The daemon's local address as a URL, bracketing an IPv6 literal. */
function localUrl(host: string, port: number): string {
  return `http://${isIPv6(host) ? `[${host}]` : host}:${port}`;
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "unknown error";
}

function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
}
