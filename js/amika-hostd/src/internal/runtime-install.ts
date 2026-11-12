/**
 * What each runtime needs on this machine, in one place, so `setup`,
 * `capabilities update` and `up` install the same things. `planInstalls`
 * checks the machine and lists what is missing, changing nothing; each
 * step's `run` installs it.
 *
 * - smol: smolvm, and the smolmachines engine the release pins.
 * - lume: Lume. The daemon builds the macOS image later (`lume-setup.ts`).
 * - bare_metal: an `sshd` binary and a state directory sshd accepts (checked
 *   only), and amikad.
 */
import { accessSync, constants, statSync } from "node:fs";
import { currentHostPlatform, type HostPlatform } from "../platforms/index.js";
import {
  amikadBinary,
  DEFAULT_AMIKAD_VERSION,
  ensureAmikad,
} from "./amikad-install.js";
import { ConfigError } from "./config.js";
import { daemonPaths, hostdDataDir } from "./daemon.js";
import { findLume, installLume, LUME_VERSION } from "./lume-setup.js";
import type { RuntimeName } from "./runtimes.js";
import {
  engineInstalled,
  findEngineFiles,
  installEngine,
  installSmolvm,
  pinnedEngine,
  smolvmVersionToInstall,
} from "./smol-setup.js";
import { findSmolvm } from "./smolvm-serve.js";
import {
  describeStrictModesViolation,
  strictModesViolation,
  type StrictModesViolation,
} from "./strict-modes.js";

/** One thing a runtime still needs on this machine. */
export interface InstallStep {
  runtime: RuntimeName;
  /** What it installs, in words, for the plan. */
  text: string;
  run(): Promise<void>;
}

export interface InstallPlan {
  steps: InstallStep[];
  /** What a runtime needs that hostd cannot install, with how to fix it. */
  warnings: string[];
}

export interface RuntimeInstallDeps {
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  /** The OS hostd runs on; defaults to this machine's. */
  platform?: HostPlatform;
  /** Finds smolvm; defaults to `findSmolvm`. */
  findSmolvm?: typeof findSmolvm;
  /** Installs smolvm; defaults to `installSmolvm`. */
  installSmolvm?: typeof installSmolvm;
  /** The release's engine files; defaults to `findEngineFiles`. */
  engineFiles?: typeof findEngineFiles;
  /** Installs the engine; defaults to `installEngine`. */
  installEngine?: typeof installEngine;
  /** Finds the `lume` binary; defaults to `findLume`. */
  findLume?: typeof findLume;
  /** Installs Lume; defaults to `installLume`. */
  installLume?: typeof installLume;
  /** Installs amikad and returns its path; defaults to `ensureAmikad`. */
  installAmikad?: typeof ensureAmikad;
  /**
   * The directory above or at `dir` that sshd's StrictModes refuses, if any;
   * defaults to checking this machine as the running account.
   */
  strictModesViolation?: (dir: string) => StrictModesViolation | undefined;
}

/**
 * Check that this machine can run each of `runtimes`, and list what each
 * still needs. A machine that cannot run one is refused here, before
 * anything changes.
 */
export function planInstalls(
  runtimes: Iterable<RuntimeName>,
  config: { amikadPath?: string },
  deps: RuntimeInstallDeps,
): InstallPlan {
  const plan: InstallPlan = { steps: [], warnings: [] };
  for (const runtime of new Set(runtimes)) {
    if (runtime === "smol") planSmol(plan, deps);
    if (runtime === "lume") planLume(plan, deps);
    if (runtime === "bare_metal") planBareMetal(plan, config, deps);
  }
  return plan;
}

/** Run each step of `plan`, in order. */
export async function runInstalls(plan: InstallPlan): Promise<void> {
  for (const step of plan.steps) await step.run();
}

function planSmol(plan: InstallPlan, deps: RuntimeInstallDeps): void {
  const platform = deps.platform ?? currentHostPlatform();
  const pkg = platform.smolEnginePackage();
  if (pkg === undefined) {
    throw new ConfigError(
      `smol cannot run on this machine: the smolmachines engine runs only on Linux (x64 or arm64, glibc 2.34+) and Apple Silicon Macs. Nothing was changed.`,
    );
  }
  plan.warnings.push(...platform.smolWarnings());
  if ((deps.findSmolvm ?? findSmolvm)(deps.env) === undefined) {
    plan.steps.push({
      runtime: "smol",
      text: `Install smolvm ${smolvmVersionToInstall(deps.env)} with its installer, into ~/.smolvm (no sudo)`,
      run: () => (deps.installSmolvm ?? installSmolvm)(deps),
    });
  }
  // A bundle run from a checkout has no engine files: pnpm installed it.
  const files = (deps.engineFiles ?? findEngineFiles)();
  if (files !== undefined && !engineInstalled(files, pkg)) {
    const { archive } = pinnedEngine(files, pkg);
    plan.steps.push({
      runtime: "smol",
      text: `Download the smolmachines engine (${archive}, over 100 MB) from npm into ${files.dir}/node_modules`,
      run: () => (deps.installEngine ?? installEngine)(pkg, files, deps),
    });
  }
}

function planLume(plan: InstallPlan, deps: RuntimeInstallDeps): void {
  if ((deps.findLume ?? findLume)(deps.env) !== undefined) return;
  plan.steps.push({
    runtime: "lume",
    text: `Install Lume ${LUME_VERSION} with its installer, into ~/.local/bin (downloads from GitHub; no sudo)`,
    run: () => (deps.installLume ?? installLume)(deps),
  });
}

function planBareMetal(
  plan: InstallPlan,
  config: { amikadPath?: string },
  deps: RuntimeInstallDeps,
): void {
  checkBareMetal(deps);
  const amikad = amikadBinary(config, deps.env);
  if (isExecutableFile(amikad)) return;
  if (config.amikadPath !== undefined) {
    throw new ConfigError(
      `amikad_path names ${config.amikadPath}, which is not an executable file`,
    );
  }
  plan.steps.push({
    runtime: "bare_metal",
    text: `Install amikad ${DEFAULT_AMIKAD_VERSION} into ${hostdDataDir(deps.env)}, for SSH to this machine (no sudo)`,
    run: async () => {
      await (deps.installAmikad ?? ensureAmikad)(config, {
        env: deps.env,
        platform: deps.platform ?? currentHostPlatform(),
        out: deps.out,
      });
    },
  });
}

/**
 * What the `bare_metal` runtime needs: an OS that runs it, an `sshd` binary
 * for amikad to run, and a state directory sshd's StrictModes accepts.
 * Returns the `sshd` found.
 */
export function checkBareMetal(
  deps: Pick<RuntimeInstallDeps, "env" | "platform" | "strictModesViolation">,
): string {
  const platform = deps.platform ?? currentHostPlatform();
  if (!platform.runtimes().includes("bare_metal")) {
    throw new ConfigError(
      `amika-hostd cannot make this machine a rig on ${platform.name}; nothing was changed`,
    );
  }
  const sshd = platform.findSshd();
  if (sshd === undefined) {
    throw new ConfigError(
      `The bare_metal runtime needs an sshd binary, and none was found: ${platform.sshdInstallHint}. Then try again; nothing was changed.`,
    );
  }
  const { amikadStateDir } = daemonPaths(deps.env);
  const violation = (
    deps.strictModesViolation ??
    ((dir) => strictModesViolation(dir, { uid: process.getuid?.() ?? -1 }))
  )(amikadStateDir);
  if (violation !== undefined) {
    throw new ConfigError(
      describeStrictModesViolation(violation, amikadStateDir),
    );
  }
  return sshd;
}

function isExecutableFile(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
