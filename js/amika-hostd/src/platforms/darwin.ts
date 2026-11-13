/** hostd on macOS. */
import { macOSKeychain } from "./keychains.js";
import os from "node:os";
import { amikadArch } from "./amikad-arch.js";
import type { HostPlatform } from "./platform.js";
import {
  detectUnixResources,
  findSshdIn,
  procCommand,
  psCommand,
  resize2fsWarning,
  type PlatformDeps,
} from "./shared.js";

export function darwinPlatform(deps: PlatformDeps = {}): HostPlatform {
  const appleSilicon = () => (deps.arch ?? os.arch)() === "arm64";
  return {
    name: "darwin",
    detectResources: () => detectUnixResources("macos", deps),
    // macOS ships one; amika-hostd runs its own copy of it, unprivileged.
    findSshd: () => findSshdIn(["/usr/sbin/sshd"], deps),
    sshdInstallHint:
      "macOS ships /usr/sbin/sshd; if it is missing, reinstall the command-line tools or restore it from a macOS update",
    amikadAsset: () => ({ os: "darwin", arch: amikadArch("darwin", deps) }),
    // Lume runs macOS VMs with Virtualization.framework, and the smolmachines
    // engine has a build for Apple Silicon only.
    runtimes: () =>
      appleSilicon() ? ["smol", "lume", "bare_metal"] : ["bare_metal"],
    smolEnginePackage: () =>
      appleSilicon() ? "smolmachines-darwin-arm64" : undefined,
    smolWarnings: () =>
      [resize2fsWarning("`brew install e2fsprogs`", deps)].filter(
        (warning) => warning !== undefined,
      ),
    keychain: (_env, run) => macOSKeychain(run),
    // macOS has no `/proc`; trying it first costs one failed open and keeps
    // the lookup identical to the one hostd made before platforms existed.
    processCommand: (pid, field) => procCommand(pid) ?? psCommand(pid, field),
  };
}
