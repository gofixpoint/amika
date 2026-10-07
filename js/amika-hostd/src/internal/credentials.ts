/**
 * Where hostd keeps its secrets: the Amika API key `amika-hostd setup` asks
 * for, and the secret key Amika presents to the daemon. By default
 * (`DEFAULT_SECRET_STORE`) they live in the system keychain; with
 * `secret_store = "file"` they live in plain files only their owner can
 * read. The two are never mixed: a read never
 * falls back from one to the other, so a key left in one cannot shadow a
 * newer one in the other.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ConfigError,
  ENV_NAMES,
  configFilePaths,
  type SecretStoreKind,
} from "./config.js";
import { writePrivateFile } from "./private-file.js";

/** One stored secret. Messages name it by `description`. */
export interface Secret {
  readonly description: string;
  get(): string | undefined;
  set(value: string): void;
}

/** The secrets this host keeps, in the store the config chose. */
export interface Secrets {
  readonly kind: SecretStoreKind;
  readonly apiKey: Secret;
  /**
   * In the keychain, the secret key is a keychain item. With the file store
   * it is `secret_key` in config.toml, which setup writes with the rest of
   * the config, so there is no separate secret here.
   */
  readonly secretKey?: Secret;
}

/**
 * A system keychain holding hostd's items by name. Each method throws
 * `ConfigError` when the keychain cannot be used (locked, say); `get` returns
 * `undefined` only when it is sure the item is not there.
 */
export interface Keychain {
  readonly description: string;
  get(name: SecretName): string | undefined;
  set(name: SecretName, value: string): void;
}

export type SecretName = "api-key" | "secret-key";

export interface CredentialDeps {
  /** The system keychain; defaults to this platform's (see `systemKeychain`). */
  keychain?: Keychain | null;
  platform?: NodeJS.Platform;
  /** Runs the keychain's command-line tool. */
  run?: Runner;
  readFile?: (file: string) => string;
  writeFile?: (file: string, contents: string) => void;
}

/** The result of running a program, as `spawnSync` reports it. */
export interface RunResult {
  status: number | null;
  stdout: string;
  stderr?: string;
  /** The signal that killed it, e.g. `SIGINT` from the operator's Ctrl-C. */
  signal?: NodeJS.Signals | null;
  error?: Error;
}

export type Runner = (
  command: string,
  args: readonly string[],
  input?: string,
) => RunResult;

/**
 * A keychain command was killed by Ctrl-C. The terminal sends it to the
 * whole foreground process group, so it reaches the keychain program too.
 */
export class KeychainInterrupted extends ConfigError {
  override name = "KeychainInterrupted";
}

const SERVICE = "amika-hostd";
const LABELS: Record<SecretName, string> = {
  "api-key": "Amika API key for amika-hostd",
  "secret-key": "amika-hostd secret key",
};
/** Long enough for a keychain to ask the operator to unlock it. */
const KEYCHAIN_TIMEOUT_MS = 60_000;

/**
 * API keys are sent as bearer tokens, so keep them to printable ASCII without
 * spaces, quotes or backslashes.
 */
export function isValidApiKey(value: string): boolean {
  return /^[\x21-\x7e]+$/.test(value) && !/["'\\]/.test(value);
}

/** The file the API key is kept in with the file store: the user config dir. */
export function apiKeyFilePath(env: NodeJS.ProcessEnv): string {
  return path.join(path.dirname(configFilePaths(env)[0]), "api-key");
}

/**
 * Open the secret store the config chose. The keychain store needs a system
 * keychain; without one it refuses, naming the setting that chooses files,
 * rather than keep secrets in plain files nobody asked for.
 */
export function openSecrets(
  kind: SecretStoreKind,
  env: NodeJS.ProcessEnv,
  deps: CredentialDeps = {},
): Secrets {
  if (kind === "file") {
    return { kind, apiKey: fileSecret(apiKeyFilePath(env), deps) };
  }
  const keychain =
    deps.keychain === undefined ? systemKeychain(env, deps) : deps.keychain;
  if (!keychain) {
    throw new ConfigError(
      `No keychain on this machine to keep amika-hostd's secrets in. To keep them in files only you can read instead, set \`secret_store = "file"\` in ${configFilePaths(env)[0]}, or ${ENV_NAMES.secretStore[0]}=file`,
    );
  }
  const item = (name: SecretName, what: string): Secret => ({
    description: `${keychain.description} (${what})`,
    get: () => keychain.get(name),
    set: (value) => keychain.set(name, value),
  });
  return {
    kind,
    apiKey: item("api-key", "Amika API key"),
    secretKey: item("secret-key", "secret key"),
  };
}

/** This platform's keychain, if amika-hostd supports one here. */
function systemKeychain(
  env: NodeJS.ProcessEnv,
  deps: CredentialDeps,
): Keychain | undefined {
  const run = deps.run ?? runProgram;
  switch (deps.platform ?? process.platform) {
    case "darwin":
      return macOSKeychain(run);
    case "linux":
      // The Secret Service lives on the session's D-Bus. Without a session bus
      // (no desktop or user session) there is no keychain. With one but no
      // keyring daemon on it, as over SSH to a server, secret-tool says so.
      return env.DBUS_SESSION_BUS_ADDRESS?.trim()
        ? secretServiceKeychain(run)
        : undefined;
    default:
      return undefined;
  }
}

/**
 * The macOS login keychain, through `security`. Items are generic passwords
 * under service `amika-hostd`, one account per secret. Every command names
 * the login keychain: without one, `security` uses the default keychain,
 * which a user can change to another (separately locked, or temporary) one.
 */
function macOSKeychain(run: Runner): Keychain {
  const description = "your macOS login keychain";
  const refuse = (what: string) =>
    new ConfigError(
      `Cannot ${what} ${description}; unlock it and run \`amika-hostd setup\` again, or set \`secret_store = "file"\` to keep secrets in files`,
    );
  let loginKeychain: string | undefined;
  /** The login keychain's path, as `security login-keychain` prints it. */
  const login = (): string => {
    if (loginKeychain !== undefined) return loginKeychain;
    const result = checked(run("security", ["login-keychain"]));
    // It prints the path quoted and indented: `    "/Users/…/login.keychain-db"`.
    const path = /"(.+)"/.exec(result.stdout)?.[1] ?? result.stdout.trim();
    if (result.status !== 0 || path === "") {
      // Unlocking cannot help here: there is no login keychain to unlock.
      throw new ConfigError(
        `Cannot find ${description}, so amika-hostd has nowhere to keep its secrets; set \`secret_store = "file"\` to keep them in files`,
      );
    }
    loginKeychain = path;
    return path;
  };
  return {
    description,
    get(name) {
      const result = checked(
        run("security", [
          "find-generic-password",
          "-s",
          SERVICE,
          "-a",
          name,
          "-w",
          login(),
        ]),
      );
      const value = result.status === 0 ? result.stdout.trim() : "";
      if (value !== "") return value;
      // 44 is errSecItemNotFound; anything else (a locked keychain, a
      // dismissed prompt) is a keychain that cannot be read.
      if (result.status === 44) return undefined;
      throw refuse(`read the ${LABELS[name]} from`);
    },
    set(name, value) {
      // The value is quoted into a `security -i` command; nothing a secret or
      // API key may hold (printable ASCII without spaces) needs more, but
      // quotes and backslashes would.
      if (!/^[\x21-\x7e]+$/.test(value) || /["\\]/.test(value)) {
        throw new ConfigError(
          `The ${LABELS[name]} has spaces, quotes or backslashes, so it cannot go in ${description}; set \`secret_store = "file"\` to keep it in a file`,
        );
      }
      // `security -i` reads the command from stdin, which keeps the value
      // out of the process list. Its exit status does not report a failed
      // command, so read the value back to confirm it was stored.
      checked(
        run(
          "security",
          ["-i"],
          `add-generic-password -U -s ${SERVICE} -a ${name} -l "${LABELS[name]}" -w "${value}" ${quoted(login())}\n`,
        ),
      );
      if (this.get(name) !== value)
        throw refuse(`store the ${LABELS[name]} in`);
    },
  };
}

/**
 * `text` as one double-quoted word for a `security -i` command line, whose
 * parser takes `\\` and `\"` as escapes inside quotes. For the keychain path,
 * which can hold spaces.
 */
function quoted(text: string): string {
  return `"${text.replace(/["\\]/g, (char) => `\\${char}`)}"`;
}

/**
 * The Secret Service (GNOME Keyring, KWallet) on a Linux desktop session,
 * through `secret-tool`. Items carry attributes `service=amika-hostd` and
 * `account=<secret>`.
 */
function secretServiceKeychain(run: Runner): Keychain {
  const description = "your desktop keyring (Secret Service)";
  const files = 'set `secret_store = "file"` to keep secrets in files';
  const attributes = (name: SecretName) => [
    "service",
    SERVICE,
    "account",
    name,
  ];
  /** Run `secret-tool`, refusing if it is missing, hung, or has no service. */
  const secretTool = (args: readonly string[], input?: string): RunResult => {
    const result = checked(run("secret-tool", args, input));
    const code = errorCode(result.error);
    if (code === "ENOENT") {
      throw new ConfigError(
        `secret-tool is not installed, so amika-hostd cannot use ${description}; install it (libsecret-tools, or libsecret) if this session has a desktop keyring, or ${files}`,
      );
    }
    if (result.error || result.signal) {
      throw new ConfigError(
        `secret-tool did not finish (${result.signal ?? code}), so amika-hostd cannot use ${description}; answer or dismiss any keyring prompt and run \`amika-hostd setup\` again, or ${files}`,
      );
    }
    // A session bus with no keyring daemon on it, as over SSH to a server.
    if (
      /ServiceUnknown|NoReply|Could not connect|Cannot autolaunch/i.test(
        result.stderr ?? "",
      )
    ) {
      throw new ConfigError(
        `No desktop keyring (Secret Service) answers on this session's D-Bus (${detail(result)}), so amika-hostd has nowhere to keep its secrets; ${files}`,
      );
    }
    return result;
  };
  const refuse = (what: string, result: RunResult) =>
    new ConfigError(
      `Cannot ${what} ${description} (${detail(result)}); unlock it and run \`amika-hostd setup\` again, or ${files}`,
    );
  /**
   * Whether an item exists, locked or not. `search --all` lists locked items
   * without unlocking them; it prints each match (with the secret, for an
   * unlocked one), so only whether it printed anything is kept.
   */
  const exists = (name: SecretName): boolean => {
    const result = secretTool(["search", "--all", ...attributes(name)]);
    if (result.status !== 0) {
      throw refuse(`look for the ${LABELS[name]} in`, result);
    }
    return result.stdout.trim() !== "";
  };
  return {
    description,
    get(name) {
      const result = secretTool(["lookup", ...attributes(name)]);
      const value = result.status === 0 ? result.stdout.trim() : "";
      if (value !== "") return value;
      if (result.status !== 1 || result.stderr?.trim()) {
        throw refuse(`read the ${LABELS[name]} from`, result);
      }
      // A silent exit 1 means no item, but also a locked one whose unlock
      // prompt was dismissed; reading that as unset would have setup replace
      // the secret key, so check that nothing is there.
      if (!exists(name)) return undefined;
      throw new ConfigError(
        `The ${LABELS[name]} is in ${description}, but it is locked; unlock it and run \`amika-hostd setup\` again, or ${files}`,
      );
    },
    set(name, value) {
      // `store` reads the value from stdin, off the process list.
      const result = secretTool(
        ["store", `--label=${LABELS[name]}`, ...attributes(name)],
        value,
      );
      if (result.status !== 0) {
        throw refuse(`store the ${LABELS[name]} in`, result);
      }
      const stored = this.get(name);
      if (stored === undefined) {
        throw new ConfigError(
          `Stored the ${LABELS[name]} in ${description}, but cannot find it there; run \`amika-hostd setup\` again, or ${files}`,
        );
      }
      // `lookup` returns the first match across the keyring's collections,
      // which can be an older item outside the one `store` wrote to.
      if (stored !== value) {
        throw new ConfigError(
          `Another ${LABELS[name]} in ${description} shadows the one just stored; delete the stale one (see \`secret-tool search --all service ${SERVICE} account ${name}\`) and run \`amika-hostd setup\` again, or ${files}`,
        );
      }
    },
  };
}

/** What a failed program said, for an error message; never its stdout. */
function detail(result: RunResult): string {
  const said = result.stderr?.trim().split("\n")[0];
  return said || `exit status ${result.status}`;
}

function runProgram(
  command: string,
  args: readonly string[],
  input?: string,
): RunResult {
  const result = spawnSync(command, args, {
    input,
    encoding: "utf8",
    timeout: KEYCHAIN_TIMEOUT_MS,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    signal: result.signal,
    error: result.error,
  };
}

/** `result`, unless the operator's Ctrl-C killed the program. */
function checked(result: RunResult): RunResult {
  if (result.signal === "SIGINT") {
    throw new KeychainInterrupted("the keychain command was interrupted");
  }
  return result;
}

function fileSecret(file: string, deps: CredentialDeps): Secret {
  const readFile = deps.readFile ?? ((name) => readFileSync(name, "utf8"));
  const writeFile = deps.writeFile ?? writePrivateFile;
  return {
    description: `${file} (readable only by you)`,
    get() {
      try {
        const value = readFile(file).trim();
        return value === "" ? undefined : value;
      } catch (error) {
        if (errorCode(error) === "ENOENT") return undefined;
        throw new ConfigError(`Cannot read ${file}: ${errorCode(error)}`);
      }
    },
    set(value) {
      try {
        writeFile(file, `${value}\n`);
      } catch (error) {
        throw new ConfigError(`Cannot write ${file}: ${errorCode(error)}`);
      }
    },
  };
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "unknown error";
}
