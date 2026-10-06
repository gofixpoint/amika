/**
 * Keep the Amika API key that `amika-hostd setup` asks for, in a file only
 * its owner can read. Only `setup`, `up` and `register-url` read it; the
 * background daemon never needs it.
 */
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { ConfigError, configFilePaths } from "./config.js";
import { writePrivateFile } from "./private-file.js";

/** Where the API key is kept. Messages name it by `description`. */
export interface CredentialStore {
  readonly description: string;
  get(): string | undefined;
  set(value: string): void;
}

export interface CredentialDeps {
  readFile?: (file: string) => string;
  writeFile?: (file: string, contents: string) => void;
  removeFile?: (file: string) => void;
}

/**
 * API keys are sent as bearer tokens, so keep them to printable ASCII without
 * spaces, quotes or backslashes.
 */
export function isValidApiKey(value: string): boolean {
  return /^[\x21-\x7e]+$/.test(value) && !/["'\\]/.test(value);
}

/** The file the API key is kept in, next to `config.toml`. */
export function apiKeyFilePath(env: NodeJS.ProcessEnv): string {
  return path.join(path.dirname(configFilePaths(env)[0]), "api-key");
}

/** The API key store for this machine: a mode-0600 file. */
export function apiKeyStore(
  env: NodeJS.ProcessEnv,
  deps: CredentialDeps = {},
): CredentialStore {
  const file = fileStore(apiKeyFilePath(env), deps);
  return { description: file.description, get: file.get, set: file.set };
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

function nonEmpty(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "unknown error";
}
