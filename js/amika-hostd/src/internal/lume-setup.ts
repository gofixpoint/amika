/**
 * What turning on the `lume` runtime installs on a Mac: Lume itself, and the
 * macOS image each Lume preset boots. Setup and `capabilities update` both
 * use it, so a host that offers Lume to Amika can run its rigs.
 *
 * The image is built here, not downloaded: Lume makes a base VM from Apple's
 * restore image (`lume create --unattended`), and `macos-image/build.sh`,
 * which the release ships next to the bundle, clones it and installs Amika's
 * tools in the clone. Both are slow and large, so callers warn first
 * (`MACOS_IMAGE_COST`).
 */
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LumeCli } from "@amika/sandbox/lume";
import type { HostPlatform } from "../platforms/index.js";
import { ensureAmikad } from "./amikad-install.js";
import { ConfigError } from "./config.js";
import { DaemonError } from "./daemon.js";

/** Lume's release that milestone 0 of spec 028 tested. */
export const LUME_VERSION = "0.6.1";

/** The VM Lume's unattended install makes, which each image is cloned from. */
export const MACOS_BASE_VM = "amika-macos-base";

/**
 * What building a macOS image costs, for the warning before it starts. The
 * restore image is about 20 GB; the base VM, the image and Lume's copy of the
 * restore image take most of the rest.
 */
export const MACOS_IMAGE_COST =
  "This downloads a macOS restore image from Apple (about 20 GB), needs about 60 GB of free disk, and takes 30 minutes or more.";

/** Where `lume` is: on `PATH`, else where Lume's installer puts it. */
export function findLume(env: NodeJS.ProcessEnv): string | undefined {
  const dirs = [
    ...(env.PATH ?? "").split(path.delimiter).filter(Boolean),
    path.join(env.HOME || userInfo().homedir, ".local", "bin"),
  ];
  for (const dir of dirs) {
    const candidate = path.join(dir, "lume");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return undefined;
}

/** Run Lume's installer for `LUME_VERSION`, its output on stderr. */
export async function installLume(deps: {
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
}): Promise<void> {
  const script = `https://raw.githubusercontent.com/trycua/cua/lume-v${LUME_VERSION}/libs/lume/scripts/install.sh`;
  deps.out(`Installing Lume ${LUME_VERSION}...`);
  const code = await runToStderr(
    "/bin/bash",
    [
      "-c",
      `set -o pipefail; curl -fsSL ${script} | bash -s -- --no-background-service`,
    ],
    { ...deps.env, LUME_VERSION },
  );
  if (code !== 0 || findLume(deps.env) === undefined) {
    throw new DaemonError(
      `Lume's installer failed (exit ${code}); nothing else was changed`,
    );
  }
}

/** The files `buildMacosImage` runs, from this install of amika-hostd. */
export interface MacosImageFiles {
  /** `macos-image/build.sh`. */
  buildScript: string;
  /** The version pins the image's steps read (`sandbox-image/versions.env`). */
  versionsEnv: string;
}

/**
 * The image build files: in a release, `macos-image/` beside the bundle,
 * with its own `versions.env`; run from a checkout (the bundle in
 * `dist/bundle/`, or the source in `src/internal/`), the repository's.
 */
export function findMacosImageFiles(
  here = path.dirname(fileURLToPath(import.meta.url)),
): MacosImageFiles | undefined {
  const repo = path.resolve(here, "..", "..", "..", "..");
  const candidates: MacosImageFiles[] = [
    {
      buildScript: path.join(here, "macos-image", "build.sh"),
      versionsEnv: path.join(here, "macos-image", "versions.env"),
    },
    {
      buildScript: path.join(repo, "macos-image", "build.sh"),
      versionsEnv: path.join(repo, "sandbox-image", "versions.env"),
    },
  ];
  return candidates.find(
    (files) => existsSync(files.buildScript) && existsSync(files.versionsEnv),
  );
}

export interface MacosImageDeps {
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  platform: HostPlatform;
  /** Finds the `lume` binary; defaults to `findLume`. */
  findLume?: (env: NodeJS.ProcessEnv) => string | undefined;
  /** Whether Lume's default storage has VM `name`; defaults to `lume get`. */
  hasLumeVm?: (lume: string, name: string) => Promise<boolean>;
  /** Runs a long command with its output on stderr; returns its exit code. */
  run?: typeof runToStderr;
  /** The build files; defaults to `findMacosImageFiles`. */
  imageFiles?: () => MacosImageFiles | undefined;
  /** Installs the amikad the image carries; defaults to `ensureAmikad`. */
  installAmikad?: typeof ensureAmikad;
}

/** Of `templates`, the ones Lume's default storage does not have. */
export async function missingMacosImages(
  templates: readonly string[],
  deps: Pick<MacosImageDeps, "env" | "findLume" | "hasLumeVm">,
): Promise<string[]> {
  const lume = (deps.findLume ?? findLume)(deps.env);
  // With no Lume there are no VMs either.
  if (lume === undefined) return [...templates];
  const has = deps.hasLumeVm ?? hasLumeVm;
  const missing: string[] = [];
  for (const template of new Set(templates)) {
    const found = await reported(`Checking Lume for ${template}`, () =>
      has(lume, template),
    );
    if (!found) missing.push(template);
  }
  return missing;
}

/**
 * Build the macOS image `template` in Lume's default storage: make the base
 * VM from Apple's restore image unless it is already there, then run
 * `macos-image/build.sh` with the amikad release hostd installs. Each step
 * is skipped when its result exists, so a failed build is retried by
 * running this again. The restore image is Lume's newest supported one,
 * unless `AMIKA_HOSTD_MACOS_IPSW` names a file or URL.
 */
export async function buildMacosImage(
  template: string,
  config: { amikadPath?: string },
  deps: MacosImageDeps,
): Promise<void> {
  const lume = (deps.findLume ?? findLume)(deps.env);
  if (lume === undefined) {
    throw new DaemonError(
      "Lume is not installed; `amika-hostd capabilities update --enable lume` installs it",
    );
  }
  const files = (deps.imageFiles ?? findMacosImageFiles)();
  if (files === undefined) {
    throw new DaemonError(
      "this amika-hostd has no macOS image build files (macos-image/); reinstall amika-hostd",
    );
  }
  const runCommand = deps.run ?? runToStderr;
  const run: typeof runToStderr = (command, args, env) =>
    reported(`Starting ${path.basename(command)}`, () =>
      runCommand(command, args, env),
    );
  const hasVm = deps.hasLumeVm ?? hasLumeVm;
  const has = (lumeBin: string, name: string) =>
    reported(`Checking Lume for ${name}`, () => hasVm(lumeBin, name));
  // build.sh calls `lume` by name, and the installer puts it in ~/.local/bin,
  // which a daemon's or an agent's PATH can lack.
  const env = {
    ...deps.env,
    PATH: [path.dirname(lume), deps.env.PATH]
      .filter(Boolean)
      .join(path.delimiter),
  };
  deps.out(`Building the macOS image ${template}. ${MACOS_IMAGE_COST}`);
  if (!(await has(lume, MACOS_BASE_VM))) {
    const ipsw = deps.env.AMIKA_HOSTD_MACOS_IPSW?.trim() || "latest";
    deps.out(
      `Installing macOS into the base VM ${MACOS_BASE_VM}, from ${ipsw === "latest" ? "the newest restore image Lume supports" : ipsw}...`,
    );
    const code = await run(
      lume,
      ["create", "--ipsw", ipsw, "--unattended", "tahoe", MACOS_BASE_VM],
      env,
    );
    if (code !== 0) {
      throw new DaemonError(
        `\`lume create\` failed (exit ${code}) making the base VM ${MACOS_BASE_VM}; its output is above`,
      );
    }
  }
  const amikad = await (deps.installAmikad ?? ensureAmikad)(config, {
    env: deps.env,
    platform: deps.platform,
    out: deps.out,
  });
  deps.out(`Installing Amika's tools into ${template}...`);
  const code = await run(
    "/bin/bash",
    [files.buildScript, MACOS_BASE_VM, template],
    // NODE: build.sh reads Lume's JSON with hostd's own Node, so a Mac
    // without python3 (no Command Line Tools) can build the image.
    {
      ...env,
      AMIKAD_BIN: amikad,
      VERSIONS_ENV: files.versionsEnv,
      NODE: process.execPath,
    },
  );
  if (code !== 0) {
    throw new DaemonError(
      `macos-image/build.sh failed (exit ${code}) building ${template}; its output is above`,
    );
  }
  deps.out(`Built the macOS image ${template}.`);
}

/**
 * `work`, with a failure the CLI would not report (Lume's own, such as
 * storage it cannot read, or a command that will not start) turned into a
 * `DaemonError` naming `what`, which it prints. The original is its cause.
 */
async function reported<T>(what: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof DaemonError || error instanceof ConfigError) {
      throw error;
    }
    throw new DaemonError(
      `${what} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function hasLumeVm(lume: string, name: string): Promise<boolean> {
  return (await new LumeCli(undefined, lume).get(name)) !== null;
}

/** Run `command`, its output on stderr; resolve to its exit code. */
export function runToStderr(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", process.stderr, process.stderr],
    });
    child.once("error", reject);
    child.once("close", resolve);
  });
}
