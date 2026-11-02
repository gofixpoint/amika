/** hostd on Linux. */
import { PLATFORM_CAPABILITIES } from "./capabilities.js";
import { secretServiceKeychain } from "./keychains.js";
import { amikadArch } from "./amikad-arch.js";
import type { HostPlatform } from "./platform.js";
import {
  detectUnixResources,
  findSshdIn,
  procCommand,
  psCommand,
  type PlatformDeps,
} from "./shared.js";

/** Where distributions install `sshd`, which is rarely on a user's `PATH`. */
const SSHD_LOCATIONS = ["/usr/sbin/sshd", "/usr/local/sbin/sshd", "/sbin/sshd"];

export function linuxPlatform(deps: PlatformDeps = {}): HostPlatform {
  return {
    name: "linux",
    capabilities: PLATFORM_CAPABILITIES.linux,
    detectResources: () => detectUnixResources("linux", deps),
    findSshd: () => findSshdIn(SSHD_LOCATIONS, deps),
    sshdInstallHint:
      "install OpenSSH's server (`sudo apt install openssh-server`, or `sudo dnf install openssh-server`); amika-hostd runs its own sshd, so the system service need not be enabled",
    amikadAsset: () => ({ os: "linux", arch: amikadArch("linux", deps) }),
    keychain: (env, run) =>
      // The Secret Service lives on the session's D-Bus. Without a session bus
      // (no desktop or user session) there is no keychain. With one but no
      // keyring daemon on it, as over SSH to a server, secret-tool says so.
      env.DBUS_SESSION_BUS_ADDRESS?.trim()
        ? secretServiceKeychain(run)
        : undefined,
    // `/proc` names the program exactly; `ps` is the fallback for a kernel
    // mounted without it.
    processCommand: (pid, field) => procCommand(pid) ?? psCommand(pid, field),
  };
}
