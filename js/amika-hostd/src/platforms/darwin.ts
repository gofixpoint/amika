/** hostd on macOS. */
import { PLATFORM_CAPABILITIES } from "./capabilities.js";
import { macOSKeychain } from "./keychains.js";
import { amikadArch } from "./amikad-arch.js";
import type { HostPlatform } from "./platform.js";
import {
  detectUnixResources,
  findSshdIn,
  procCommand,
  psCommand,
  type PlatformDeps,
} from "./shared.js";

export function darwinPlatform(deps: PlatformDeps = {}): HostPlatform {
  return {
    name: "darwin",
    capabilities: PLATFORM_CAPABILITIES.darwin,
    detectResources: () => detectUnixResources("darwin", deps),
    // macOS ships one; amika-hostd runs its own copy of it, unprivileged.
    findSshd: () => findSshdIn(["/usr/sbin/sshd"], deps),
    sshdInstallHint:
      "macOS ships /usr/sbin/sshd; if it is missing, reinstall the command-line tools or restore it from a macOS update",
    amikadAsset: () => ({ os: "darwin", arch: amikadArch("darwin", deps) }),
    keychain: (_env, run) => macOSKeychain(run),
    // macOS has no `/proc`; trying it first costs one failed open and keeps
    // the lookup identical to the one hostd made before platforms existed.
    processCommand: (pid, field) => procCommand(pid) ?? psCommand(pid, field),
  };
}
