/**
 * Where hostd keeps its secrets: the Amika API key `amika-hostd setup` asks
 * for, and the secret key Amika presents to the daemon. By default
 * (`DEFAULT_SECRET_STORE`) they live in the system keychain; with
 * `secret_store = "file"` they live in plain files only their owner can
 * read. The two are never mixed: a read never
 * falls back from one to the other, so a key left in one cannot shadow a
 * newer one in the other.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { toHostPlatform, type HostPlatform } from "../platforms/index.js";
import {
  runProgram,
  type Keychain,
  type Runner,
  type SecretName,
} from "../platforms/keychains.js";
import {
  ConfigError,
  ENV_NAMES,
  configFilePaths,
  type SecretStoreKind,
} from "./config.js";
import { writePrivateFile } from "./private-file.js";

export {
  KeychainInterrupted,
  type Keychain,
  type RunResult,
  type Runner,
  type SecretName,
} from "../platforms/keychains.js";

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
   * The host-scoped credential that attaches this host to Amika's tunnel
   * gateway, in tunnel mode. Deliberately a third secret and not either of
   * the two above: the API key acts as the user across their whole
   * organization, and the secret key authorizes Amika's requests *into*
   * this daemon. Attaching a host is a different permission from both, so
   * a copy of this one is worth only this host's inbound traffic.
   */
  readonly attachmentCredential: Secret;
  /**
   * In the keychain, the secret key is a keychain item. With the file store
   * it is `secret_key` in config.toml, which setup writes with the rest of
   * the config, so there is no separate secret here.
   */
  readonly secretKey?: Secret;
}

export interface CredentialDeps {
  /** The system keychain; defaults to this platform's (see `systemKeychain`). */
  keychain?: Keychain | null;
  /** The OS whose keychain to use, as a platform or its name. */
  platform?: HostPlatform | NodeJS.Platform;
  /** Runs the keychain's command-line tool. */
  run?: Runner;
  readFile?: (file: string) => string;
  writeFile?: (file: string, contents: string) => void;
}

/**
 * API keys are sent as bearer tokens, so keep them to printable ASCII without
 * spaces, quotes or backslashes.
 */
export function isValidApiKey(value: string): boolean {
  return /^[\x21-\x7e]+$/.test(value) && !/["'\\]/.test(value);
}

/** The file the API key is kept in with the file store: the user config dir. */
export function apiKeyFilePath(env: NodeJS.ProcessEnv): string {
  return secretFilePath(env, "api-key");
}

/**
 * The file the attachment credential is kept in with the file store.
 *
 * Beside the API key rather than in `config.toml`, unlike the secret key.
 * The config file is read and rewritten by `setup`, printed in support
 * threads and copied between machines; a credential that lets the bearer
 * receive this host's traffic should not travel with it.
 */
export function attachmentCredentialFilePath(env: NodeJS.ProcessEnv): string {
  return secretFilePath(env, "attachment-credential");
}

function secretFilePath(env: NodeJS.ProcessEnv, name: SecretName): string {
  return path.join(path.dirname(configFilePaths(env)[0]), name);
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
    return {
      kind,
      apiKey: fileSecret(apiKeyFilePath(env), deps),
      attachmentCredential: fileSecret(attachmentCredentialFilePath(env), deps),
    };
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
    attachmentCredential: item(
      "attachment-credential",
      "tunnel attachment credential",
    ),
  };
}

/** This platform's keychain, if amika-hostd supports one here. */
function systemKeychain(
  env: NodeJS.ProcessEnv,
  deps: CredentialDeps,
): Keychain | undefined {
  return toHostPlatform(deps.platform).keychain(env, deps.run ?? runProgram);
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
