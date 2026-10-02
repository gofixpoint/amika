/**
 * `amika-hostd setup`: ask for the hostname and API key, generate the secret
 * key, and write them, with default rig sizes on the first run, to the TOML
 * config. Running it again offers to change each one.
 */
import { randomBytes } from "node:crypto";
import { hostname as osHostname } from "node:os";
import {
  registerHost as registerHostWithAmika,
  setHostSecret as setHostSecretInAmika,
} from "./amika-api.js";
import {
  ConfigError,
  ENV_NAMES,
  configFilePaths,
  isDnsHostname,
  isValidSecretKey,
  loadConfigFile as loadConfigFileFromDisk,
  resolveConfig,
  type HostdConfig,
  type HostdConfigFile,
  type HostSize,
} from "./config.js";
import {
  isValidApiKey,
  writePrivateFile,
  type CredentialStore,
} from "./credentials.js";
import type { Prompt } from "./prompt.js";

export interface SetupDeps {
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  prompt: Prompt;
  /** Like `prompt`, without echoing what the operator types. */
  promptSecret: Prompt;
  credentials: CredentialStore;
  loadConfigFile?: typeof loadConfigFileFromDisk;
  writeConfigFile?: (file: string, contents: string) => void;
  systemHostname?: () => string;
  generateSecretKey?: () => string;
  registerHost?: typeof registerHostWithAmika;
  setHostSecret?: typeof setHostSecretInAmika;
}

/**
 * The sizes and preset images a config written from scratch gets, so a new
 * host can run rigs right away. They match `config.example.toml`, which the
 * installer seeds (`setup.test.ts` checks).
 */
export const DEFAULT_SIZES: Record<string, HostSize> = {
  tiny: { vcpus: 1, memoryGib: 2, diskGib: 10, diskGrowOnly: false },
  small: { vcpus: 2, memoryGib: 4, diskGib: 16, diskGrowOnly: false },
  medium: { vcpus: 4, memoryGib: 8, diskGib: 24, diskGrowOnly: false },
  large: { vcpus: 8, memoryGib: 16, diskGib: 40, diskGrowOnly: false },
  xlarge: { vcpus: 16, memoryGib: 24, diskGib: 40, diskGrowOnly: false },
};

export const DEFAULT_PRESET_IMAGES: Record<string, string> = {
  "amika-coder": "ghcr.io/gofixpoint/amika-coder:latest",
  "amika-coder-plus-docker":
    "ghcr.io/gofixpoint/amika-coder-plus-docker:latest",
};

/**
 * Run setup. With `fromUp`, `up` called it because settings were missing, so
 * it does not tell the operator to run `up` next.
 */
export async function runSetup(
  deps: SetupDeps,
  { fromUp = false }: { fromUp?: boolean } = {},
): Promise<void> {
  const file = (deps.loadConfigFile ?? loadConfigFileFromDisk)(deps.env);
  const configPath = file?.path ?? configFilePaths(deps.env)[0];
  // The file's own values, which setup edits; the environment can override
  // them, which is reported below rather than written. A placeholder secret
  // (the example's `REPLACE_ME`) counts as unset, so setup replaces it.
  const usable = file && withoutInvalidSecret(file);
  const saved = resolveConfig({ file: usable });
  const effective = resolveConfig({ env: deps.env, file: usable });
  const firstRun =
    saved.hostname === undefined && saved.secretKey === undefined;

  deps.out(`Setting up amika-hostd in ${configPath}`);
  deps.out("");

  const hostname = await askHostname(saved.hostname, deps);
  if (saved.hostname !== undefined && hostname !== saved.hostname) {
    deps.out(
      `Changing the hostname registers a new host in Amika on the next \`amika-hostd up\`; delete ${saved.hostname} in the Amika dashboard if you no longer need it.`,
    );
  }

  const generate =
    deps.generateSecretKey ?? (() => randomBytes(32).toString("hex"));
  let secretKey = saved.secretKey;
  let rotated = false;
  const secretFromEnv = ENV_NAMES.secretKey.find((name) => deps.env[name]);
  if (secretKey === undefined) {
    secretKey = generate();
    deps.out("Generated a new secret key.");
  } else if (secretFromEnv !== undefined) {
    // The daemon would keep using the environment's secret, so a new one in
    // the file, and in Amika, would only lock Amika out.
    deps.out(
      `Keeping the secret key: ${secretFromEnv} overrides it, so change that instead.`,
    );
  } else if (
    await confirm(
      "Regenerate the secret key Amika uses to reach this host? [y/N] ",
      deps,
    )
  ) {
    secretKey = generate();
    rotated = true;
  }

  const apiKey = await askApiKey(deps);

  const contents = renderConfig(file?.contents, {
    hostname,
    secretKey,
    addDefaults: firstRun && Object.keys(saved.sizes).length === 0,
  });
  // Check the result parses before anything changes, here or in Amika.
  const written = resolveConfig({ file: { path: configPath, contents } });

  // Registration never changes a stored secret, so a new one has to reach
  // Amika now, for the hostname `up` will register: the environment's if it
  // sets one. A new hostname registers afresh with it on the next `up`.
  const hostnameFromEnv = ENV_NAMES.hostname.some((name) => deps.env[name]);
  const target = hostnameFromEnv ? effective.hostname : hostname;
  const sendNewSecret =
    rotated && (hostnameFromEnv || hostname === saved.hostname);
  const apiKeyForSecret = sendNewSecret
    ? (apiKey ?? effective.apiKey ?? deps.credentials.get())
    : undefined;
  if (sendNewSecret && apiKeyForSecret === undefined) {
    throw new ConfigError(
      "Amika needs the new secret key, but no API key is set; nothing was changed",
    );
  }

  // Write first, so a file setup cannot write never leaves Amika holding a
  // secret this host does not have; if Amika then refuses it, put the file
  // back as it was.
  const write = deps.writeConfigFile ?? writePrivateFile;
  writeConfig(write, configPath, contents);
  if (sendNewSecret && target !== undefined && apiKeyForSecret !== undefined) {
    try {
      await sendSecret(
        { apiUrl: effective.apiUrl, apiKey: apiKeyForSecret },
        written,
        { hostname: target, secretKey },
        deps,
      );
    } catch (error) {
      if (file !== undefined) writeConfig(write, configPath, file.contents);
      throw error;
    }
  }
  if (apiKey !== undefined) {
    deps.credentials.set(apiKey);
    deps.out(`Stored the API key in ${deps.credentials.description}.`);
  }

  deps.out("");
  deps.out(`Wrote ${configPath}:`);
  deps.out(`  hostname  ${hostname}`);
  deps.out("  secret    (stored in the file, readable only by you)");
  deps.out("Rig sizes:");
  for (const line of describeSizes(written.sizes)) deps.out(`  ${line}`);
  deps.out("Images:");
  for (const line of describeImages(written.images)) deps.out(`  ${line}`);
  deps.out(`Edit ${configPath} to change these settings.`);
  warnAboutEnvironment(deps);
  if (rotated) {
    deps.out(
      "If the daemon is running, restart it to use the new secret key: amika-hostd down, then amika-hostd up.",
    );
  }
  deps.out("");
  if (!fromUp) {
    deps.out("Start the daemon with `amika-hostd up`.");
    deps.out("To stop the daemon and its VMs, run `amika-hostd down`.");
  }
}

async function askHostname(
  current: string | undefined,
  deps: SetupDeps,
): Promise<string> {
  const fallback =
    current ?? suggestHostname((deps.systemHostname ?? osHostname)());
  const question =
    fallback === undefined ? "Hostname: " : `Hostname [${fallback}]: `;
  for (;;) {
    const answer = (await deps.prompt(question))?.trim();
    if (answer === undefined) throw stopped();
    const hostname = answer === "" ? fallback : answer;
    if (hostname === undefined) continue;
    if (isDnsHostname(hostname)) return hostname;
    deps.err(
      `Invalid hostname: ${JSON.stringify(hostname)}. Use lowercase letters, digits, and hyphens in dot-separated labels.`,
    );
  }
}

/**
 * The new API key to store, or `undefined` to keep the stored one (or the
 * environment's, which takes precedence over any stored key).
 */
async function askApiKey(deps: SetupDeps): Promise<string | undefined> {
  const fromEnv = ENV_NAMES.apiKey.find((name) => deps.env[name]);
  if (fromEnv !== undefined) {
    deps.out(
      `Using the API key from ${fromEnv}; unset it to use a stored key instead.`,
    );
    return undefined;
  }
  if (
    deps.credentials.get() !== undefined &&
    !(await confirm("Update the stored Amika API key? [y/N] ", deps))
  ) {
    return undefined;
  }
  for (;;) {
    const answer = (
      await deps.promptSecret("Amika API key (input is hidden): ")
    )?.trim();
    if (answer === undefined) throw stopped();
    if (answer === "") continue;
    if (isValidApiKey(answer)) return answer;
    deps.err(
      "That is not an API key: it must be printable ASCII with no spaces or quotes.",
    );
  }
}

async function confirm(question: string, deps: SetupDeps): Promise<boolean> {
  for (;;) {
    const answer = (await deps.prompt(question))?.trim().toLowerCase();
    if (
      answer === undefined ||
      answer === "" ||
      answer === "n" ||
      answer === "no"
    ) {
      return false;
    }
    if (answer === "y" || answer === "yes") return true;
  }
}

async function sendSecret(
  api: { apiUrl: string; apiKey: string },
  config: HostdConfig,
  input: { hostname: string; secretKey: string },
  deps: SetupDeps,
) {
  const { host, created } = await (deps.registerHost ?? registerHostWithAmika)(
    api,
    { ...input, sizes: config.sizes },
  );
  if (created) {
    deps.out(
      `Registered host ${host.hostname} with ${api.apiUrl} (${host.id})`,
    );
    return;
  }
  await (deps.setHostSecret ?? setHostSecretInAmika)(
    api,
    host,
    input.secretKey,
  );
  deps.out(`Sent the new secret key for host ${host.hostname} to Amika.`);
}

/**
 * The machine's hostname as Amika accepts it (lowercase RFC 1123), without
 * macOS's `.local` mDNS suffix; `undefined` if nothing usable is left.
 */
export function suggestHostname(raw: string): string | undefined {
  const candidate = raw
    .trim()
    .toLowerCase()
    .replace(/\.local$/, "")
    .split(".")
    .map((label) =>
      label
        .replace(/[^a-z0-9-]+/g, "-")
        .slice(0, 63)
        .replace(/^-+|-+$/g, ""),
    )
    .filter((label) => label !== "")
    .join(".");
  return isDnsHostname(candidate) ? candidate : undefined;
}

/**
 * Set `hostname` and `secret_key` in `contents`, keeping everything else the
 * operator wrote. An existing top-level line, or else a commented-out
 * `# key = ...` one, is replaced in place; otherwise both go before the first
 * table, where top-level keys must be. With
 * `addDefaults`, append the default sizes and, unless the file already
 * mentions `[preset_images]`, the default preset images.
 */
export function renderConfig(
  contents: string | undefined,
  {
    hostname,
    secretKey,
    addDefaults,
  }: { hostname: string; secretKey: string; addDefaults: boolean },
): string {
  const lines =
    contents === undefined
      ? [
          "# amika-hostd configuration, written by `amika-hostd setup`. It holds",
          "# the secret key, so keep it readable only by you (mode 600).",
          "# Every setting is described in ~/.local/share/amika-hostd/config.example.toml.",
        ]
      : contents.replace(/\s+$/, "").split("\n");
  const tableStart = lines.findIndex((line) => /^\s*\[/.test(line));
  const topEnd = tableStart === -1 ? lines.length : tableStart;
  const missing: string[] = [];
  for (const [key, value] of [
    ["hostname", hostname],
    ["secret_key", secretKey],
  ] as const) {
    const line = `${key} = ${JSON.stringify(value)}`;
    const top = lines.slice(0, topEnd);
    // A live line, else the commented-out one the example documents.
    const live = top.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
    const at =
      live !== -1
        ? live
        : top.findIndex((l) => new RegExp(`^#\\s*${key}\\s*=`).test(l));
    if (at === -1) missing.push(line);
    else lines[at] = line;
  }
  if (missing.length > 0 && tableStart === -1) {
    lines.push("", ...missing);
  } else if (missing.length > 0) {
    // Above the table's own comments and the blank lines before them.
    let at = tableStart;
    while (at > 0 && /^\s*(#.*)?$/.test(lines[at - 1])) at--;
    const gap = lines[at]?.trim() === "" ? [] : [""];
    lines.splice(at, 0, ...missing, ...gap);
  }
  if (addDefaults) {
    lines.push("", ...renderSizes(DEFAULT_SIZES));
    if (!lines.some((line) => line.includes("[preset_images]"))) {
      lines.push("", ...renderPresetImages(DEFAULT_PRESET_IMAGES));
    }
  }
  return `${lines.join("\n")}\n`;
}

function renderSizes(sizes: Record<string, HostSize>): string[] {
  return [
    "# The sizes rigs on this host can use. `amika-hostd up` sends them to",
    "# Amika on every run, so edit them here and run it again to change them.",
    ...Object.entries(sizes).flatMap(([name, size]) => [
      `[sizes.${name}]`,
      `vcpus = ${size.vcpus}`,
      `memory_gib = ${size.memoryGib}`,
      `disk_gib = ${size.diskGib}`,
      "",
    ]),
  ].slice(0, -1);
}

function renderPresetImages(images: Record<string, string>): string[] {
  return [
    "# The image each Amika preset boots on this host. `:latest` follows each",
    "# release; pin a 12-character commit SHA instead to hold a version still.",
    "[preset_images]",
    ...Object.entries(images).map(
      ([preset, image]) =>
        `${JSON.stringify(preset)} = ${JSON.stringify(image)}`,
    ),
  ];
}

/**
 * `file` without a top-level `secret_key` that could never be used, for
 * reading what setup should keep. The written file still replaces that line
 * in place.
 */
function withoutInvalidSecret(file: HostdConfigFile): HostdConfigFile {
  const line = /^\s*secret_key\s*=\s*"([^"]*)"\s*(#.*)?$/m;
  const value = line.exec(file.contents)?.[1];
  if (value === undefined || isValidSecretKey(value)) return file;
  return { ...file, contents: file.contents.replace(line, "") };
}

function describeSizes(sizes: Record<string, HostSize>): string[] {
  const entries = Object.entries(sizes);
  if (entries.length === 0) return ["none (rigs cannot be sized on this host)"];
  const width = Math.max(...entries.map(([name]) => name.length));
  return entries.map(
    ([name, size]) =>
      `${name.padEnd(width)}  ${size.vcpus} vCPU${size.vcpus === 1 ? "" : "s"}, ${size.memoryGib} GiB memory, ${size.diskGib} GiB disk`,
  );
}

function describeImages(images: Record<string, string>): string[] {
  const entries = Object.entries(images);
  if (entries.length === 0) {
    return [
      "none yet; set them under [preset_images] before creating rigs on this host",
    ];
  }
  const width = Math.max(...entries.map(([name]) => name.length));
  return entries.map(([name, image]) => `${name.padEnd(width)}  ${image}`);
}

function warnAboutEnvironment(deps: SetupDeps) {
  for (const [setting, names] of [
    ["hostname", ENV_NAMES.hostname],
    ["secret key", ENV_NAMES.secretKey],
  ] as const) {
    const name = names.find((candidate) => deps.env[candidate]);
    if (name !== undefined) {
      deps.out(
        `Note: ${name} is set in your environment and overrides the ${setting} in the file.`,
      );
    }
  }
}

function writeConfig(
  write: (file: string, contents: string) => void,
  file: string,
  contents: string,
) {
  try {
    write(file, contents);
  } catch (error) {
    throw new ConfigError(`Cannot write ${file}: ${errorCode(error)}`);
  }
}

function stopped(): ConfigError {
  return new ConfigError(
    "setup stopped before it finished; nothing was changed. Run `amika-hostd setup` to finish.",
  );
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "unknown error";
}
