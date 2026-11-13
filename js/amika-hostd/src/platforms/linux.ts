/** hostd on Linux. */
import { accessSync, constants, existsSync } from "node:fs";
import os from "node:os";
import { secretServiceKeychain } from "./keychains.js";
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

/** Where distributions install `sshd`, which is rarely on a user's `PATH`. */
const SSHD_LOCATIONS = ["/usr/sbin/sshd", "/usr/local/sbin/sshd", "/sbin/sshd"];

/** The smolmachines engine runs on this glibc or newer. */
const GLIBC_MIN = [2, 34] as const;

export function linuxPlatform(deps: PlatformDeps = {}): HostPlatform {
  // Read once: the glibc check blocks, and reload asks on every run.
  let engine: { name: string | undefined } | undefined;
  const enginePackage = () => (engine ??= { name: findEnginePackage() }).name;
  const findEnginePackage = () => {
    const arch = ENGINE_ARCH[(deps.arch ?? os.arch)()];
    const glibc = (deps.glibcVersion ?? runningGlibc)();
    if (arch === undefined || glibc === undefined) return undefined;
    const [major, minor] = glibc.split(".").map(Number);
    const recent =
      major > GLIBC_MIN[0] || (major === GLIBC_MIN[0] && minor >= GLIBC_MIN[1]);
    return recent ? `smolmachines-linux-${arch}-gnu` : undefined;
  };
  return {
    name: "linux",
    detectResources: () => detectUnixResources("linux", deps),
    findSshd: () => findSshdIn(SSHD_LOCATIONS, deps),
    sshdInstallHint:
      "install OpenSSH's server (`sudo apt install openssh-server`, or `sudo dnf install openssh-server`); amika-hostd runs its own sshd, so the system service need not be enabled",
    amikadAsset: () => ({ os: "linux", arch: amikadArch("linux", deps) }),
    // The smolmachines engine needs glibc 2.34+ on x64 or arm64.
    runtimes: () =>
      enginePackage() === undefined ? ["bare_metal"] : ["smol", "bare_metal"],
    smolEnginePackage: enginePackage,
    smolWarnings: () =>
      [
        kvmWarning((deps.kvm ?? kvmAccess)()),
        resize2fsWarning(
          "`sudo apt-get install e2fsprogs`, or your distribution's package",
          deps,
        ),
      ].filter((warning) => warning !== undefined),
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

/** `os.arch()` to the name in the engine's package. */
const ENGINE_ARCH: Record<string, string | undefined> = {
  x64: "x64",
  arm64: "arm64",
};

/** smolvm runs VMs with KVM on Linux. */
function kvmWarning(kvm: "missing" | "denied" | "ok"): string | undefined {
  if (kvm === "missing") {
    return "/dev/kvm was not found. smolvm needs KVM to run VMs. Turn on hardware virtualization (in the firmware, or nested virtualization on a cloud VM), then load the module: `sudo modprobe kvm_intel` (or `kvm_amd`).";
  }
  if (kvm === "denied") {
    return "This user cannot use /dev/kvm, which smolvm needs to run VMs. Run `sudo usermod -aG kvm $USER`, then log out and back in.";
  }
  return undefined;
}

function kvmAccess(): "missing" | "denied" | "ok" {
  if (!existsSync("/dev/kvm")) return "missing";
  try {
    accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
    return "ok";
  } catch {
    return "denied";
  }
}

/** The glibc this Node runs on; undefined on musl, which reports none. */
function runningGlibc(): string | undefined {
  // The network part of the report looks up every open socket. Node 22.13+
  // reads this; its types lack it.
  if (process.report) {
    (process.report as { excludeNetwork?: boolean }).excludeNetwork = true;
  }
  const report = process.report?.getReport() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;
  return report?.header?.glibcVersionRuntime;
}
