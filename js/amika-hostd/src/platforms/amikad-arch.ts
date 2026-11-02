/** The CPU architecture in amikad's release names. */
import os from "node:os";
import { PlatformUnsupportedError, type AmikadAsset } from "./platform.js";

/** Go's name for this machine's architecture, as amikad's releases use it. */
export function amikadArch(
  platform: string,
  deps: { arch?: () => string } = {},
): AmikadAsset["arch"] {
  const arch = (deps.arch ?? os.arch)();
  if (arch === "x64") return "amd64";
  if (arch === "arm64") return "arm64";
  throw new PlatformUnsupportedError(`${platform}/${arch}`, "amikad");
}
