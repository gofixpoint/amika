/** What hostd can offer on each OS, in one table. */
import type { PlatformCapabilities } from "./platform.js";

/**
 * Linux and macOS run smolvm VMs and bare-metal rigs, and have a keychain
 * (the Secret Service needs a session bus besides, which
 * `HostPlatform.keychain` checks). Every other OS offers nothing yet;
 * Windows is the likely next one, through Win32-OpenSSH.
 */
export const PLATFORM_CAPABILITIES = {
  linux: { bareMetal: true, vmRuntime: true, keychain: true },
  darwin: { bareMetal: true, vmRuntime: true, keychain: true },
  unsupported: { bareMetal: false, vmRuntime: false, keychain: false },
} as const satisfies Record<string, PlatformCapabilities>;
