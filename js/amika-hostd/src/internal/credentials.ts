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
    deps.keychain === undefined ? systemKeychain(deps) : deps.keychain;
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
function systemKeychain(deps: CredentialDeps): Keychain | undefined {
  const run = deps.run ?? runProgram;
  switch (deps.platform ?? process.platform) {
    case "darwin":
      return macOSKeychain(run);
    default:
      return undefined;
  }
}

/**
 * The macOS login keychain, through `security`. Items are generic passwords
 * under service `amika-hostd`, one account per secret.
 */
function macOSKeychain(run: Runner): Keychain {
  const description = "your macOS login keychain";
  const refuse = (what: string) =>
    new ConfigError(
      `Cannot ${what} ${description}; unlock it and run \`amika-hostd setup\` again, or set \`secret_store = "file"\` to keep secrets in files`,
    );
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
          `add-generic-password -U -s ${SERVICE} -a ${name} -l "${LABELS[name]}" -w "${value}"\n`,
        ),
      );
      if (this.get(name) !== value)
        throw refuse(`store the ${LABELS[name]} in`);
    },
  };
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
