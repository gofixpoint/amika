/**
 * `amika-hostd setup`: ask for the hostname and API key, generate the secret
 * key, and write them, with default rig sizes and preset images on the first
 * run: the secrets to the secret store (the keychain, by default), the rest
 * to the TOML config. Running it again offers to change the hostname and API
 * key.
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
  envName,
  configFilePaths,
  isDnsHostname,
  isValidSecretKey,
  loadConfigFile as loadConfigFileFromDisk,
  resolveConfig,
  type HostdConfig,
  type HostdConfigFile,
  type HostSize,
  type SecretStoreKind,
} from "./config.js";
import { isValidApiKey, type Secrets } from "./credentials.js";
import { writePrivateFile } from "./private-file.js";
import type { Prompt } from "./prompt.js";

export interface SetupDeps {
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  prompt: Prompt;
  /** Like `prompt`, without echoing what the operator types. */
  promptSecret: Prompt;
  /** The store the config chose, already opened (see `openSecrets`). */
  secrets: Secrets;
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
  // In the keychain, the secret key is an item there; a `secret_key` still
  // in the file (an older setup's) is moved in. With the file store it stays
  // in the file.
  const keychainSecret = deps.secrets.secretKey;
  const storedSecret = keychainSecret?.get();
  const firstRun =
    saved.hostname === undefined &&
    saved.secretKey === undefined &&
    storedSecret === undefined;

  deps.out(`Setting up amika-hostd in ${configPath}`);
  deps.out("");

  const hostname = await askHostname(saved.hostname, deps);
  if (saved.hostname !== undefined && hostname !== saved.hostname) {
    deps.out(
      `Changing the hostname registers a new host in Amika on the next \`amika-hostd up\`; delete ${saved.hostname} in the Amika dashboard if you no longer need it.`,
    );
  }

  const secretHome = keychainSecret?.description ?? configPath;
  const secretFromEnv = envName(deps.env, "secretKey");
  // The keychain's own item wins over one left in the file: setup put it
  // there, so it is the one Amika has been sent.
  const current = storedSecret ?? saved.secretKey;
  const generate =
    deps.generateSecretKey ?? (() => randomBytes(32).toString("hex"));
  let secretKey: string;
  /** The secret key a regeneration replaced, to put back if Amika fails. */
  let replaced: string | undefined;
  if (current !== undefined) {
    secretKey = current;
    if (keychainSecret && saved.secretKey !== undefined) {
      deps.out(
        storedSecret === undefined
          ? `Moving the secret key from ${configPath} into ${secretHome}.`
          : `Removing the secret_key in ${configPath}: ${secretHome} holds this host's secret key.`,
      );
    }
    const apiUrlFromEnv = envName(deps.env, "apiUrl");
    const apiKeyFromEnv = envName(deps.env, "apiKey");
    if (secretFromEnv !== undefined) {
      // The daemon would keep using the environment's secret, so a new one
      // here, and in Amika, would only lock Amika out.
      deps.out(
        `Keeping the secret key: ${secretFromEnv} overrides it, so change that instead.`,
      );
    } else if (
      apiUrlFromEnv !== undefined &&
      effective.apiUrl !== saved.apiUrl
    ) {
      // A new key would reach only the environment's Amika, and `up` goes
      // back to the file's once that is unset, where the host keeps the old
      // one. One API key is for one Amika, so it cannot go to both.
      deps.out(
        `Not offering to regenerate the secret key: ${apiUrlFromEnv} points at ${effective.apiUrl}, not ${saved.apiUrl}, which \`up\` uses without it. Set api_url in ${configPath}, or unset ${apiUrlFromEnv}, to regenerate it.`,
      );
    } else if (
      apiKeyFromEnv !== undefined &&
      differs(effective.apiKey, deps.secrets.apiKey.get())
    ) {
      // The same for an API key: one from another organization would send
      // the new key there, while `up` goes back to the stored one's.
      deps.out(
        `Not offering to regenerate the secret key: ${apiKeyFromEnv} differs from the API key in ${deps.secrets.apiKey.description}, which \`up\` uses without it, and may be for another organization. Unset ${apiKeyFromEnv} to regenerate it.`,
      );
    } else if (
      await confirm(
        "Regenerate the secret key Amika uses to reach this host? [y/N] ",
        deps,
      )
    ) {
      replaced = current;
      secretKey = generate();
    }
  } else if (effective.secretKey !== undefined) {
    // The host may already be registered with the environment's secret, and
    // a fresh one would be unknown to Amika once the override is dropped.
    secretKey = effective.secretKey;
    deps.out(
      `Saved the secret key from ${secretFromEnv} to ${secretHome}, since Amika may already know it.`,
    );
  } else {
    // Setup marks the file when it stores the secret key in the keychain
    // (`secret_store = "keychain"`; the installer's seeded hostname is no
    // sign of that). With the mark, the key should be there; it may be
    // there but locked, and not every keyring can say so (a locked KeePassXC
    // database hides its items), so ask before replacing it.
    if (
      keychainSecret &&
      saved.secretStoreInFile &&
      saved.secretStore === "keychain"
    ) {
      deps.out(
        `No secret key found in ${secretHome}. If it is there but locked, unlock it and run setup again, rather than replace the secret key Amika may know.`,
      );
      if (!(await confirm("Generate a new secret key? [y/N] ", deps))) {
        throw new ConfigError(
          `Stopped without changing anything; unlock ${secretHome} and run \`amika-hostd setup\` again`,
        );
      }
    }
    secretKey = generate();
    deps.out("Generated a new secret key.");
    if (saved.hostname !== undefined) {
      // Registration never changes a stored secret, so a host Amika already
      // knows keeps the old one there (a switch of `secret_store`, say).
      deps.out(
        `If ${saved.hostname} is already registered with Amika, Amika keeps the secret key it registered with and will be rejected until this host has that one; set it with ${ENV_NAMES.secretKey[0]} and run setup again.`,
      );
    }
  }

  const apiKey = await askApiKey(deps);

  // The file names the store setup used whenever the file alone (its own
  // setting, else the default) would choose another, so a store chosen from
  // the environment carries over once that is unset. With the keychain it
  // always does: that marks a host whose secret key setup stored there (see
  // above).
  const store = deps.secrets.kind;
  const changedStore =
    saved.secretStoreInFile && saved.secretStore !== store
      ? saved.secretStore
      : undefined;
  const render = (secret: string) =>
    renderConfig(file?.contents, {
      hostname,
      secretStore:
        store === "keychain" || saved.secretStore !== store ? store : undefined,
      // In the keychain, the file keeps no secret key at all.
      secretKey: keychainSecret ? undefined : secret,
      // A config written from scratch always gets them, even when a secret
      // survived in the keychain (the file was deleted, say).
      addDefaults:
        (file === undefined || firstRun) &&
        Object.keys(saved.sizes).length === 0,
    });
  const contents = render(secretKey);
  // Check the result parses before anything changes, here or in Amika.
  const written = resolveConfig({ file: { path: configPath, contents } });

  // Registration never changes a stored secret, so a regenerated one has to
  // reach Amika now, for every hostname `up` may register: the one setup
  // writes, and the environment's while it overrides that. Sending registers
  // a hostname Amika does not know yet, and updates one it does (a new
  // hostname may be one registered earlier).
  const hostnameFromEnv = envName(deps.env, "hostname") !== undefined;
  const targets = [
    ...new Set(
      [hostnameFromEnv ? effective.hostname : undefined, hostname].filter(
        (name): name is string => name !== undefined,
      ),
    ),
  ];
  const old = replaced;
  const apiKeyForSecret =
    old === undefined
      ? undefined
      : (apiKey ?? effective.apiKey ?? deps.secrets.apiKey.get());
  if (old !== undefined && apiKeyForSecret === undefined) {
    throw new ConfigError(
      "Amika needs the new secret key, but no API key is set; nothing was changed",
    );
  }
  /** Put the regenerated key's predecessor back where setup keeps it. */
  const restore = (wroteConfig: boolean) => {
    if (old === undefined) return;
    if (keychainSecret) keychainSecret.set(old);
    else if (wroteConfig) writeConfig(write, configPath, render(old));
  };

  // The secrets first, so a secret that cannot be stored (a locked keychain,
  // say) leaves the config untouched; then the config. Both before Amika, so
  // a secret this host could not keep never reaches Amika.
  const write = deps.writeConfigFile ?? writePrivateFile;
  // A new API key that sends a regenerated secret key is kept only once
  // Amika has taken it: if Amika refuses it (a typo, say), a rerun must not
  // find it stored and keep it by default.
  const deferApiKey = old !== undefined && apiKey !== undefined;
  /** `error` from storing or sending the new key, noting a dropped API key. */
  const failed = (error: ConfigError) =>
    deferApiKey
      ? new ConfigError(
          `${error.message} The API key you entered was not saved either.`,
        )
      : error;
  if (apiKey !== undefined && !deferApiKey) deps.secrets.apiKey.set(apiKey);
  const storesSecret = keychainSecret && secretKey !== storedSecret;
  if (storesSecret) keychainSecret.set(secretKey);
  try {
    writeConfig(write, configPath, contents);
  } catch (error) {
    // A regenerated key already in the keychain would be one Amika never
    // got; put the old one back.
    if (old === undefined || !storesSecret) throw error;
    throw failed(
      restoreSecret(
        error as Error,
        secretHome,
        () => restore(false),
        undefined,
      ),
    );
  }
  if (changedStore !== undefined) {
    deps.out(
      `Changed secret_store in ${configPath} from "${changedStore}" to "${store}", where setup kept the secrets.`,
    );
  }
  if (apiKey !== undefined && !deferApiKey) {
    deps.out(`Stored the API key in ${deps.secrets.apiKey.description}.`);
  }
  if (storesSecret) {
    deps.out(`Stored the secret key in ${secretHome}.`);
  }
  if (old !== undefined && apiKeyForSecret !== undefined) {
    const api = { apiUrl: effective.apiUrl, apiKey: apiKeyForSecret };
    const sent: string[] = [];
    for (const target of targets) {
      try {
        const created = await sendSecret(
          api,
          written,
          { hostname: target, secretKey },
          deps,
        );
        sent.push(target);
        deps.out(
          created
            ? `Registered host ${target} with ${api.apiUrl}`
            : `Sent the new secret key for host ${target} to Amika.`,
        );
      } catch (error) {
        throw failed(
          restoreSecret(error as Error, secretHome, () => restore(true), sent),
        );
      }
    }
  }
  if (apiKey !== undefined && deferApiKey) {
    deps.secrets.apiKey.set(apiKey);
    deps.out(`Stored the API key in ${deps.secrets.apiKey.description}.`);
  }

  deps.out("");
  deps.out(`Wrote ${configPath}:`);
  deps.out(`  hostname  ${hostname}`);
  deps.out(
    keychainSecret
      ? `  secret    (in ${secretHome})`
      : "  secret    (in the file, readable only by you)",
  );
  deps.out("Rig sizes:");
  for (const line of describeSizes(written.sizes)) deps.out(`  ${line}`);
  deps.out("Images:");
  for (const line of describeImages(written.images)) deps.out(`  ${line}`);
  deps.out(`Edit ${configPath} to change these settings.`);
  warnAboutEnvironment(deps, secretHome);
  if (replaced !== undefined) {
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

/**
 * Give Amika `input.secretKey` for this hostname: registering it if new,
 * else replacing the stored secret. Returns whether it registered the host.
 */
async function sendSecret(
  api: { apiUrl: string; apiKey: string },
  config: HostdConfig,
  input: { hostname: string; secretKey: string },
  deps: SetupDeps,
): Promise<boolean> {
  const { host, created } = await (deps.registerHost ?? registerHostWithAmika)(
    api,
    { ...input, sizes: config.sizes },
  );
  if (created) return true;
  await (deps.setHostSecret ?? setHostSecretInAmika)(
    api,
    host,
    input.secretKey,
  );
  return false;
}

/**
 * Storing or sending the regenerated secret key failed: put the old one back
 * where setup keeps it, and say what Amika has. `sent` names the hosts Amika
 * already took the new key for, or is `undefined` when nothing was sent; for
 * the host that failed, whether Amika applied it is unknown, so the error
 * says how to recover if it did.
 */
function restoreSecret(
  error: Error,
  secretHome: string,
  restore: () => void,
  sent: string[] | undefined,
): ConfigError {
  const again =
    "run `amika-hostd setup` again and regenerate it, so Amika and this host agree";
  try {
    restore();
  } catch {
    return new ConfigError(
      `${error.message}; the new secret key is still in ${secretHome}, since the old one could not be put back. ${capitalize(again)}.`,
    );
  }
  if (sent === undefined) {
    return new ConfigError(
      `${error.message}; ${secretHome} still has the old secret key, and nothing was sent to Amika.`,
    );
  }
  if (sent.length > 0) {
    return new ConfigError(
      `${error.message}; ${secretHome} has the old secret key again, but Amika already has the new one for ${sent.join(", ")}: ${again}.`,
    );
  }
  return new ConfigError(
    `${error.message}; ${secretHome} still has the old secret key. If Amika's requests to this host start failing, ${again}.`,
  );
}

/** Whether a stored value exists and is not `value`. */
function differs(value: string | undefined, stored: string | undefined) {
  return stored !== undefined && stored !== value;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
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
  const fromEnv = envName(deps.env, "apiKey");
  if (fromEnv !== undefined) {
    deps.out(
      `Using the API key from ${fromEnv}; unset it to use a stored key instead.`,
    );
    return undefined;
  }
  if (
    deps.secrets.apiKey.get() !== undefined &&
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
 * Set `hostname`, and `secret_key` and `secret_store` when given, in
 * `contents`, keeping everything else the operator wrote. An existing
 * top-level line, or else a commented-out `# key = ...` one, is replaced in
 * place; otherwise the setting goes under the `hostname` line, or with no such
 * line before the first table, where top-level keys must be. With
 * `addDefaults`, append the default sizes and, unless the file already
 * mentions `[preset_images]`, the default preset images.
 */
export function renderConfig(
  contents: string | undefined,
  {
    hostname,
    secretKey,
    secretStore,
    addDefaults,
  }: {
    hostname: string;
    /** `undefined` to keep no secret key in the file (the keychain has it). */
    secretKey: string | undefined;
    /** `secret_store` to set, if any; `undefined` leaves the file's as is. */
    secretStore?: SecretStoreKind;
    addDefaults: boolean;
  },
): string {
  const lines =
    contents === undefined
      ? [
          "# amika-hostd configuration, written by `amika-hostd setup`.",
          ...(secretKey === undefined
            ? []
            : [
                "# It holds the secret key, so keep it readable only by you (mode 600).",
              ]),
          "# Every setting is described in ~/.local/share/amika-hostd/config.example.toml.",
        ]
      : contents.replace(/\s+$/, "").split("\n");
  // The key bare or quoted (`"hostname" = ...`), as TOML allows.
  const keyPattern = (key: string) => `(${key}|"${key}"|'${key}')`;
  const liveLine = (key: string) => new RegExp(`^\\s*${keyPattern(key)}\\s*=`);
  const topEndOf = () => {
    const start = lines.findIndex((line) => /^\s*\[/.test(line));
    return start === -1 ? lines.length : start;
  };
  if (secretKey === undefined) {
    const at = lines
      .slice(0, topEndOf())
      .findIndex((l) => liveLine("secret_key").test(l));
    if (at !== -1) lines.splice(at, 1);
  }
  const tableStart = lines.findIndex((line) => /^\s*\[/.test(line));
  const topEnd = topEndOf();
  const missing: string[] = [];
  const settings: [string, string][] = [["hostname", hostname]];
  if (secretKey !== undefined) settings.push(["secret_key", secretKey]);
  if (secretStore !== undefined) settings.push(["secret_store", secretStore]);
  for (const [key, value] of settings) {
    const line = `${key} = ${JSON.stringify(value)}`;
    const top = lines.slice(0, topEnd);
    // A live line, else the commented-out one the example documents.
    const name = keyPattern(key);
    const live = top.findIndex((l) => liveLine(key).test(l));
    const at =
      live !== -1
        ? live
        : top.findIndex((l) => new RegExp(`^#\\s*${name}\\s*=`).test(l));
    if (at === -1) missing.push(line);
    else lines[at] = line;
  }
  // Settings the file has no line for go under its hostname line, if it has
  // one, rather than apart from it.
  const hostnameAt = lines
    .slice(0, topEnd)
    .findIndex((l) => liveLine("hostname").test(l));
  if (missing.length > 0 && hostnameAt !== -1) {
    lines.splice(hostnameAt + 1, 0, ...missing);
  } else if (missing.length > 0 && tableStart === -1) {
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
 * `file` without a top-level `secret_key` that could never be used (the
 * example's `REPLACE_ME`, say), for reading what setup should keep and for
 * `up` deciding whether setup is needed. The written file still replaces
 * that line in place.
 */
export function withoutInvalidSecret(file: HostdConfigFile): HostdConfigFile {
  const line =
    /^\s*(?:secret_key|"secret_key"|'secret_key')\s*=\s*(["'])(.*?)\1\s*(#.*)?$/m;
  const value = line.exec(file.contents)?.[2];
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

function warnAboutEnvironment(deps: SetupDeps, secretHome: string) {
  for (const [setting, key, home] of [
    ["hostname", "hostname", "the file"],
    ["secret store", "secretStore", "the file"],
    ["secret key", "secretKey", secretHome],
  ] as const) {
    const name = envName(deps.env, key);
    if (name !== undefined) {
      deps.out(
        `Note: ${name} is set in your environment and overrides the ${setting} in ${home}.`,
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
