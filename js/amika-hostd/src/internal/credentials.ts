/**
 * Keep the Amika API key that `amika-hostd setup` asks for, in the system
 * keychain where one is usable, and otherwise in a file only its owner can
 * read. Only `setup`, `up` and `register-url` read it; the background daemon
 * never needs it.
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { ConfigError, configFilePaths } from "./config.js";

/** Where the API key is kept. Messages name it by `description`. */
export interface CredentialStore {
  readonly description: string;
  get(): string | undefined;
  set(value: string): void;
}

/** The result of running a program, as `spawnSync` reports it. */
export interface RunResult {
  status: number | null;
  stdout: string;
  error?: Error;
}

export type Runner = (
  command: string,
  args: readonly string[],
  input?: string,
) => RunResult;

export interface CredentialDeps {
  platform?: NodeJS.Platform;
  run?: Runner;
  readFile?: (file: string) => string;
  writeFile?: (file: string, contents: string) => void;
  removeFile?: (file: string) => void;
}

const SERVICE = "amika-hostd";
const ACCOUNT = "api-key";
const LABEL = "Amika API key for amika-hostd";
/** Long enough for a desktop keyring to ask the operator to unlock it. */
const KEYCHAIN_TIMEOUT_MS = 60_000;

/**
 * API keys are sent as bearer tokens and, on macOS, quoted into a `security`
 * command, so keep them to printable ASCII without spaces, quotes or
 * backslashes.
 */
export function isValidApiKey(value: string): boolean {
  return /^[\x21-\x7e]+$/.test(value) && !/["'\\]/.test(value);
}

/** The file the API key falls back to, next to `config.toml`. */
export function apiKeyFilePath(env: NodeJS.ProcessEnv): string {
  return path.join(path.dirname(configFilePaths(env)[0]), "api-key");
}

/**
 * The API key store for this machine: the macOS login keychain, or the
 * Secret Service (GNOME Keyring, KWallet) through `secret-tool` on a Linux
 * desktop session; else a mode-0600 file. Reads try the keychain first.
 */
export function apiKeyStore(
  env: NodeJS.ProcessEnv,
  deps: CredentialDeps = {},
): CredentialStore {
  const file = fileStore(apiKeyFilePath(env), deps);
  const keychain = systemKeychain(env, deps);
  if (keychain === undefined) return file;
  let description = keychain.description;
  return {
    get description() {
      return description;
    },
    get: () => keychain.get() ?? file.get(),
    set(value) {
      if (!keychain.set(value)) {
        // Reads try the keychain first, so an old key it still holds would
        // shadow the new one in the file. Remove it, or refuse.
        keychain.remove();
        if (keychain.get() !== undefined) {
          throw new ConfigError(
            `Cannot replace the API key in ${keychain.description}; remove the "${SERVICE}" item there and run \`amika-hostd setup\` again`,
          );
        }
        file.set(value);
        description = file.description;
        return;
      }
      // A key left in the file would only resurface if the keychain did not
      // answer, so remove it rather than keep a stale copy on disk.
      file.remove();
      description = keychain.description;
    },
  };
}

interface Keychain {
  description: string;
  get(): string | undefined;
  /** False if the keychain could not store it. */
  set(value: string): boolean;
  /** Delete the stored key, if any; best effort. */
  remove(): void;
}

function systemKeychain(
  env: NodeJS.ProcessEnv,
  deps: CredentialDeps,
): Keychain | undefined {
  const run = deps.run ?? runProgram;
  switch (deps.platform ?? process.platform) {
    case "darwin":
      return {
        description: "your macOS login keychain",
        get() {
          const result = run("security", [
            "find-generic-password",
            "-s",
            SERVICE,
            "-a",
            ACCOUNT,
            "-w",
          ]);
          return result.status === 0 ? nonEmpty(result.stdout) : undefined;
        },
        set(value) {
          // `security -i` reads the command from stdin, which keeps the key
          // out of the process list. Its exit status does not report a failed
          // command, so read the key back to confirm it was stored.
          run(
            "security",
            ["-i"],
            `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -l "${LABEL}" -w "${value}"\n`,
          );
          return this.get() === value;
        },
        remove() {
          run("security", [
            "delete-generic-password",
            "-s",
            SERVICE,
            "-a",
            ACCOUNT,
          ]);
        },
      };
    case "linux":
      // The Secret Service lives on the desktop session's D-Bus; a headless
      // host (or an SSH session into one) has none.
      if (!env.DBUS_SESSION_BUS_ADDRESS) return undefined;
      return {
        description: "your desktop keyring (Secret Service)",
        get() {
          const result = run("secret-tool", [
            "lookup",
            "service",
            SERVICE,
            "account",
            ACCOUNT,
          ]);
          return result.status === 0 ? nonEmpty(result.stdout) : undefined;
        },
        set(value) {
          const result = run(
            "secret-tool",
            [
              "store",
              `--label=${LABEL}`,
              "service",
              SERVICE,
              "account",
              ACCOUNT,
            ],
            value,
          );
          return result.status === 0 && this.get() === value;
        },
        remove() {
          run("secret-tool", ["clear", "service", SERVICE, "account", ACCOUNT]);
        },
      };
    default:
      return undefined;
  }
}

function fileStore(file: string, deps: CredentialDeps) {
  const readFile = deps.readFile ?? ((name) => readFileSync(name, "utf8"));
  const writeFile = deps.writeFile ?? writePrivateFile;
  const removeFile =
    deps.removeFile ?? ((name) => rmSync(name, { force: true }));
  return {
    description: `${file} (readable only by you)`,
    get(): string | undefined {
      try {
        return nonEmpty(readFile(file));
      } catch (error) {
        if (errorCode(error) === "ENOENT") return undefined;
        throw new ConfigError(`Cannot read ${file}: ${errorCode(error)}`);
      }
    },
    set(value: string) {
      try {
        writeFile(file, `${value}\n`);
      } catch (error) {
        throw new ConfigError(`Cannot write ${file}: ${errorCode(error)}`);
      }
    },
    remove() {
      try {
        removeFile(file);
      } catch {
        // Best effort: the keychain copy is read first either way.
      }
    },
  };
}

/**
 * Write `contents` so only the owner can read it, replacing `file`
 * atomically. The directory is created owner-only if it is missing.
 */
export function writePrivateFile(file: string, contents: string) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, contents, { mode: 0o600 });
  try {
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
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
    stdio: ["pipe", "pipe", "ignore"],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    error: result.error,
  };
}

function nonEmpty(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "unknown error";
}
