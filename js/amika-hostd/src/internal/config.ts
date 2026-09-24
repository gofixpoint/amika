/** Resolve daemon settings from CLI flags, then environment, then TOML. */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

export const DEFAULT_API_URL = "https://app.amika.dev";
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 3020;

/** Settings accepted as command-line flags. */
export interface HostdFlags {
  host?: string;
  port?: string;
}

export interface HostdConfig {
  /** Only ever read from the environment; never from the TOML file. */
  apiKey?: string;
  apiUrl: string;
  hostname?: string;
  secretKey?: string;
  host: string;
  port: number;
  smolApiUrl?: string;
  smolRequestTimeoutMs: number;
  /** The TOML file the settings were read from, if one was found. */
  configPath?: string;
}

export type RequiredSetting = "apiKey" | "hostname" | "secretKey";

export type HostdConfigWith<K extends RequiredSetting> = HostdConfig &
  Required<Pick<HostdConfig, K>>;

export interface HostdConfigFile {
  path: string;
  contents: string;
}

/** A misconfiguration the operator must fix; the message is safe to print. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

/**
 * Environment names for each setting, most specific first. A setting given
 * under two names with different values is rejected rather than guessed at.
 */
export const ENV_NAMES = {
  apiKey: ["AMIKA_HOSTD_API_KEY", "AMIKA_API_KEY"],
  apiUrl: ["AMIKA_HOSTD_API_URL", "AMIKA_API_URL"],
  hostname: ["AMIKA_HOSTD_HOSTNAME"],
  secretKey: ["AMIKA_HOSTD_SECRET_KEY", "AMIKA_SECRET_KEY"],
  host: ["AMIKA_HOSTD_HOST"],
  port: ["AMIKA_HOSTD_PORT"],
} as const;

/** Resolve every setting. Each one takes the first source that sets it. */
export function resolveConfig({
  flags = {},
  env = {},
  file,
}: {
  flags?: HostdFlags;
  env?: NodeJS.ProcessEnv;
  file?: HostdConfigFile;
}): HostdConfig {
  const toml = file ? parseConfigFile(file) : {};
  const fromEnv = (key: keyof typeof ENV_NAMES) => readEnv(env, key);
  const port = flags.port ?? fromEnv("port") ?? toml.port;
  return {
    apiKey: fromEnv("apiKey"),
    apiUrl: parseApiUrl(fromEnv("apiUrl") ?? toml.api_url ?? DEFAULT_API_URL),
    hostname: parseHostname(fromEnv("hostname") ?? toml.hostname),
    secretKey: fromEnv("secretKey") ?? toml.secret_key,
    host: flags.host ?? fromEnv("host") ?? toml.host ?? DEFAULT_HOST,
    port: port === undefined ? DEFAULT_PORT : parsePort(port),
    smolApiUrl: nonEmpty(env.SMOL_API_URL),
    smolRequestTimeoutMs: parseTimeout(env.SMOL_REQUEST_TIMEOUT_MS),
    configPath: file?.path,
  };
}

/** Fail with one message naming every missing setting and where to set it. */
export function requireSettings<K extends RequiredSetting>(
  config: HostdConfig,
  keys: readonly K[],
): HostdConfigWith<K> {
  const missing = keys.filter((key) => config[key] === undefined);
  if (missing.length > 0) {
    throw new ConfigError(
      [
        "Missing required configuration:",
        ...missing.map((key) => `  - ${describeSetting(key)}`),
      ].join("\n"),
    );
  }
  return config as HostdConfigWith<K>;
}

/** Candidate TOML locations, highest precedence first. */
export function configFilePaths(env: NodeJS.ProcessEnv = {}): string[] {
  const configHome =
    nonEmpty(env.XDG_CONFIG_HOME) ?? path.join(homedir(), ".config");
  return [
    path.join(configHome, "amika-hostd", "config.toml"),
    "/etc/amika-hostd/config.toml",
  ];
}

/** Read the first TOML file that exists; later locations are not merged in. */
export function loadConfigFile(
  env: NodeJS.ProcessEnv = {},
  readFile: (file: string) => string = (file) => readFileSync(file, "utf8"),
): HostdConfigFile | undefined {
  for (const candidate of configFilePaths(env)) {
    try {
      return { path: candidate, contents: readFile(candidate) };
    } catch (error) {
      if (isMissingFile(error)) continue;
      throw new ConfigError(`Cannot read ${candidate}: ${errorCode(error)}`);
    }
  }
  return undefined;
}

const configFileSchema = z.strictObject({
  hostname: z.string().optional(),
  secret_key: z.string().min(1).optional(),
  api_url: z.string().optional(),
  host: z.string().min(1).optional(),
  port: z.number().int().optional(),
});

function parseConfigFile(file: HostdConfigFile) {
  let raw: unknown;
  try {
    raw = parseToml(file.contents);
  } catch {
    // The parser's message may quote file contents, including the secret.
    throw new ConfigError(`${file.path} is not valid TOML`);
  }
  if (typeof raw === "object" && raw !== null && "api_key" in raw) {
    throw new ConfigError(
      `${file.path} must not contain api_key; set ${ENV_NAMES.apiKey[1]} in the environment instead`,
    );
  }
  const parsed = configFileSchema.safeParse(raw);
  if (!parsed.success) {
    const keys = parsed.error.issues.flatMap((issue) =>
      issue.code === "unrecognized_keys" ? issue.keys : issue.path.map(String),
    );
    throw new ConfigError(
      `${file.path} has invalid settings: ${[...new Set(keys)].join(", ")}`,
    );
  }
  return parsed.data;
}

function readEnv(
  env: NodeJS.ProcessEnv,
  key: keyof typeof ENV_NAMES,
): string | undefined {
  const set = ENV_NAMES[key]
    .map((name) => ({ name, value: nonEmpty(env[name]) }))
    .filter((entry) => entry.value !== undefined);
  if (new Set(set.map((entry) => entry.value)).size > 1) {
    throw new ConfigError(
      `Ambiguous configuration: ${set.map((entry) => entry.name).join(" and ")} are set to different values; unset one of them`,
    );
  }
  return set[0]?.value;
}

function parseApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`Invalid Amika API URL: ${value}`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username) {
    throw new ConfigError(`Invalid Amika API URL: ${value}`);
  }
  return url.toString().replace(/\/$/, "");
}

/**
 * Match the control plane's hostname rules (a lowercase RFC 1123 hostname) so
 * registration cannot 400. Mixed case is rejected rather than folded, since a
 * host's identity is exactly the hostname it registers with.
 */
function parseHostname(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const hostname = value.trim();
  if (!isDnsHostname(hostname)) {
    throw new ConfigError(
      `Invalid hostname: ${JSON.stringify(hostname)}. Use lowercase letters, digits, and hyphens in dot-separated labels (each 1-63 characters, starting and ending with a letter or digit), at most 253 characters in total`,
    );
  }
  return hostname;
}

const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function isDnsHostname(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 253 &&
    value.split(".").every((label) => DNS_LABEL.test(label))
  );
}

function parsePort(value: string | number): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`Invalid port: ${value}`);
  }
  return port;
}

function parseTimeout(value: string | undefined): number {
  if (nonEmpty(value) === undefined) return 300_000;
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new ConfigError(`Invalid SMOL_REQUEST_TIMEOUT_MS: ${value}`);
  }
  return timeout;
}

function describeSetting(key: RequiredSetting): string {
  switch (key) {
    case "apiKey":
      return `API key: set ${ENV_NAMES.apiKey.join(" or ")} (environment only)`;
    case "hostname":
      return `hostname: set ${ENV_NAMES.hostname[0]} or \`hostname\` in config.toml`;
    case "secretKey":
      return `secret key: set ${ENV_NAMES.secretKey.join(" or ")} or \`secret_key\` in config.toml`;
    default:
      return assertNever(key);
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

function isMissingFile(error: unknown): boolean {
  return errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR";
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "unknown error";
}

function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${String(value)}`);
}
