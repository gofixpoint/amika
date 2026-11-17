/**
 * The toolchain lockfile: the pinned tools a rig gets when it boots the
 * provider's own image instead of an Amika base image (`stockBootSource`).
 *
 * `sandbox-image/toolchain.py` generates `toolchain.lock.json` from
 * `sandbox-image/versions.env`; CI fails when the two disagree. The control
 * plane uploads the `amikad` artifact itself, then pipes this lockfile to
 * `amikad install`, which downloads the other tools and checks their sha256.
 */
import lockfile from "./toolchain.lock.json";

/** One platform's download of an archive tool. */
export interface ToolchainArtifact {
  url: string;
  sha256: string;
  format: "tar.gz" | "binary";
  strip?: number;
  bins: Array<{ path: string; name?: string }>;
}

/** One pinned tool. See `go/internal/amikad/toolchain/lockfile.go`. */
export interface ToolchainTool {
  name: string;
  version: string;
  tier: "eager" | "background" | "runtime";
  kind: "archive" | "npm";
  artifacts?: Partial<Record<ToolchainPlatform, ToolchainArtifact>>;
  package?: string;
  bins?: string[];
}

export interface ToolchainLock {
  schema: 1;
  tools: ToolchainTool[];
}

/** The platforms the lockfile covers. */
export type ToolchainPlatform = "linux/amd64" | "linux/arm64";

/** The lockfile shipped with this package version. */
export const TOOLCHAIN_LOCK = lockfile as ToolchainLock;

/** The lockfile as the JSON text `amikad install` reads on stdin. */
export function toolchainLockJson(): string {
  return JSON.stringify(TOOLCHAIN_LOCK);
}

/** The pinned amikad release: version, and the download for `platform`. */
export function amikadRelease(platform: ToolchainPlatform): {
  version: string;
  artifact: ToolchainArtifact;
} {
  const amikad = TOOLCHAIN_LOCK.tools.find((tool) => tool.name === "amikad");
  const artifact = amikad?.artifacts?.[platform];
  if (!amikad || !artifact) {
    throw new Error(`The toolchain lockfile has no amikad for ${platform}`);
  }
  return { version: amikad.version, artifact };
}

/** Map `uname -m` output to a lockfile platform, or null when unsupported. */
export function toolchainPlatform(machine: string): ToolchainPlatform | null {
  switch (machine.trim()) {
    case "x86_64":
    case "amd64":
      return "linux/amd64";
    case "aarch64":
    case "arm64":
      return "linux/arm64";
    default:
      return null;
  }
}
