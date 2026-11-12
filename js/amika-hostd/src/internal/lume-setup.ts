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
import { accessSync, constants, existsSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LumeCli } from "@amika/sandbox/lume";
import type { HostPlatform } from "../platforms/index.js";
import { ensureAmikad } from "./amikad-install.js";
import { ConfigError, ENV_NAMES } from "./config.js";
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
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      lume,
      ["--version"],
      {
        env: { ...withoutAmikaSecrets(env), ...LUME_NO_TELEMETRY },
        timeout: 30_000,
        signal,
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
  hasLumeVm?: (
    lume: string,
    name: string,
    signal?: AbortSignal,
  ) => Promise<boolean>;
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
  deps: Pick<MacosImageDeps, "env" | "findLume" | "hasLumeVm" | "signal">,
): Promise<string[]> {
  const lume = (deps.findLume ?? findLume)(deps.env);
  // With no Lume there are no VMs either.
  if (lume === undefined) return [...templates];
  const has =
    deps.hasLumeVm ??
    ((lumeBin: string, name: string, signal?: AbortSignal) =>
      hasLumeVm(lumeBin, name, deps.env, signal));
  const missing: string[] = [];
  for (const template of new Set(templates)) {
    // The daemon stopping, or Lume turned off, ends the check.
    deps.signal?.throwIfAborted();
    const found = await reported(`Checking Lume for ${template}`, () =>
      has(lume, template, deps.signal),
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
  // The build, and the presets `unattendedPreset` names, are tested with
  // one Lume release; hostd installs it, but uses a Lume already there.
  const found = await reported(`Reading ${lume}'s version`, () =>
    deps.lumeVersion
      ? deps.lumeVersion(lume)
      : readLumeVersion(lume, deps.env, deps.signal),
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
    ((lumeBin: string, name: string, signal?: AbortSignal) =>
      hasLumeVm(lumeBin, name, deps.env, signal));
  const has = (lumeBin: string, name: string) =>
    reported(`Checking Lume for ${name}`, () =>
      hasVm(lumeBin, name, deps.signal),
    );
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
    const ipsw = deps.env.AMIKA_HOSTD_MACOS_IPSW?.trim() || "latest";
    const version = await reported(
      "Reading this Mac's macOS version",
      async () => (deps.macosVersion ?? hostMacosVersion)(),
    );
    const preset = unattendedPreset(version);
    deps.signal?.throwIfAborted();
    deps.out(
      `Installing macOS into the base VM ${MACOS_BASE_VM}, from ${ipsw === "latest" ? "the newest restore image Lume supports" : ipsw}, with the ${preset} setup preset (this Mac runs macOS ${version})...`,
    );
    let code: number | null;
    try {
      code = await run(
        lume,
        ["create", "--ipsw", ipsw, "--unattended", preset, MACOS_BASE_VM],
        env,
      );
    } catch (error) {
      await removeHalfMadeBaseVm(lume, env, deps);
      throw error;
    }
    if (code !== 0) {
      // Failed or stopped partway (the daemon stopping, or Lume turned
      // off): a base VM left behind would pass for a finished one next time.
      const removed = await removeHalfMadeBaseVm(lume, env, deps);
      throw new DaemonError(
        `\`lume create\` failed (exit ${code}) making the base VM ${MACOS_BASE_VM}; its output is above. ${removed}`,
      );
    }
  }
  deps.signal?.throwIfAborted();
  const amikad = await (deps.installAmikad ?? ensureAmikad)(config, {
    env: deps.env,
    platform: deps.platform,
    out: deps.out,
    signal: deps.signal,
  });
  deps.signal?.throwIfAborted();
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

/** How long deleting a half-made base VM may take, a stop included. */
const BASE_VM_CLEANUP_MS = 60_000;

/**
 * Delete the base VM a `lume create` that did not finish left behind, and
 * say what became of it. Only called when the VM was not there before that
 * create, so it is never one hostd did not make. It runs even once the
 * build was told to stop, on a deadline of its own, short enough that
 * `amika-hostd down` still sees the daemon stop.
 */
async function removeHalfMadeBaseVm(
  lume: string,
  env: NodeJS.ProcessEnv,
  deps: MacosImageDeps,
): Promise<string> {
  const deadline = AbortSignal.timeout(BASE_VM_CLEANUP_MS);
  const manual = `delete it with \`lume delete ${MACOS_BASE_VM} --force\` before the next try`;
  try {
    const exists = await (
      deps.hasLumeVm ??
      ((lumeBin: string, name: string, signal?: AbortSignal) =>
        hasLumeVm(lumeBin, name, deps.env, signal))
    )(lume, MACOS_BASE_VM, deadline);
    if (!exists) return `No base VM ${MACOS_BASE_VM} was left behind.`;
    deps.out(`Deleting the half-made base VM ${MACOS_BASE_VM}...`);
    const code = await (deps.run ?? runToStderr)(
      lume,
      ["delete", MACOS_BASE_VM, "--force"],
      env,
      deadline,
    );
    if (code === 0) return `Deleted the half-made base VM ${MACOS_BASE_VM}.`;
    return `Could not delete the half-made base VM ${MACOS_BASE_VM} (\`lume delete\` exit ${code}); ${manual}.`;
  } catch (error) {
    return `Could not delete the half-made base VM ${MACOS_BASE_VM} (${errorText(error)}); ${manual}.`;
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
  const wanted = [...new Set(templates)];
  // Each template is unavailable from the start, before Lume is asked which
  // it has: the daemon already serves, and a create of a missing one would
  // otherwise reach Lume and fail for good (400) instead of 503. Those Lume
  // has are released once it says so. Every missing one stays held until its
  // own build is done, not only the one being built: they are built one at
  // a time.
  for (const template of wanted) building?.add(template);
  let missing: string[] = [];
  try {
    try {
      missing = await missingMacosImages(wanted, options);
    } catch (error) {
      // The daemon stopping, or Lume turned off, cut the check short.
      if (signal?.aborted) return;
      err(
        `amika-hostd: could not check Lume for its macOS images: ${errorText(error)}; the next \`amika-hostd up\` tries again`,
      );
      return;
    }
    for (const template of wanted) {
      if (!missing.includes(template)) building?.delete(template);
    }
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
    // Those never started (a stop or a failed check cut the queue short)
    // are not building.
    for (const template of wanted) building?.delete(template);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function hasLumeVm(
  lume: string,
  name: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<boolean> {
  return (
    (await new LumeCli(undefined, lume, quietLumeRunner(env, signal)).get(
      name,
    )) !== null
  );
}

/**
 * How `LumeCli` runs `lume` for hostd here: as its own runner does, but
 * with `env` and the telemetry opt-out, since its default inherits this
 * process's environment.
 */
function quietLumeRunner(
  env: NodeJS.ProcessEnv,
  /** Kills `lume` once this aborts, so a hung `lume get` holds up no stop. */
  signal?: AbortSignal,
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
          signal,
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
   * Sends the command and every process it started `SIGTERM` once this
   * aborts. The promise still settles only when the command has exited, so
   * its own cleanup (build.sh deletes a half-built template on exit) is done
   * by then.
   */
  signal?: AbortSignal,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    // In a process group of its own, so a stop reaches the command's
    // children too: build.sh waiting on `lume clone` would otherwise exit
    // and leave the clone running, to finish a template nobody deletes.
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", process.stderr, process.stderr],
      detached: true,
    });
    const stop = () => {
      try {
        if (child.pid === undefined) throw new Error("not started");
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    };
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
