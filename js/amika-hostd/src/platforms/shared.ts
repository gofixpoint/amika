/**
 * The parts of a platform that are the same on every Unix hostd supports,
 * each taking what it reads from the OS as a dependency so tests can fake
 * it.
 */
import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync, statfsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GuestOs } from "../internal/runtimes.js";
import type { HostResources, ProcessField } from "./platform.js";

/** What resource detection reads from the OS. */
export interface ResourceDeps {
  availableParallelism?: () => number;
  totalmem?: () => number;
  /** The home directory's filesystem: block size and block count. */
  statfs?: (dir: string) => { bsize: number; blocks: number };
  homedir?: () => string;
  arch?: () => string;
}

/** What `findSshd` reads from the OS. */
export interface SshdDeps {
  /** `PATH`, searched before the fixed locations. */
  path?: string;
  /** Whether `file` is an executable regular file. */
  isExecutable?: (file: string) => boolean;
}

/** What the smol checks read from the OS. */
export interface SmolDeps {
  /** The glibc version (`2.39`), or undefined for another C library. */
  glibcVersion?: () => string | undefined;
  /** `/dev/kvm`: missing, present but not usable by this user, or usable. */
  kvm?: () => "missing" | "denied" | "ok";
  /** Whether smolvm can find `resize2fs`. */
  hasResize2fs?: () => boolean;
}

/** Everything a Unix platform reads from the OS, injectable for tests. */
export type PlatformDeps = ResourceDeps & SshdDeps & SmolDeps;

/**
 * Where smolvm looks for `resize2fs` before `PATH` (`src/disk_utils.rs` in
 * smol-machines/smolvm).
 */
const RESIZE2FS_LOCATIONS = [
  "/opt/homebrew/opt/e2fsprogs/sbin",
  "/usr/local/opt/e2fsprogs/sbin",
  "/opt/homebrew/sbin",
  "/usr/local/sbin",
  "/sbin",
  "/usr/sbin",
].map((dir) => path.join(dir, "resize2fs"));

/**
 * A warning when smolvm cannot find `resize2fs`. smolvm copies each disk
 * from a 20 GiB template and shrinks it with `resize2fs`, so without it a
 * rig with a smaller disk does not start.
 */
export function resize2fsWarning(
  installHint: string,
  deps: SmolDeps = {},
): string | undefined {
  if ((deps.hasResize2fs ?? findsResize2fs)()) return undefined;
  return `resize2fs was not found. smolvm needs it to start a rig with a disk under 20 GiB. Install e2fsprogs: ${installHint}.`;
}

function findsResize2fs(): boolean {
  const fromPath = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((dir) => path.isAbsolute(dir))
    .map((dir) => path.join(dir, "resize2fs"));
  return [...RESIZE2FS_LOCATIONS, ...fromPath].some(executableFile);
}

const GIB = 1024 ** 3;

/**
 * Logical CPUs, total memory, and the size of the filesystem holding the
 * home directory, each as the OS reports it. GiB are rounded to one decimal.
 */
export function detectUnixResources(
  osName: GuestOs,
  deps: ResourceDeps = {},
): HostResources {
  const home = (deps.homedir ?? os.homedir)();
  const fs = (deps.statfs ?? statfsSync)(home);
  return {
    vcpus: (deps.availableParallelism ?? os.availableParallelism)(),
    memoryGib: roundGib((deps.totalmem ?? os.totalmem)()),
    diskGib: roundGib(fs.bsize * fs.blocks),
    os: osName,
    arch: (deps.arch ?? os.arch)(),
  };
}

/**
 * The first executable `sshd` on `PATH`, else in `fixed` (where packages
 * put it, which is often not on an unprivileged user's `PATH`).
 */
export function findSshdIn(
  fixed: readonly string[],
  deps: SshdDeps = {},
): string | undefined {
  const isExecutable = deps.isExecutable ?? executableFile;
  const fromPath = (deps.path ?? process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((dir) => path.isAbsolute(dir))
    .map((dir) => path.join(dir, "sshd"));
  return [...fromPath, ...fixed].find((file) => isExecutable(file));
}

/** The program `pid` runs, from `/proc`; undefined without one. */
export function procCommand(pid: number): string | undefined {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0];
  } catch {
    // No /proc, or the process just exited.
    return undefined;
  }
}

/**
 * The program `pid` runs, from `ps`; undefined if unknown. `ps` reports it
 * as `comm` (the executable) or as the first word of `command` (the argv,
 * which `process.title` rewrites).
 */
export function psCommand(
  pid: number,
  field: ProcessField,
): string | undefined {
  try {
    const shown = execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const program = field === "command" ? shown.split(/\s+/)[0] : shown;
    return program === "" ? undefined : program;
  } catch {
    return undefined;
  }
}

function roundGib(bytes: number): number {
  return Math.round((bytes / GIB) * 10) / 10;
}

function executableFile(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
