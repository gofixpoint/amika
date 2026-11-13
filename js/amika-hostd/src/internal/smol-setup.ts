/**
 * What turning on the `smol` runtime installs: smolvm, which runs Linux
 * rigs, and the smolmachines engine (smolvm, embedded) that the release pins
 * for this platform. Setup, `capabilities update` and `up` install them
 * through `runtime-install.ts`.
 *
 * The engine is shipped for the planned move from `smolvm serve` to the
 * embedded engine; the daemon does not load it yet.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ConfigError } from "./config.js";
import { runToStderr, withoutAmikaSecrets } from "./lume-setup.js";
import { findSmolvm } from "./smolvm-serve.js";

/**
 * The smolvm installed when none is found: the release hostd is tested
 * with, so a new smolvm release cannot reach a new host untested.
 * `AMIKA_HOSTD_SMOLVM_VERSION` chooses another, or `latest`.
 */
export const DEFAULT_SMOLVM_VERSION = "1.32.3";

/** smolvm's own installer. It installs into `~/.smolvm`, with no `sudo`. */
export const SMOLVM_INSTALL_URL = "https://smolmachines.com/install.sh";

/** Where the engine package is downloaded from, unless the env names another. */
export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";

/** The smolvm version to install: the env's, else `DEFAULT_SMOLVM_VERSION`. */
export function smolvmVersionToInstall(env: NodeJS.ProcessEnv): string {
  const version = env.AMIKA_HOSTD_SMOLVM_VERSION?.trim().replace(/^v/, "");
  return version || DEFAULT_SMOLVM_VERSION;
}

/** Run smolvm's installer for `smolvmVersionToInstall`, its output on stderr. */
export async function installSmolvm(deps: {
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  fetch?: typeof fetch;
  /** Runs the installer; defaults to `runToStderr`. */
  run?: typeof runToStderr;
  /** Finds smolvm afterwards; defaults to `findSmolvm`. */
  findSmolvm?: typeof findSmolvm;
}): Promise<void> {
  const version = smolvmVersionToInstall(deps.env);
  deps.out(`Installing smolvm ${version}...`);
  const script = await fetchBytes(deps.fetch ?? fetch, SMOLVM_INSTALL_URL);
  const dir = mkdtempSync(path.join(tmpdir(), "amika-hostd-smolvm-"));
  try {
    const file = path.join(dir, "install.sh");
    writeFileSync(file, script, { mode: 0o600 });
    // With no --version, smolvm's installer picks its newest release.
    const args = version === "latest" ? [] : ["--version", version];
    const code = await (deps.run ?? runToStderr)(
      "/bin/bash",
      [file, ...args],
      withoutAmikaSecrets(deps.env),
    );
    if (code !== 0) {
      throw new ConfigError(
        `smolvm's installer failed (exit ${code}); nothing else was changed`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if ((deps.findSmolvm ?? findSmolvm)(deps.env) === undefined) {
    throw new ConfigError(
      "smolvm's installer finished, but smolvm is not in ~/.smolvm or ~/.local/bin",
    );
  }
}

/** The engine files a release puts beside the bundle. */
export interface EngineFiles {
  /** The directory holding `engines.sha256` and `node_modules/`. */
  dir: string;
  /** `engines.sha256`: each platform's engine archive and its sha256. */
  checksums: string;
}

/**
 * The release's engine files beside the bundle. A bundle run from a
 * checkout has none: pnpm installs the engine there.
 */
export function findEngineFiles(
  here = path.dirname(fileURLToPath(import.meta.url)),
): EngineFiles | undefined {
  const file = path.join(here, "engines.sha256");
  if (!existsSync(file)) return undefined;
  return { dir: here, checksums: readFileSync(file, "utf8") };
}

/** The engine archive `files` pins for `pkg`, and its version and sha256. */
export function pinnedEngine(
  files: EngineFiles,
  pkg: string,
): { archive: string; version: string; sha256: string } {
  for (const line of files.checksums.split("\n")) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (match && match[2].startsWith(`${pkg}-`)) {
      return {
        archive: match[2],
        version: match[2].slice(pkg.length + 1).replace(/\.tgz$/, ""),
        sha256: match[1],
      };
    }
  }
  throw new ConfigError(
    `this amika-hostd release has no ${pkg} engine; reinstall amika-hostd`,
  );
}

/** Whether the engine `files` pins for `pkg` is installed beside them. */
export function engineInstalled(files: EngineFiles, pkg: string): boolean {
  const { version } = pinnedEngine(files, pkg);
  try {
    const manifest = JSON.parse(
      readFileSync(
        path.join(files.dir, "node_modules", pkg, "package.json"),
        "utf8",
      ),
    ) as { version?: unknown };
    return manifest.version === version;
  } catch {
    return false;
  }
}

/**
 * Download the engine `files` pins for `pkg` from npm, check it against
 * `engines.sha256`, and unpack it into `node_modules/<pkg>` beside the
 * bundle, where the smolmachines SDK looks for it. An engine from an earlier
 * release is replaced whole.
 */
export async function installEngine(
  pkg: string,
  files: EngineFiles,
  deps: {
    env: NodeJS.ProcessEnv;
    out: (line: string) => void;
    fetch?: typeof fetch;
    /** Unpack a `.tgz` into a directory; defaults to the system `tar`. */
    extract?: (archive: string, into: string) => Promise<void>;
  },
): Promise<void> {
  const { archive, sha256 } = pinnedEngine(files, pkg);
  const registry = (
    deps.env.AMIKA_HOSTD_NPM_REGISTRY?.trim() || DEFAULT_NPM_REGISTRY
  ).replace(/\/+$/, "");
  const url = `${registry}/${pkg}/-/${archive}`;
  deps.out(`Downloading the smolmachines engine from ${url}`);
  const bytes = await fetchBytes(deps.fetch ?? fetch, url);
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) {
    throw new ConfigError(
      `${archive} does not match this release's engines.sha256; nothing was installed`,
    );
  }
  // Unpacked beside its final place, then moved in whole, so a failed
  // install never leaves part of an engine where the SDK loads it.
  const modules = path.join(files.dir, "node_modules");
  const target = path.join(modules, pkg);
  mkdirSync(modules, { recursive: true });
  const staging = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  mkdirSync(staging, { mode: 0o755 });
  try {
    const file = path.join(staging, archive);
    writeFileSync(file, bytes, { mode: 0o600 });
    const unpacked = path.join(staging, "package");
    mkdirSync(unpacked);
    await (deps.extract ?? untar)(file, unpacked);
    rmSync(target, { recursive: true, force: true });
    renameSync(unpacked, target);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  deps.out(`Installed the ${pkg} engine (${archive.replace(/\.tgz$/, "")})`);
}

async function fetchBytes(fetcher: typeof fetch, url: string): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetcher(url, { signal: AbortSignal.timeout(600_000) });
  } catch (error) {
    throw new ConfigError(
      `cannot download ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new ConfigError(`cannot download ${url}: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

const execFileAsync = promisify(execFile);

/** The system `tar`. An npm archive holds one `package/` directory. */
async function untar(archive: string, into: string): Promise<void> {
  try {
    await execFileAsync("tar", [
      "-xzf",
      archive,
      "-C",
      into,
      "--strip-components=1",
    ]);
  } catch {
    throw new ConfigError(`cannot unpack ${path.basename(archive)} with tar`);
  }
}
