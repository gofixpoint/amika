/**
 * hostd on an OS it has no implementation for: no capabilities, so setup
 * refuses bare metal, the keychain store refuses (naming the file store),
 * and anything that needs the OS's own answer throws
 * `PlatformUnsupportedError`.
 */
import { PLATFORM_CAPABILITIES } from "./capabilities.js";
import { PlatformUnsupportedError, type HostPlatform } from "./platform.js";
import { procCommand, psCommand } from "./shared.js";

export function unsupportedPlatform(name: NodeJS.Platform): HostPlatform {
  return {
    name,
    capabilities: PLATFORM_CAPABILITIES.unsupported,
    detectResources: () => {
      throw new PlatformUnsupportedError(name, "bare-metal hosts");
    },
    findSshd: () => undefined,
    sshdInstallHint: `amika-hostd does not support bare-metal hosts on ${name}`,
    amikadAsset: () => {
      throw new PlatformUnsupportedError(name, "amikad");
    },
    keychain: () => undefined,
    // `down` still confirms a pid before signalling it, as it always has.
    processCommand: (pid, field) => procCommand(pid) ?? psCommand(pid, field),
  };
}
