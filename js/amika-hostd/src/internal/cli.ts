/** Parse `amika-hostd` commands and run them against injectable effects. */
import { isIPv6 } from "node:net";
import { parseArgs } from "node:util";
import {
  AmikaApiError,
  HostTransportConflictError,
  registerHost as registerHostWithAmika,
  setHostSecret as setHostSecretInAmika,
  setHostSizes as setHostSizesInAmika,
  setHostTransport as setHostTransportInAmika,
  setHostUrl as setHostUrlInAmika,
  type RegisteredHost,
} from "./amika-api.js";
import {
  ConfigError,
  DEFAULT_HOST,
  DEFAULT_PORT,
  ENV_NAMES,
  configFilePaths,
  loadConfigFile as loadConfigFileFromDisk,
  requireSettings,
  resolveConfig,
  type HostdConfig,
  type HostdConfigFile,
  type HostdConfigWith,
  type HostdFlags,
} from "./config.js";
import path from "node:path";
import { openSecrets as openSecretStore, type Secrets } from "./credentials.js";
import { startTunnel as startTunnelOut } from "./tunnel-runner.js";
import { readTunnelEnrolment, tunnelEnrolmentPath } from "./tunnel-target.js";
import { enrolForTunnel, type EnrolForTunnelDeps } from "./tunnel-enrol.js";
import type { TunnelEvent } from "./tunnel-client.js";
import {
  DaemonError,
  claimPidFile as claimPidFileOnDisk,
  daemonPaths,
  ensureNotRunning,
  isDaemonProcess,
  isDaemonRunning,
  isSmolvmRunning as isSmolvmProcess,
  notifyReady as notifyParent,
  receiveSecrets as receiveSecretsFromUp,
  type HandedSecrets,
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
import {
  PREPULL_TIMEOUT_MS,
  SMOLVM_SEED_MIN_DISK_GIB,
  pendingImages,
  prepullImages,
  prepullMachines,
  errorMessage,
  type ConfiguredImage,
  type PrepullOptions,
} from "./prepull.js";
import { versionText } from "./build-info.js";
import { PromptCancelled, type Prompt } from "./prompt.js";
import { runSetup, withoutInvalidSecret, type SetupDeps } from "./setup.js";
import { setupSkill, type SkillContext } from "./setup-skill.js";
import {
  DEFAULT_SMOL_API_URL,
  MIN_SMOLVM_VERSION,
  SMOLVM_STOP_TIMEOUT_MS,
  isOlderVersion,
  smolvmVersion as readSmolvmVersion,
  startSmolvm as startSmolvmServe,
  type ManagedSmolvm,
} from "./smolvm-serve.js";
import { isLoopbackHost } from "@amika/service-auth/gateway";

export const USAGE = `Usage: amika-hostd <command> [options]

Commands:
  setup               Set this host's hostname, secret key and Amika API key,
                      and write default rig sizes to the config file
  up                  Register this host with Amika, then start smolvm and the
                      daemon in the background (running setup first if needed).
                      The daemon dials out to Amika's gateway unless the config
                      sets transport = "listen"
  down                Stop the daemon and its smolvm, which stops every machine
  status              Say whether the daemon is running; exits 0 if it is, 3 if
                      it is not
  serve               Run the HTTP server in the foreground without registering
  register-url <url>  Set a listening host's internet-facing URL (e.g. an
                      ngrok or Cloudflare Tunnel URL) to complete its
                      registration. A host whose address Amika assigns takes
                      none
  version             Print version information

Options:
  --non-interactive
                 (setup) Ask nothing: take the hostname from --hostname (else
                 the configured one, or this machine's), the API key from
                 stdin when none is stored, and keep any secret key
  --hostname <name>
                 (setup --non-interactive) This host's name in Amika
  --skill        (setup) Print how an AI agent sets up this host
  --fg           (up) Stay in the foreground instead of backgrounding
  --smolvm       (serve) Also start smolvm, and stop it on exit, as \`up\` does
  --port <port>  Port a listening daemon binds (AMIKA_HOSTD_PORT, TOML port;
                 default 3020)
  --host <host>  Address a listening daemon binds (AMIKA_HOSTD_HOST, TOML
                 host; default 127.0.0.1)
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
  /** Serves over a tunnel instead of a port; defaults to `startTunnel`. */
  startTunnel?: typeof startTunnelOut;
  startInBackground?: typeof spawnInBackground;
  startSmolvm?: typeof startSmolvmServe;
  /** The installed smolvm's version, for `up`'s warning about an old one. */
  smolvmVersion?: (env: NodeJS.ProcessEnv) => Promise<string | undefined>;
  /**
   * Make sure the preset images are in smolvm's cache, once the daemon that
   * started smolvm is ready; defaults to `prepullImages` on that smolvm.
   */
  prepull?: (
    apiUrl: string,
    options: Omit<PrepullOptions, "runtime">,
  ) => Promise<void>;
  stopProcess?: typeof stopProcessByPid;
  isSmolvmRunning?: (pid: number) => boolean;
  claimPidFile?: typeof claimPidFileOnDisk;
  notifyReady?: typeof notifyParent;
  isRunning?: (pid: number) => boolean;
  registerHost?: typeof registerHostWithAmika;
  setHostSizes?: typeof setHostSizesInAmika;
  setHostTransport?: typeof setHostTransportInAmika;
  setHostSecret?: typeof setHostSecretInAmika;
  setHostUrl?: typeof setHostUrlInAmika;
  /**
   * Ask the operator a question (see `Prompt`). Absent when stdin or stdout
   * is not a terminal, so `up` never blocks.
   */
  prompt?: Prompt;
  /** `prompt` without echoing the answer; absent without a terminal. */
  promptSecret?: Prompt;
  /** All of stdin, for `setup --non-interactive`'s API key. */
  readStdin?: () => Promise<string>;
  /** Opens the secret store the config chose; defaults to `openSecrets`. */
  openSecrets?: (
    kind: HostdConfig["secretStore"],
    env: NodeJS.ProcessEnv,
  ) => Secrets;
  /** How a background daemon gets the secret key from the `up` that started it. */
  receiveSecrets?: () => Promise<HandedSecrets>;
  writeConfigFile?: SetupDeps["writeConfigFile"];
  systemHostname?: SetupDeps["systemHostname"];
  generateSecretKey?: SetupDeps["generateSecretKey"];
  /** Tunnel enrolment; defaults to the control plane and the record file. */
  enrol?: EnrolForTunnelDeps["enrol"];
  write?: EnrolForTunnelDeps["write"];
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
    if (parsed.command === "version") {
      deps.out(versionText());
      return 0;
    }
    // Stopping and checking need only the pidfiles, not a valid configuration.
    if (parsed.command === "down") return await down(deps);
    if (parsed.command === "status") return status(deps);
    if (parsed.command === "setup") {
      if (parsed.skill) {
        deps.out(setupSkill(skillContext(deps)));
        return 0;
      }
      return await setup(
        parsed.nonInteractive
          ? { ...deps, ...unattended(deps, parsed.hostname) }
          : deps,
      );
    }
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
        warnUncachedSizes(config, deps);
        // Alongside registration, so a slow smolvm never delays it.
        const checkedSmolvm = warnOldSmolvm(deps);
        const host = await register(config, deps);
        if (config.transport === "tunnel") await enrol(config, host, deps);
        await checkedSmolvm;
        // Read before the daemon starts, which records each image it pulls.
        const pending = pendingImages(
          config.images,
          daemonPaths(deps.env).prepullFile,
        );
        // Start the daemon first, so the operator can expose it (and check the
        // tunnel reaches it) before giving Amika its public URL.
        const finish = (port: number | undefined) => {
          announcePrepull(pending, deps, { foreground: parsed.fg });
          return completeRegistration(config, host, port, deps);
        };
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
        // A daemon `up` started gets its secrets from it; run by hand, it
        // reads the secret store itself.
        const handed = parsed.secretKeyFromUp
          ? await (deps.receiveSecrets ?? receiveSecretsFromUp)()
          : undefined;
        const config =
          handed === undefined
            ? placedSecrets(
                withSecrets(resolved, deps, { apiKey: false }),
                deps,
              )
            : { ...resolved, secretKey: handed.secretKey };
        await serveInForeground(requireSettings(config, ["secretKey"]), deps, {
          smolvm: parsed.smolvm,
          tunnelSecrets: handed && handedTunnelSecrets(handed),
        });
        break;
      }
      case "register-url": {
        const config = requireSettings(
          placedSecrets(withSecrets(resolved, deps), deps),
          REGISTRATION_SETTINGS,
        );
        const host = await register(config, deps);
        // The API refuses this for a host whose address it assigns, so say
        // which host and why rather than relaying a 400 the operator has to
        // decode. Same "not a listener" test as `up`.
        if (host.transport_mode !== "listen") {
          throw new AmikaApiError(
            `Amika assigns the address of host ${host.hostname}; it takes no registered URL.`,
          );
        }
        await saveUrl(config, host, parsed.url, deps);
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
  | {
      help: false;
      command: "setup";
      skill: boolean;
      nonInteractive: boolean;
      hostname?: string;
    }
  | { help: false; command: "up"; fg: boolean; flags: HostdFlags }
  | { help: false; command: "down" }
  | { help: false; command: "status" }
  | { help: false; command: "version" }
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

/**
 * Answers to setup's questions for `setup --non-interactive`: the hostname
 * given (else the default), the API key from stdin, and the default to every
 * yes/no question, which is no, so a secret key is never regenerated or
 * replaced. A question asked twice means the first answer was refused, so
 * it ends setup instead of repeating.
 */
function unattended(
  deps: CliDeps,
  hostname: string | undefined,
): Pick<CliDeps, "prompt" | "promptSecret"> {
  const asked = new Set<string>();
  const first = (question: string) => {
    if (asked.has(question)) return false;
    asked.add(question);
    return true;
  };
  let stdin: Promise<string> | undefined;
  return {
    prompt: async (question) => {
      if (!question.startsWith("Hostname")) return "";
      if (first(question)) return hostname ?? "";
      deps.err("amika-hostd: pass this host's name with --hostname");
      return undefined;
    },
    promptSecret: async (question) => {
      if (first(question)) {
        return (stdin ??= (deps.readStdin ?? readAllStdin)()).then((key) =>
          key.trim(),
        );
      }
      deps.err(
        "amika-hostd: pipe the Amika API key into `amika-hostd setup --non-interactive`",
      );
      return undefined;
    },
  };
}

async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
}

/**
 * What `setup --skill` names, from this host's config where it can be read.
 * It needs no valid config: anything unreadable falls back to the defaults.
 */
function skillContext(deps: CliDeps): SkillContext {
  let file: HostdConfigFile | undefined;
  try {
    file = (deps.loadConfigFile ?? loadConfigFileFromDisk)(deps.env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
  }
  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;
  try {
    ({ host, port } = resolveTolerant(deps));
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
  }
  // A daemon bound to every interface is reached here through loopback.
  const reachable =
    host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  return {
    configPath: file?.path ?? configFilePaths(deps.env)[0],
    logFile: daemonPaths(deps.env).logFile,
    localUrl: localUrl(reachable, port),
  };
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
        "non-interactive": { type: "boolean" },
        hostname: { type: "string" },
        skill: { type: "boolean" },
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
      if (values.hostname !== undefined && !values["non-interactive"]) {
        throw new UsageError("--hostname needs --non-interactive");
      }
      if (values.skill && values["non-interactive"]) {
        throw new UsageError(
          "--skill and --non-interactive do not go together",
        );
      }
      return {
        help: false,
        command,
        skill: values.skill ?? false,
        nonInteractive: values["non-interactive"] ?? false,
        hostname: values.hostname,
      };
    case "up":
      rejectOptions(command, values, [
        ...SETUP_ONLY,
        "smolvm",
        "secret-key-from-up",
      ]);
      expectArguments(rest, 0);
      return { help: false, command, fg: values.fg ?? false, flags };
    case "down":
    case "status":
    case "version":
      rejectOptions(command, values, [
        ...SETUP_ONLY,
        "fg",
        "smolvm",
        "port",
        "host",
        "secret-key-from-up",
      ]);
      expectArguments(rest, 0);
      return { help: false, command };
    case "serve":
      rejectOptions(command, values, [...SETUP_ONLY, "fg"]);
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
        ...SETUP_ONLY,
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

/** Options only `setup` takes. */
const SETUP_ONLY = ["non-interactive", "hostname", "skill"] as const;

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
 * hostname, secret, sizes and transport are sent; an existing host's secret is
 * never changed, but its sizes and transport are brought to the configured
 * ones.
 */
async function register(
  config: RegistrationConfig,
  deps: CliDeps,
): Promise<RegisteredHost> {
  const api = { apiUrl: config.apiUrl, apiKey: config.apiKey };
  const { sizes } = config;
  const { host, created } = await registerInTransport(config, deps);
  if (created) {
    deps.out(
      `Registered host ${host.hostname} with ${config.apiUrl} (${host.id})`,
    );
  } else {
    deps.out(
      `Host ${host.hostname} is already registered with ${config.apiUrl} (${host.id})`,
    );
    // Registration never changes an existing host's secret (see
    // docs/commands-and-registration.md#registration).
    deps.out(
      "Amika keeps the secret key stored when the host was first registered; if yours has changed since, Amika's requests to this host will be rejected.",
    );
    // Nor its sizes, so bring those up to date with the config separately.
    await (deps.setHostSizes ?? setHostSizesInAmika)(api, host, sizes);
    deps.out(
      `Updated the sizes of host ${host.hostname} (${describeSizes(sizes)})`,
    );
  }
  if (host.transport_mode === config.transport) return host;
  // The config is the source of truth for the transport, as for sizes.
  // Amika refuses to change it on registration, so change it here, before
  // anything relies on it: enrolment refuses a host not yet in the tunnel.
  const switched = await (deps.setHostTransport ?? setHostTransportInAmika)(
    api,
    host,
    config.transport,
  );
  deps.out(
    `Switched host ${host.hostname} from ${host.transport_mode} to ${config.transport} mode`,
  );
  return switched;
}

/**
 * Register in the configured transport, so a new host is created in it. A
 * host Amika already has in another transport is refused rather than
 * returned, so register it again without one to learn which host it is;
 * `register` then moves it.
 */
async function registerInTransport(
  config: RegistrationConfig,
  deps: CliDeps,
): Promise<{ host: RegisteredHost; created: boolean }> {
  const api = { apiUrl: config.apiUrl, apiKey: config.apiKey };
  const input = {
    hostname: config.hostname,
    secretKey: config.secretKey,
    sizes: config.sizes,
  };
  const registerHost = deps.registerHost ?? registerHostWithAmika;
  try {
    return await registerHost(api, {
      ...input,
      transportMode: config.transport,
    });
  } catch (error) {
    if (!(error instanceof HostTransportConflictError)) throw error;
    return registerHost(api, input);
  }
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
 * Registration is complete once Amika knows how it reaches the host. For a
 * tunnelled host that is already true the moment it is registered, since
 * Amika assigns the address. For a listening one it means its
 * internet-facing URL: without it, ask the operator to expose the daemon and
 * enter the public URL (or say how to finish without a terminal); with it,
 * remind them where Amika expects to reach it. Returns false if saving the
 * URL failed; the daemon keeps running either way.
 */

/**
 * Serve this host by dialling the gateway, and wait until it has.
 *
 * The counterpart of `listen`. It returns only once the gateway has kept
 * the connection, because `up` reports readiness from this and a daemon
 * that said "serving" while still retrying would send an operator
 * looking for the rig rather than for the reason it cannot attach.
 *
 * A dial that never succeeds therefore fails startup, with whatever
 * `resolveTunnelTarget` or the client said -- which names the missing
 * enrolment, the missing credential, or the gateway's refusal.
 */
async function dialOut(
  config: HostdConfigWith<"secretKey">,
  paths: DaemonPaths,
  usedPrepullNames: ReadonlySet<string>,
  deps: CliDeps,
  {
    secrets: handed,
    ...packing
  }: {
    smolvm?: string;
    signal: AbortSignal;
    /** What `up` handed a background daemon; else the store is opened. */
    secrets?: Pick<Secrets, "attachmentCredential">;
  },
): Promise<{
  port?: undefined;
  connectionId?: string;
  close: () => Promise<void>;
}> {
  // The same provider runtime a listener uses: a tunnel changes how the
  // daemon is reached, not what it runs.
  const runtime = providerRuntime({
    apiUrl: config.smolApiUrl ?? DEFAULT_SMOL_API_URL,
    requestTimeoutMs: config.smolRequestTimeoutMs,
  });
  const secrets =
    handed ??
    (deps.openSecrets ?? openSecretStore)(config.secretStore, deps.env);
  const enrolmentFile = enrolmentFileFor(config, deps);
  const tunnel = (deps.startTunnel ?? startTunnelOut)(
    config,
    runtime,
    secrets,
    () => readTunnelEnrolment(enrolmentFile),
    {
      ...handlerOptions(config, paths, usedPrepullNames, deps, packing),
      // For the life of the daemon, not just startup: a tunnel that drops,
      // or that the gateway later refuses, must say so in the log.
      onEvent: (event) => logTunnelEvent(event, deps),
    },
  );
  try {
    // A shutdown during startup ends the wait at once, rather than after
    // the attach timeout while the gateway is unreachable.
    const attached = await Promise.race([
      tunnel.whenAttached(),
      abortedBy(packing.signal),
    ]);
    return {
      connectionId: attached.connectionId,
      close: () => tunnel.close(),
    };
  } catch (error) {
    // Nothing is serving, so leave nothing dialling behind.
    await tunnel.close();
    if (packing.signal.aborted) return { close: async () => {} };
    throw error;
  }
}

/**
 * Enrol a tunnel host with its gateway: the credential into the secret
 * store, and the gateway's address and generation into the record beside
 * the config.
 *
 * On every `up`, right after registering, and not only when setup rotates
 * the secret key: a host set up fresh, or one whose operator kept the key,
 * would otherwise never be enrolled and could not dial. Repeating it is
 * harmless, because Amika answers with the credential it already holds.
 *
 * After registering, because enrolment names the host, and apart from the
 * secret key's rotation, so a failure here never rolls back a key Amika
 * has already taken.
 */
async function enrol(
  config: RegistrationConfig,
  host: RegisteredHost,
  deps: CliDeps,
): Promise<void> {
  const enrolment = await enrolForTunnel(
    { apiUrl: config.apiUrl, apiKey: config.apiKey },
    host,
    (deps.openSecrets ?? openSecretStore)(config.secretStore, deps.env),
    enrolmentFileFor(config, deps),
    deps,
  );
  deps.out(
    `Enrolled host ${host.hostname} for tunnel mode; it will dial ${enrolment.gatewayUrl}`,
  );
}

/**
 * Where this host's enrolment record lives: beside the config it loaded,
 * where setup writes it and `credentials.ts` keeps file secrets. The first
 * candidate path only when no config file was loaded at all, as setup
 * would then write there too.
 */
function enrolmentFileFor(
  config: { configPath?: string },
  deps: Pick<CliDeps, "env">,
): string {
  return tunnelEnrolmentPath(
    path.dirname(config.configPath ?? configFilePaths(deps.env)[0]),
  );
}

/**
 * A read-only store holding the tunnel credential `up` handed over IPC, so
 * a background daemon never opens the secret store itself.
 */
function handedTunnelSecrets(
  handed: HandedSecrets,
): Pick<Secrets, "attachmentCredential"> {
  return {
    attachmentCredential: {
      description: "what `amika-hostd up` handed this daemon",
      get: () => handed.attachmentCredential,
      set: () => {
        throw new Error("a background daemon never writes the secret store");
      },
    },
  };
}

/** Rejects when `signal` aborts; never resolves. */
function abortedBy(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const abort = () => reject(new Error("shutdown requested"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

/**
 * What the tunnel did, in the daemon's log. Dialling is left out: a retry
 * says why it is waiting, and an attachment says it attached.
 */
function logTunnelEvent(event: TunnelEvent, deps: CliDeps): void {
  switch (event.type) {
    case "dialing":
    case "stopped":
      return;
    case "attached":
      deps.out(
        `amika-hostd: attached to the gateway${event.info.connectionId ? ` (connection ${event.info.connectionId})` : ""}`,
      );
      return;
    case "detached":
      deps.err(
        `amika-hostd: the tunnel to the gateway closed after ${Math.round(event.uptimeMs / 1000)}s: ${event.reason}`,
      );
      return;
    case "waiting":
      deps.err(
        `amika-hostd: reconnecting to the gateway in ${Math.round(event.delayMs / 1000)}s (attempt ${event.attempt}): ${event.reason}`,
      );
      return;
    case "suspect-credential":
      deps.err(
        `amika-hostd: ${event.consecutiveShortSessions} tunnels in a row closed before serving anything; this host's credential may have been revoked. Run \`amika-hostd up\` to enrol it again.`,
      );
      return;
    case "rejected":
      deps.err(
        `amika-hostd: the gateway refused this host and it will not retry: ${event.reason}`,
      );
      return;
    default:
      assertNever(event);
  }
}

async function completeRegistration(
  config: RegistrationConfig,
  host: RegisteredHost,
  /** Absent on a tunnel host, which binds nothing. */
  port: number | undefined,
  deps: CliDeps,
): Promise<boolean> {
  // Only a listening host registers a URL. Amika assigns the address of one
  // it reaches any other way, and `register-url` on such a host is refused,
  // so there is nothing here for the operator to finish; asking would walk
  // them into the single action the transport forbids. Tested as "not a
  // listener" so a transport added later is left to the control plane
  // rather than being handed that same advice.
  if (host.transport_mode !== "listen") {
    deps.out(
      `Amika assigns this host's address; it needs no public URL and nothing exposed.`,
    );
    // Not the same as saying the host is reachable. This daemon serves
    // locally and has no way to know whether a gateway has picked it up, so
    // it does not claim one has.
    deps.out(
      `Amika reports whether it can reach the host; this daemon does not.`,
    );
    return true;
  }
  // Below the guard, because a tunnel host has no port to build one from
  // and returns above. A listener without one is this file disagreeing
  // with itself rather than anything the operator did.
  if (port === undefined) {
    throw new Error("A listening host reported no port to register");
  }
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
  const problem = previewRoutingProblem(url);
  if (problem) deps.err(`amika-hostd: ${problem}`);
}

/**
 * Why a browser cannot open a preview at public URL `url`, or undefined when
 * it can. A preview needs a browser login, whose cookies a browser keeps only
 * at the root of an https origin of hostd's own: it drops a `Secure` one over
 * plain http, and hostd sets none on a loopback address or an explicit port,
 * since a host's cookies are shared across its ports. The preview cookie also
 * routes a page's root-relative URLs (`/_next/...`, `/@vite/client`), which
 * needs every root path of the origin to reach hostd. Scripts still reach
 * services with a service token, so the URL is kept and the operator warned.
 */
function previewRoutingProblem(url: string): string | undefined {
  const { protocol, hostname, port, pathname } = new URL(url);
  if (pathname !== "/") {
    return `${url} serves hostd under ${pathname}, so browsers cannot open this host's previews; give hostd the root of its own https origin, as ngrok and cloudflared give.`;
  }
  if (isLoopbackHost(hostname)) {
    return `hostd sets no browser login cookie on a loopback address, which every local server shares, so browsers cannot open this host's previews; use an https URL, as ngrok and cloudflared give.`;
  }
  if (port !== "") {
    return `hostd sets no browser login cookie on an explicit port (${port}), since a browser shares a host's cookies across its ports, so browsers cannot open this host's previews; give hostd a hostname of its own on the default https port, as ngrok and cloudflared give.`;
  }
  if (protocol === "http:") {
    return `browsers drop hostd's login cookie over plain http, so they cannot open this host's previews; use an https URL, as ngrok and cloudflared give.`;
  }
  return undefined;
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
      // Read here, where a keychain prompt can reach the operator, and
      // handed over with the secret key.
      attachmentCredential:
        config.transport === "tunnel"
          ? (deps.openSecrets ?? openSecretStore)(
              config.secretStore,
              deps.env,
            ).attachmentCredential.get()
          : undefined,
    },
  );
  deps.out(
    port === undefined
      ? `amika-hostd started in the background over a tunnel (pid ${pid})`
      : `amika-hostd started in the background on port ${port} (pid ${pid})`,
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
    tunnelSecrets,
  }: {
    smolvm?: boolean;
    afterStart?: (port: number | undefined) => Promise<unknown>;
    /**
     * The tunnel credential `up` handed this daemon. Absent when the
     * daemon runs by hand, and reads the secret store itself.
     */
    tunnelSecrets?: Pick<Secrets, "attachmentCredential">;
  } = {},
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
  /**
   * Whichever transport this host serves on.
   *
   * A listener reports the port it bound; a tunnel reports none, because
   * it binds nothing. Everything after startup needs only `close`.
   */
  let server:
    | { port?: number; connectionId?: string; close: () => Promise<void> }
    | undefined;
  // Every throwaway machine name the pre-pull uses. Each is random, so
  // hiding them all, deleted or not, never hides a rig.
  const usedPrepullNames = new Set<string>();
  const stopAll = async () => {
    // However the daemon stops, not only on a signal, so the pre-pull never
    // goes on against a smolvm that is gone.
    interrupted.abort();
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
      // Only a daemon running its own smolvm can pack a snapshot: a pack
      // is a subprocess of that binary, reading the same machine state.
      server =
        config.transport === "tunnel"
          ? await dialOut(serving, paths, usedPrepullNames, deps, {
              smolvm: runtime?.binary,
              signal: interrupted.signal,
              secrets: tunnelSecrets,
            })
          : await listen(serving, paths, usedPrepullNames, deps, {
              smolvm: runtime?.binary,
              signal: interrupted.signal,
            });
    }
    // Signalled during startup: stop without telling `up` it is ready.
    if (server === undefined || interrupted.signal.aborted) {
      await stopAll();
      return;
    }
    if (server.port === undefined) {
      // Said once it is attached, not once it is dialling. `up` waits on
      // this, and an operator told "serving" by a daemon that is still
      // retrying would go looking for the rig rather than for the
      // reason it cannot attach.
      deps.out(
        "amika-hostd is serving over a tunnel; Amika assigns its address.",
      );
      await (deps.notifyReady ?? notifyParent)({
        connectionId: server.connectionId,
      });
    } else {
      deps.out(
        `amika-hostd listening on ${localUrl(config.host, server.port)}`,
      );
      await (deps.notifyReady ?? notifyParent)({ port: server.port });
    }
    // Only a daemon running its own smolvm fills that smolvm's image cache.
    if (runtime) {
      (deps.prepull ?? prepullOn)(runtime.apiUrl, {
        images: config.images,
        stateFile: paths.prepullFile,
        out: deps.out,
        err: deps.err,
        signal: interrupted.signal,
        used: usedPrepullNames,
      }).catch((error: unknown) => {
        // Never let the background pull take the daemon down with it.
        deps.err(
          `amika-hostd: pre-pulling images stopped: ${errorMessage(error)}`,
        );
      });
    }
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

/** `prepullImages` on the smolvm at `apiUrl`, waiting out a whole download. */
function prepullOn(
  apiUrl: string,
  options: Omit<PrepullOptions, "runtime">,
): Promise<void> {
  return prepullImages({
    ...options,
    runtime: providerRuntime({ apiUrl, requestTimeoutMs: PREPULL_TIMEOUT_MS }),
  });
}

/**
 * Tell the operator the daemon is downloading images it never pulled
 * before: on the first `up`, and again for an image added to the config, or
 * one whose earlier pull failed.
 */
function announcePrepull(
  pending: ConfiguredImage[],
  deps: CliDeps,
  { foreground }: { foreground: boolean },
) {
  if (pending.length === 0) return;
  const width = Math.max(
    ...pending.map(({ presets }) => presets.join(", ").length),
  );
  deps.out("");
  deps.out("Downloading this host's rig images in the background:");
  for (const { image, presets } of pending) {
    deps.out(`  ${presets.join(", ").padEnd(width)}  ${image}`);
  }
  deps.out(
    "Each is several GB. Once an image has downloaded, its rigs start without downloading it again; a rig created before then may take minutes, or time out.",
  );
  // In the foreground the daemon reports progress here, not in the log.
  deps.out(
    foreground
      ? "Progress is reported below."
      : `Progress: ${daemonPaths(deps.env).logFile}`,
  );
}

/**
 * smolvm caches an image only for rigs with at least its 20 GiB template
 * disk, so a smaller size downloads its image on every create.
 */
function warnUncachedSizes(config: HostdConfig, deps: CliDeps) {
  const small = Object.entries(config.sizes)
    .filter(([, size]) => size.diskGib < SMOLVM_SEED_MIN_DISK_GIB)
    .map(([name, size]) => `${name} (${size.diskGib} GiB)`);
  if (small.length === 0) return;
  deps.err(
    `amika-hostd: rigs of size ${small.join(", ")} download their image on every create, since smolvm caches images only for disks of at least ${SMOLVM_SEED_MIN_DISK_GIB} GiB; set disk_gib = ${SMOLVM_SEED_MIN_DISK_GIB} or more in ${config.configPath ?? "the config file"} to start them from the cache.`,
  );
}

/** Warn when smolvm's image cache does not yet serve every rig size. */
async function warnOldSmolvm(deps: CliDeps) {
  // smolvm never sees the API key or the secret key.
  const version = await (deps.smolvmVersion ?? readSmolvmVersion)(
    withoutEnv(deps.env, [...ENV_NAMES.apiKey, ...ENV_NAMES.secretKey]),
  );
  if (version === undefined || !isOlderVersion(version, MIN_SMOLVM_VERSION)) {
    return;
  }
  deps.err(
    `amika-hostd: smolvm ${version} is older than ${MIN_SMOLVM_VERSION}, so rigs with disks larger than 20 GiB download their image on every create; update it with \`curl -sSL https://smolmachines.com/install.sh | bash\`.`,
  );
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
  paths: DaemonPaths,
  usedPrepullNames: ReadonlySet<string>,
  deps: CliDeps,
  /** The smolvm a pack runs through, when this daemon started one. */
  packing: { smolvm?: string; signal?: AbortSignal } = {},
): Promise<RunningServer> {
  // Machines run through the `smol` provider, on the smolvm this daemon
  // started (or `SMOL_API_URL`, for plain `serve`).
  const runtime = providerRuntime({
    apiUrl: config.smolApiUrl ?? DEFAULT_SMOL_API_URL,
    requestTimeoutMs: config.smolRequestTimeoutMs,
  });
  try {
    return await (deps.startServer ?? startServerOnPort)(
      config,
      runtime,
      handlerOptions(config, paths, usedPrepullNames, deps, packing),
    );
  } catch (error) {
    throw new DaemonError(
      `cannot listen on ${config.host}:${config.port}: ${errorCode(error)}`,
    );
  }
}

/**
 * What the app serves beyond the machine API, the same whichever transport
 * reaches it: the services file, snapshots when this daemon runs its own
 * smolvm, and pre-pull's throwaway machines kept out of the list. A tunnel
 * changes how the daemon is reached, never what it serves, so both
 * `listen` and `dialOut` take these from here.
 */
function handlerOptions(
  config: HostdConfigWith<"secretKey">,
  paths: DaemonPaths,
  usedPrepullNames: ReadonlySet<string>,
  deps: CliDeps,
  packing: { smolvm?: string; signal?: AbortSignal },
) {
  return {
    servicesFile: paths.servicesFile,
    snapshots: packing.smolvm
      ? {
          directory: config.snapshotDir ?? paths.snapshotDir,
          indexFile: paths.snapshotIndexFile,
          smolvm: packing.smolvm,
          // As smolvm itself is started: never with the daemon's keys.
          env: withoutEnv(deps.env, [
            ...ENV_NAMES.apiKey,
            ...ENV_NAMES.secretKey,
          ]),
          err: deps.err,
          signal: packing.signal,
        }
      : undefined,
    // This run's throwaway machines, deleted or not, so a list caught
    // mid-create or mid-delete still hides them, and any an earlier run
    // left behind.
    hiddenMachines: () =>
      new Set([...usedPrepullNames, ...prepullMachines(paths.prepullFile)]),
  };
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
  if (daemon === undefined) reportForeignPid(paths.pidFile, deps);
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

/**
 * Warn when the pidfile names a live process not confirmed as amika-hostd,
 * since `up` refuses to start while it does.
 */
function reportForeignPid(pidFile: string, deps: CliDeps): void {
  const pid = readRunningPid(pidFile, isDaemonRunning);
  if (pid === undefined) return;
  deps.err(
    `amika-hostd: ${pidFile} names pid ${pid}, which is not amika-hostd; remove it if it is stale`,
  );
}

/** Exit code of `status` when the daemon is down, as LSB init scripts use. */
const NOT_RUNNING_EXIT = 3;

/**
 * Say whether the daemon is up, by the same pidfile checks `down` makes, and
 * exit 0 if it is. A smolvm left without its daemon is mentioned, since
 * `down` is what stops it.
 */
function status(deps: CliDeps): number {
  const paths = daemonPaths(deps.env);
  const isDaemon = deps.isRunning ?? isDaemonProcess;
  const isSmolvm = deps.isSmolvmRunning ?? isSmolvmProcess;
  const daemon = readRunningPid(paths.pidFile, isDaemon);
  const smolvm = readRunningPid(paths.smolvmPidFile, isSmolvm);
  if (daemon === undefined) {
    reportForeignPid(paths.pidFile, deps);
    deps.out("amika-hostd is not running");
    if (smolvm !== undefined) {
      deps.out(
        `smolvm (pid ${smolvm}) is still running without it; \`amika-hostd down\` stops it`,
      );
    }
    return NOT_RUNNING_EXIT;
  }
  deps.out(`amika-hostd is running (pid ${daemon})`);
  if (smolvm !== undefined) deps.out(`smolvm is running (pid ${smolvm})`);
  deps.out(`Log: ${paths.logFile}`);
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
