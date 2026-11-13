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
import { execFile, execFileSync, spawn } from "node:child_process";
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LumeCli } from "@amika/sandbox/lume";
import type { HostPlatform } from "../platforms/index.js";
import { ensureAmikad } from "./amikad-install.js";
import { ConfigError, ENV_NAMES } from "./config.js";
import { DaemonError } from "./daemon.js";
import { MACOS_DISK_GIB } from "./runtime-update.js";

/** Lume's release that milestone 0 of spec 028 tested. */
export const LUME_VERSION = "0.6.1";

/** The VM Lume's unattended install makes, which each image is cloned from. */
export const MACOS_BASE_VM = "amika-macos-base";

/**
 * What building a macOS image costs, for the warning before it starts: the
 * restore image (about 20 GB, kept for a rebuild), the base VM (about
 * 21 GB), and the template, an APFS clone of it (about 9 GB more).
 */
export const MACOS_IMAGE_COST =
  "This downloads a macOS restore image from Apple (about 20 GB) and keeps it for a rebuild, needs about 50 GB of free disk, and takes 30 minutes or more.";

/**
 * Where hostd keeps Apple's restore image once Lume has downloaded it, so a
 * new base VM needs no download. It is outside hostd's data folder, which
 * the installer's `--uninstall` deletes; `amika-hostd uninstall` asks first.
 */
export function macosRestoreImageDir(env: NodeJS.ProcessEnv): string {
  const cacheHome =
    env.XDG_CACHE_HOME || path.join(env.HOME || homedir(), ".cache");
  return path.join(cacheHome, "amika-hostd", "macos");
}

/**
 * Lume's opt-out from its usage telemetry, set for every `lume` hostd runs
 * here: the installer's first run of the new binary (which records an
 * installation event), `lume get`, and each build step. The daemon also
 * turns it off for good when Lume is on; these run before it starts.
 */
export const LUME_NO_TELEMETRY = { LUME_TELEMETRY_ENABLED: "false" } as const;

/**
 * The unattended-setup preset for a macOS version, as `lume create
 * --unattended` takes it. `--ipsw latest` installs this Mac's own major
 * version, so the preset follows the host's. Lume 0.6.1 has presets for
 * macOS 15 (`sequoia`) and 26 (`tahoe`); a newer version gets the newest
 * one, which its offline setup barely depends on.
 */
export function unattendedPreset(macosVersion: string): string {
  const major = Number.parseInt(macosVersion, 10);
  return Number.isFinite(major) && major <= 15 ? "sequoia" : "tahoe";
}

/** What `lume --version` prints, such as `0.6.1`. */
async function readLumeVersion(
  lume: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      lume,
      ["--version"],
      {
        env: { ...withoutAmikaSecrets(env), ...LUME_NO_TELEMETRY },
        timeout: 30_000,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim().split("\n").at(-1)?.trim() ?? "");
      },
    );
  });
}

/** This Mac's macOS version, such as `26.6.2`. */
function hostMacosVersion(): string {
  return execFileSync("/usr/bin/sw_vers", ["-productVersion"], {
    encoding: "utf8",
  }).trim();
}

/**
 * `env` without Amika's API key and secret key: Lume's installer is fetched
 * from GitHub, and neither it nor the build needs them.
 */
export function withoutAmikaSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const secrets: readonly string[] = [
    ...ENV_NAMES.apiKey,
    ...ENV_NAMES.secretKey,
  ];
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !secrets.includes(name)),
  );
}

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
  /** Runs the installer; defaults to `runToStderr`. */
  run?: typeof runToStderr;
}): Promise<void> {
  const script = `https://raw.githubusercontent.com/trycua/cua/lume-v${LUME_VERSION}/libs/lume/scripts/install.sh`;
  deps.out(`Installing Lume ${LUME_VERSION}...`);
  const code = await (deps.run ?? runToStderr)(
    "/bin/bash",
    [
      "-c",
      `set -o pipefail; curl -fsSL ${script} | bash -s -- --no-background-service`,
    ],
    // The installer runs the new binary once, which honours the opt-out.
    { ...withoutAmikaSecrets(deps.env), LUME_VERSION, ...LUME_NO_TELEMETRY },
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
  /** Stops the build's commands once this aborts (the daemon is stopping). */
  signal?: AbortSignal;
  /** This Mac's macOS version; defaults to `sw_vers -productVersion`. */
  macosVersion?: () => string;
  /** The version `lume` reports; defaults to `lume --version`. */
  lumeVersion?: (lume: string) => Promise<string>;
}

/** Of `templates`, the ones Lume's default storage does not have. */
export async function missingMacosImages(
  templates: readonly string[],
  deps: Pick<MacosImageDeps, "env" | "findLume" | "hasLumeVm">,
): Promise<string[]> {
  const lume = (deps.findLume ?? findLume)(deps.env);
  // With no Lume there are no VMs either.
  if (lume === undefined) return [...templates];
  const has =
    deps.hasLumeVm ??
    ((lumeBin: string, name: string) => hasLumeVm(lumeBin, name, deps.env));
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
 * running this again. The restore image is the one `AMIKA_HOSTD_MACOS_IPSW`
 * names, else the one hostd kept for this Mac's macOS version, else Lume's
 * newest supported one, which hostd then keeps.
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
  // The build, and the presets `unattendedPreset` names, are tested with
  // one Lume release; hostd installs it, but uses a Lume already there.
  const found = await reported(`Reading ${lume}'s version`, () =>
    deps.lumeVersion ? deps.lumeVersion(lume) : readLumeVersion(lume, deps.env),
  );
  if (found !== LUME_VERSION) {
    throw new DaemonError(
      `${lume} is Lume ${found || "of an unknown version"}, but amika-hostd builds macOS images with Lume ${LUME_VERSION}; install it with \`curl -fsSL https://raw.githubusercontent.com/trycua/cua/lume-v${LUME_VERSION}/libs/lume/scripts/install.sh | LUME_VERSION=${LUME_VERSION} bash -s -- --no-background-service\``,
    );
  }
  const runCommand = deps.run ?? runToStderr;
  const run = (
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ) =>
    reported(`Starting ${path.basename(command)}`, () =>
      runCommand(command, args, env, deps.signal),
    );
  const hasVm =
    deps.hasLumeVm ??
    ((lumeBin: string, name: string) => hasLumeVm(lumeBin, name, deps.env));
  const has = (lumeBin: string, name: string) =>
    reported(`Checking Lume for ${name}`, () => hasVm(lumeBin, name));
  // build.sh calls `lume` by name, and the installer puts it in ~/.local/bin,
  // which a daemon's or an agent's PATH can lack.
  const env = {
    ...withoutAmikaSecrets(deps.env),
    ...LUME_NO_TELEMETRY,
    PATH: [path.dirname(lume), deps.env.PATH]
      .filter(Boolean)
      .join(path.delimiter),
  };
  deps.out(`Building the macOS image ${template}. ${MACOS_IMAGE_COST}`);
  if (!(await has(lume, MACOS_BASE_VM))) {
    const version = await reported(
      "Reading this Mac's macOS version",
      async () => (deps.macosVersion ?? hostMacosVersion)(),
    );
    const preset = unattendedPreset(version);
    const kept = keptRestoreImage(deps.env, version);
    const ipsw =
      deps.env.AMIKA_HOSTD_MACOS_IPSW?.trim() ||
      (kept !== undefined && existsSync(kept) ? kept : "latest");
    deps.out(
      `Installing macOS into the base VM ${MACOS_BASE_VM}, from ${ipsw === "latest" ? "the newest restore image Lume supports" : ipsw}, with the ${preset} setup preset (this Mac runs macOS ${version})...`,
    );
    const started = Date.now();
    // Lume reads `GB` as GiB. Its progress lines are thinned out
    // (`runShowingProgress`): the download alone prints one per percent.
    const code = await reported("Starting lume", () =>
      (deps.run ?? runShowingProgress)(
        lume,
        [
          "create",
          "--ipsw",
          ipsw,
          "--disk-size",
          `${MACOS_DISK_GIB}GB`,
          "--unattended",
          preset,
          MACOS_BASE_VM,
        ],
        env,
        deps.signal,
      ),
    );
    // After a failed create too, so a retry needs no download.
    if (ipsw === "latest" && kept !== undefined) {
      keepRestoreImage(deps.env, kept, started, deps.out);
    }
    if (code !== 0) {
      const retry =
        ipsw === kept
          ? `; if the restore image is bad, delete ${kept} to download it again`
          : "";
      throw new DaemonError(
        `\`lume create\` failed (exit ${code}) making the base VM ${MACOS_BASE_VM}; its output is above${retry}`,
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
 * The restore image hostd keeps for macOS `version`'s major version, since
 * the unattended preset follows it; undefined for a version it cannot read.
 */
function keptRestoreImage(
  env: NodeJS.ProcessEnv,
  version: string,
): string | undefined {
  const major = Number.parseInt(version, 10);
  if (!Number.isFinite(major)) return undefined;
  return path.join(macosRestoreImageDir(env), `restore-macos${major}.ipsw`);
}

/**
 * Move the restore image `lume create --ipsw latest` left in the temp folder
 * to `kept`, and delete any other kept one. Only a file written since
 * `since`: an older one can be another macOS version. Lume names the file
 * only once its download is complete. A failure here does not fail the build.
 */
function keepRestoreImage(
  env: NodeJS.ProcessEnv,
  kept: string,
  since: number,
  out: (line: string) => void,
): void {
  const download = path.join(env.TMPDIR || tmpdir(), "latest.ipsw");
  try {
    if (!existsSync(download) || statSync(download).mtimeMs < since) return;
    const dir = path.dirname(kept);
    mkdirSync(dir, { recursive: true });
    try {
      renameSync(download, kept);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      const partial = `${kept}.partial`;
      copyFileSync(download, partial);
      renameSync(partial, kept);
      rmSync(download);
    }
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      if (file !== kept) rmSync(file, { force: true });
    }
    out(`Kept the restore image in ${kept}, for a rebuild.`);
  } catch (error) {
    out(
      `Could not keep the restore image ${download}: ${(error as Error).message}`,
    );
  }
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

export interface BackgroundImageOptions extends Omit<
  MacosImageDeps,
  "platform"
> {
  platform: HostPlatform;
  /** The templates the Lume presets boot. */
  templates: readonly string[];
  /** Where `amikad_path` points, if set; else hostd's own amikad release. */
  config: { amikadPath?: string };
  err: (line: string) => void;
  /**
   * Holds each template while it is built, so the machine API can refuse a
   * Lume rig of it at once (`503`) instead of failing on a missing template.
   * Kept in memory: it is live state, gone when the daemon is.
   */
  building?: Set<string>;
  /** Builds one template; defaults to `buildMacosImage`. */
  build?: typeof buildMacosImage;
}

/**
 * Build each template a Lume preset boots that Lume does not have, one at a
 * time, as the daemon pre-pulls smol's images: in the background, so nothing
 * waits on it. Never throws: a failure is logged, and the next
 * `amika-hostd up` or `reload` tries again. The daemon stopping stops it.
 */
export async function buildMacosImagesInBackground(
  options: BackgroundImageOptions,
): Promise<void> {
  const { templates, config, out, err, signal, building } = options;
  let missing: string[];
  try {
    missing = await missingMacosImages(templates, options);
  } catch (error) {
    err(
      `amika-hostd: could not check Lume for its macOS images: ${errorText(error)}; the next \`amika-hostd up\` tries again`,
    );
    return;
  }
  // Every missing template is unavailable until its own build is done, not
  // only the one being built: they are built one at a time.
  for (const template of missing) building?.add(template);
  try {
    for (const template of missing) {
      if (signal?.aborted) return;
      const started = Date.now();
      try {
        await (options.build ?? buildMacosImage)(template, config, options);
        out(
          `Built the macOS image ${template} for Lume rigs (${Math.round((Date.now() - started) / 60_000)} min)`,
        );
      } catch (error) {
        // The daemon stopping, or Lume turned off, cuts the build short;
        // that is no failure.
        if (signal?.aborted) return;
        err(
          `amika-hostd: could not build the macOS image ${template}: ${errorText(error)}; Lume rigs of it fail until it is built, and the next \`amika-hostd up\` or \`amika-hostd reload\` tries again`,
        );
      } finally {
        building?.delete(template);
      }
    }
  } finally {
    // Those never started (a stop cut the queue short) are not building.
    for (const template of missing) building?.delete(template);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function hasLumeVm(
  lume: string,
  name: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  return (
    (await new LumeCli(undefined, lume, quietLumeRunner(env)).get(name)) !==
    null
  );
}

/**
 * How `LumeCli` runs `lume` for hostd here: as its own runner does, but
 * with `env` and the telemetry opt-out, since its default inherits this
 * process's environment.
 */
function quietLumeRunner(
  env: NodeJS.ProcessEnv,
): ConstructorParameters<typeof LumeCli>[2] {
  return (command, args, opts = {}) =>
    new Promise((resolve, reject) => {
      execFile(
        command,
        args,
        {
          env: {
            ...withoutAmikaSecrets(opts.env ?? env),
            ...LUME_NO_TELEMETRY,
          },
          encoding: "buffer",
          timeout: opts.timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          // A numeric code is the exit status; anything else (ENOENT, a
          // timeout's kill) is a failure to run it at all.
          if (error && typeof error.code !== "number") {
            reject(error);
            return;
          }
          resolve({ exitCode: error ? Number(error.code) : 0, stdout, stderr });
        },
      );
    });
}

/** Run `command`, its output on stderr; resolve to its exit code. */
export function runToStderr(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  /**
   * Sends the command `SIGTERM` once this aborts. The promise still settles
   * only when the command has exited, so its own cleanup (build.sh deletes a
   * half-built template on exit) is done by then.
   */
  signal?: AbortSignal,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", process.stderr, process.stderr],
    });
    const stop = () => child.kill("SIGTERM");
    if (signal?.aborted) stop();
    else signal?.addEventListener("abort", stop, { once: true });
    const settle = () => signal?.removeEventListener("abort", stop);
    child.once("error", (error) => {
      settle();
      reject(error);
    });
    child.once("close", (code) => {
      settle();
      resolve(code);
    });
  });
}

/**
 * Like `runToStderr`, for a command that prints progress such as `lume
 * create`: its lines reach stderr as it prints them, with its progress lines
 * thinned out (`progressFilter`). It runs under `script(1)`, in a terminal:
 * with its output in a pipe or the daemon's log, Lume buffers it, and an
 * hour of download reached the log in one burst.
 */
export function runShowingProgress(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  /**
   * Sends `script` `SIGTERM` once this aborts, which closes the terminal,
   * so the command gets `SIGHUP`.
   */
  signal?: AbortSignal,
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    // With no input, script sends the terminal an end of file, which it
    // echoes as `^D` and two backspaces.
    const child = spawn(
      "/usr/bin/script",
      ["-q", "/dev/null", command, ...args],
      {
        env,
        stdio: ["ignore", "pipe", process.stderr],
      },
    );
    const show = progressFilter(write);
    let partial = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const lines = (partial + chunk).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) show(cleanLine(line));
    });
    const stop = () => child.kill("SIGTERM");
    if (signal?.aborted) stop();
    else signal?.addEventListener("abort", stop, { once: true });
    const settle = () => signal?.removeEventListener("abort", stop);
    child.once("error", (error) => {
      settle();
      reject(error);
    });
    child.once("close", (code) => {
      settle();
      if (partial !== "") show(cleanLine(partial));
      resolve(code);
    });
  });
}

/** A terminal's line as the log takes it: no `^D` echo, no carriage return. */
function cleanLine(line: string): string {
  const echo = "^D\b\b";
  return (line.startsWith(echo) ? line.slice(echo.length) : line).replace(
    /\r$/,
    "",
  );
}

/** Lume's progress lines: `Downloading IPSW Progress: 57%`, `Installing macOS progress=31%`. */
const PROGRESS_LINE = /\b([A-Z][\w ]*?)\s+progress\s*[:=]\s*(\d+)%/i;

/**
 * `write`, passing each line on, but of each kind of progress line (Lume's
 * download, then its install) only the first, the last at 100%, and one
 * each time progress has gained `step` percent or `intervalMs` has passed
 * since the last one shown, whichever comes first.
 */
export function progressFilter(
  write: (line: string) => void,
  {
    step = 5,
    intervalMs = 2 * 60_000,
    now = Date.now,
  }: { step?: number; intervalMs?: number; now?: () => number } = {},
): (line: string) => void {
  const shown = new Map<string, { percent: number; at: number }>();
  return (line) => {
    const match = PROGRESS_LINE.exec(line);
    if (!match) {
      write(line);
      return;
    }
    const kind = match[1].toLowerCase();
    const percent = Number(match[2]);
    const last = shown.get(kind);
    if (
      last === undefined ||
      percent >= last.percent + step ||
      now() - last.at >= intervalMs ||
      (percent >= 100 && last.percent < 100)
    ) {
      shown.set(kind, { percent, at: now() });
      write(line);
    }
  };
}
