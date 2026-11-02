/**
 * The platform registry: the one place that maps an OS to its
 * `HostPlatform`, and the only module that reads `process.platform`.
 */
import { darwinPlatform } from "./darwin.js";
import { linuxPlatform } from "./linux.js";
import type { HostPlatform } from "./platform.js";
import type { PlatformDeps } from "./shared.js";
import { unsupportedPlatform } from "./unsupported.js";

export {
  PlatformUnsupportedError,
  type AmikadAsset,
  type HostPlatform,
  type HostResources,
  type PlatformCapabilities,
  type ProcessField,
} from "./platform.js";
export type { PlatformDeps } from "./shared.js";

/** The platform hostd runs on, resolved once. */
export function currentHostPlatform(): HostPlatform {
  current ??= hostPlatformFor(process.platform);
  return current;
}

/** The platform for OS `name`; tests pass `deps` to fake what it reads. */
export function hostPlatformFor(
  name: NodeJS.Platform,
  deps: PlatformDeps = {},
): HostPlatform {
  const build = PLATFORMS[name];
  return build ? build(deps) : unsupportedPlatform(name);
}

/** A platform given by name or already resolved; unset, this machine's. */
export function toHostPlatform(
  platform: HostPlatform | NodeJS.Platform | undefined,
): HostPlatform {
  if (platform === undefined) return currentHostPlatform();
  return typeof platform === "string" ? hostPlatformFor(platform) : platform;
}

let current: HostPlatform | undefined;

const PLATFORMS: Partial<
  Record<NodeJS.Platform, (deps: PlatformDeps) => HostPlatform>
> = {
  linux: linuxPlatform,
  darwin: darwinPlatform,
};
