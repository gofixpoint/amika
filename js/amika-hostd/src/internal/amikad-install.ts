/**
 * The amikad a bare-metal host runs: downloaded from amikad's GitHub
 * release into hostd's own data directory, verified against the release's
 * `checksums.txt`. No system path is written and nothing needs `sudo`.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  PlatformUnsupportedError,
  type HostPlatform,
} from "../platforms/index.js";
import { ConfigError } from "./config.js";
import { hostdDataDir } from "./daemon.js";

/**
 * The amikad release this hostd runs on a bare-metal host: the first with
 * user mode (`AMIKAD_STATE_DIR`) and a darwin build. Bump it with each
 * amikad release hostd is tested with.
 */
export const DEFAULT_AMIKAD_VERSION = "0.3.0";

/** Where amikad's releases are published, one directory per tag. */
export const AMIKAD_RELEASES_URL =
  "https://github.com/gofixpoint/amika/releases/download";

/** The amikad a bare-metal host runs: `amikad_path`, else the installed one. */
export function amikadBinary(
  config: { amikadPath?: string },
  env: NodeJS.ProcessEnv,
): string {
  return config.amikadPath ?? installedAmikadPath(env);
}

/** Where setup installs amikad `version`: one directory per version. */
export function installedAmikadPath(
  env: NodeJS.ProcessEnv,
  version = DEFAULT_AMIKAD_VERSION,
): string {
  return path.join(hostdDataDir(env), "amikad", version, "amikad");
}

export interface InstallAmikadDeps {
  env: NodeJS.ProcessEnv;
  platform: HostPlatform;
  out: (line: string) => void;
  version?: string;
  /** The releases directory; tests serve a fake one. */
  releasesUrl?: string;
  fetch?: typeof fetch;
  /** Unpack a `.tar.gz` into a directory; defaults to the system `tar`. */
  extract?: (archive: string, into: string) => Promise<void>;
}

/**
 * Make sure the amikad a bare-metal host runs is there, and return its path:
 * `amikad_path` as configured (never downloaded over), else the pinned
 * release in hostd's data directory, downloaded unless it is already
 * installed.
 */
export async function ensureAmikad(
  config: { amikadPath?: string },
  deps: InstallAmikadDeps,
): Promise<string> {
  if (config.amikadPath !== undefined) {
    if (!isExecutable(config.amikadPath)) {
      throw new ConfigError(
        `amikad_path names ${config.amikadPath}, which is not an executable file`,
      );
    }
    return config.amikadPath;
  }
  const version = deps.version ?? DEFAULT_AMIKAD_VERSION;
  const target = installedAmikadPath(deps.env, version);
  if (isExecutable(target)) return target;
  await download(version, target, deps);
  deps.out(`Installed amikad ${version} at ${target}`);
  return target;
}

/** The release's URL and archive name for `version` on this machine. */
export function amikadRelease(
  version: string,
  platform: HostPlatform,
  releasesUrl = AMIKAD_RELEASES_URL,
): { archive: string; archiveUrl: string; checksumsUrl: string } {
  let asset;
  try {
    asset = platform.amikadAsset();
  } catch (error) {
    if (error instanceof PlatformUnsupportedError) {
      throw new ConfigError(error.message);
    }
    throw error;
  }
  // As the Release workflow names them (`.github/workflows/release.yml`).
  const archive = `amikad_${version}_${asset.os}_${asset.arch}.tar.gz`;
  const tag = `${releasesUrl}/amikad@v${version}`;
  return {
    archive,
    archiveUrl: `${tag}/${archive}`,
    checksumsUrl: `${tag}/checksums.txt`,
  };
}

async function download(
  version: string,
  target: string,
  deps: InstallAmikadDeps,
): Promise<void> {
  const { archive, archiveUrl, checksumsUrl } = amikadRelease(
    version,
    deps.platform,
    deps.releasesUrl,
  );
  deps.out(`Downloading amikad ${version} from ${archiveUrl}`);
  const fetcher = deps.fetch ?? fetch;
  const checksums = (await fetchBytes(fetcher, checksumsUrl)).toString("utf8");
  const expected = checksumFor(checksums, archive);
  if (expected === undefined) {
    throw new ConfigError(
      `amikad ${version}'s checksums.txt lists no ${archive}; nothing was installed`,
    );
  }
  const bytes = await fetchBytes(fetcher, archiveUrl);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new ConfigError(
      `${archive} does not match amikad ${version}'s checksums.txt; nothing was installed`,
    );
  }
  // Unpacked beside its final place, then moved in whole, so a failed or
  // interrupted install never leaves a partial binary where hostd runs it.
  const parent = path.dirname(target);
  mkdirSync(path.dirname(parent), { recursive: true, mode: 0o700 });
  const staging = `${parent}.${randomBytes(8).toString("hex")}.tmp`;
  mkdirSync(staging, { mode: 0o700 });
  try {
    const file = path.join(staging, archive);
    writeFileSync(file, bytes, { mode: 0o600 });
    await (deps.extract ?? untar)(file, staging);
    const unpacked = path.join(
      staging,
      archive.replace(/\.tar\.gz$/, ""),
      "amikad",
    );
    if (!isFile(unpacked)) {
      throw new ConfigError(
        `${archive} holds no amikad binary; nothing was installed`,
      );
    }
    const installing = path.join(staging, "install");
    mkdirSync(installing, { mode: 0o755 });
    renameSync(unpacked, path.join(installing, "amikad"));
    chmodSync(path.join(installing, "amikad"), 0o755);
    rmSync(parent, { recursive: true, force: true });
    renameSync(installing, parent);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function fetchBytes(fetcher: typeof fetch, url: string): Promise<Buffer> {
  let response: Response;
  try {
    // GitHub answers a release asset with a redirect to its storage; no
    // credential is sent, so following it is safe.
    response = await fetcher(url, { signal: AbortSignal.timeout(300_000) });
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

/** The sha256 `checksums.txt` (`sha256sum` output) gives `name`. */
function checksumFor(checksums: string, name: string): string | undefined {
  for (const line of checksums.split("\n")) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (match && match[2] === name) return match[1];
  }
  return undefined;
}

const execFileAsync = promisify(execFile);

/** The system `tar`, by argv: GNU tar and bsdtar both read `-xzf`. */
async function untar(archive: string, into: string): Promise<void> {
  try {
    await execFileAsync("tar", ["-xzf", archive, "-C", into]);
  } catch {
    throw new ConfigError(`cannot unpack ${path.basename(archive)} with tar`);
  }
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return isFile(file);
  } catch {
    return false;
  }
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
