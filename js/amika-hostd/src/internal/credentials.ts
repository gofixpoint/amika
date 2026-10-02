/**
 * Keep the Amika API key that `amika-hostd setup` asks for, in the system
 * keychain where one is usable, and otherwise in a file only its owner can
 * read. Only `setup`, `up` and `register-url` read it; the background daemon
 * never needs it.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { ConfigError, configFilePaths } from "./config.js";
import { writePrivateFile } from "./private-file.js";

/** Where the API key is kept. Messages name it by `description`. */
export interface CredentialStore {
  readonly description: string;
  get(): string | undefined;
  set(value: string): void;
  /** Delete the stored key; throws `ConfigError` if it is still readable. */
  remove(): void;
  /**
   * Record exactly where a key is kept now, so `restore` can put it back as
   * it was. Throws `ConfigError` if the keychain cannot be read, since it
   * might hold a key that an undo would then lose.
   */
  snapshot(): CredentialSnapshot;
  restore(snapshot: CredentialSnapshot): void;
}

/** What the keychain and the fallback file each held, from `snapshot`. */
export interface CredentialSnapshot {
  /** `undefined`: no keychain, or nothing in it. */
  readonly keychain?: string;
  readonly file?: string;
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

/**
 * A keychain command was killed by Ctrl-C. The terminal sends it to the
 * whole foreground process group, so it reaches the keychain program too;
 * this is reported rather than read as a failure to fall back from.
 */
export class KeychainInterrupted extends ConfigError {
  override name = "KeychainInterrupted";
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
  const removeFile = () => {
    if (!file.remove()) {
      throw new ConfigError(`Cannot remove the API key in ${file.path}`);
    }
  };
  if (keychain === undefined) {
    return {
      description: file.description,
      get: file.get,
      set: file.set,
      remove: removeFile,
      snapshot: () => ({ file: file.get() }),
      restore(snapshot) {
        if (snapshot.file === undefined) removeFile();
        else file.set(snapshot.file);
      },
    };
  }
  let description = keychain.description;
  // Reads try the keychain first, so a key it may still hold would shadow
  // one in the file. Only "not there" proves it does not; a locked keychain
  // (say, over SSH to a Mac) can neither be changed nor checked.
  const ensureGone = (message: string) => {
    keychain.remove();
    if (keychain.lookup().state !== "absent") throw new ConfigError(message);
  };
  return {
    get description() {
      return description;
    },
    get() {
      const found = keychain.lookup();
      return found.state === "found" ? found.value : file.get();
    },
    set(value) {
      if (!keychain.set(value)) {
        ensureGone(
          `Cannot store the API key in ${keychain.description}, or make sure an old one is not left there; unlock it, or remove its "${SERVICE}" item, and run \`amika-hostd setup\` again`,
        );
        file.set(value);
        description = file.description;
        return;
      }
      // A key left in the file is read wherever the keychain is not (an SSH
      // session without the Secret Service, say), so remove it, or else
      // overwrite it with the new key rather than leave the old one there.
      if (!file.remove()) file.set(value);
      description = keychain.description;
    },
    remove() {
      ensureGone(
        `Cannot remove the API key from ${keychain.description}; unlock it, or remove its "${SERVICE}" item, and run \`amika-hostd setup\` again`,
      );
      removeFile();
    },
    snapshot() {
      const found = keychain.lookup();
      if (found.state === "unknown") {
        throw new ConfigError(
          `Cannot read ${keychain.description} to see whether it already holds an API key; unlock it and run \`amika-hostd setup\` again`,
        );
      }
      return {
        keychain: found.state === "found" ? found.value : undefined,
        file: file.get(),
      };
    },
    // Put each place back exactly, rather than through `set`, which would
    // move a key that lived only in the file into the keychain. Both places
    // are tried even if one fails, so a keychain fault never leaves the file
    // holding the new key; and a keychain key that cannot go back there is
    // kept readable in the file rather than lost.
    restore(snapshot) {
      const errors: string[] = [];
      let fileValue = snapshot.file;
      let inKeychain = false;
      const keepInFile = (error: unknown) => {
        if (snapshot.keychain === undefined) {
          errors.push((error as Error).message);
          return;
        }
        fileValue = snapshot.keychain;
        try {
          ensureGone(
            `Cannot remove the new API key from ${keychain.description}`,
          );
        } catch (removeError) {
          errors.push((removeError as Error).message);
        }
      };
      try {
        if (snapshot.keychain === undefined) {
          ensureGone(
            `Cannot remove the API key from ${keychain.description}; unlock it, or remove its "${SERVICE}" item, and run \`amika-hostd setup\` again`,
          );
        } else if (keychain.set(snapshot.keychain)) {
          inKeychain = true;
        } else {
          keepInFile(
            new ConfigError(
              `Cannot put the previous API key back in ${keychain.description}`,
            ),
          );
        }
      } catch (error) {
        keepInFile(error);
      }
      try {
        if (fileValue === undefined) removeFile();
        else file.set(fileValue);
      } catch (error) {
        errors.push((error as Error).message);
      }
      description =
        inKeychain || fileValue === undefined
          ? keychain.description
          : file.description;
      if (errors.length > 0) throw new ConfigError(errors.join("; "));
    },
  };
}

/** What a keychain holds for amika-hostd, as far as it could tell. */
type Lookup =
  | { state: "found"; value: string }
  | { state: "absent" }
  /** Locked, unreachable, or timed out: it may hold a key. */
  | { state: "unknown" };

interface Keychain {
  description: string;
  lookup(): Lookup;
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
        lookup() {
          const result = checked(
            run("security", [
              "find-generic-password",
              "-s",
              SERVICE,
              "-a",
              ACCOUNT,
              "-w",
            ]),
          );
          // 44 is errSecItemNotFound; anything else (a locked keychain, a
          // dismissed prompt) leaves the answer unknown.
          if (result.status === 44) return { state: "absent" };
          return found(result);
        },
        set(value) {
          // `security -i` reads the command from stdin, which keeps the key
          // out of the process list. Its exit status does not report a failed
          // command, so read the key back to confirm it was stored.
          checked(
            run(
              "security",
              ["-i"],
              `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -l "${LABEL}" -w "${value}"\n`,
            ),
          );
          return isValue(this.lookup(), value);
        },
        remove() {
          checked(
            run("security", [
              "delete-generic-password",
              "-s",
              SERVICE,
              "-a",
              ACCOUNT,
            ]),
          );
        },
      };
    case "linux":
      // The Secret Service lives on the desktop session's D-Bus; a headless
      // host (or an SSH session into one) has none.
      if (!env.DBUS_SESSION_BUS_ADDRESS) return undefined;
      return {
        description: "your desktop keyring (Secret Service)",
        lookup() {
          const result = checked(
            run("secret-tool", [
              "lookup",
              "service",
              SERVICE,
              "account",
              ACCOUNT,
            ]),
          );
          // Without secret-tool there is no keyring to hold a key.
          if (errorCode(result.error) === "ENOENT") return { state: "absent" };
          // `lookup` exits 1 both for "no such item" and for errors, which
          // it explains on stderr; a silent 1 means the item is not there.
          if (result.status === 1 && !result.stderr?.trim()) {
            return { state: "absent" };
          }
          return found(result);
        },
        set(value) {
          const result = checked(
            run(
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
            ),
          );
          return result.status === 0 && isValue(this.lookup(), value);
        },
        remove() {
          checked(
            run("secret-tool", [
              "clear",
              "service",
              SERVICE,
              "account",
              ACCOUNT,
            ]),
          );
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
    path: file,
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
    /** Delete the file; false if it may still be there. */
    remove(): boolean {
      try {
        removeFile(file);
        return true;
      } catch {
        return false;
      }
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

function found(result: RunResult): Lookup {
  const value = result.status === 0 ? nonEmpty(result.stdout) : undefined;
  return value === undefined ? { state: "unknown" } : { state: "found", value };
}

function isValue(lookup: Lookup, value: string): boolean {
  return lookup.state === "found" && lookup.value === value;
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
