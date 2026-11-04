/**
 * What hostd asks of the operating system it runs on, behind one interface:
 * one implementation per OS, and a registry (`./index.ts`) that picks one by
 * `process.platform`. Linux and macOS are implemented; anything else resolves
 * to an implementation that runs no runtimes and refuses what it cannot do.
 *
 * Resolved once (`currentHostPlatform`) and passed through `deps`, so a test
 * chooses the OS rather than inheriting the machine's. Nothing outside
 * `src/platforms/` reads `process.platform` (enforced by lint).
 */
import type { GuestOs, RuntimeName } from "../internal/runtimes.js";
import type { Keychain, Runner } from "./keychains.js";

/**
 * This machine's capacity, as the `bare_metal` runtime reports it to Amika.
 * Always detected, never configured.
 */
export interface HostResources {
  /** Logical CPUs. */
  vcpus: number;
  memoryGib: number;
  /** The size of the filesystem holding the operator's home directory. */
  diskGib: number;
  /** In the names Amika gives a rig's OS. */
  os: GuestOs;
  arch: string;
}

/** Which amikad release binary fits this machine, in the release's names. */
export interface AmikadAsset {
  os: "linux" | "darwin";
  arch: "amd64" | "arm64";
}

/** How `processCommand` reads a process's program. */
export type ProcessField =
  /** The executable (`ps -o comm`). */
  | "comm"
  /** The first word of the argv, which `process.title` rewrites. */
  | "command";

export interface HostPlatform {
  /** The `process.platform` this implementation is for. */
  readonly name: NodeJS.Platform;
  /** Logical CPUs, total memory, and the home directory's filesystem. */
  detectResources(): HostResources;
  /** The absolute path of an `sshd` binary, or undefined if none is found. */
  findSshd(): string | undefined;
  /** How the operator installs `sshd` when `findSshd` finds none. */
  readonly sshdInstallHint: string;
  /** The amikad release binary for this machine. */
  amikadAsset(): AmikadAsset;
  /** The runtimes this machine can run rigs with; none on an unknown OS. */
  runtimes(): RuntimeName[];
  /**
   * The system keychain hostd keeps secrets in, or undefined where it
   * supports none (Linux without a session bus, say).
   */
  keychain(env: NodeJS.ProcessEnv, run: Runner): Keychain | undefined;
  /**
   * The program `pid` runs, or undefined if unknown, for confirming a pid
   * before signalling it.
   */
  processCommand(pid: number, field: ProcessField): string | undefined;
}

/** An operation this OS does not support. The message is safe to print. */
export class PlatformUnsupportedError extends Error {
  override name = "PlatformUnsupportedError";

  constructor(
    readonly platform: string,
    readonly operation: string,
  ) {
    super(`amika-hostd does not support ${operation} on ${platform}`);
  }
}
