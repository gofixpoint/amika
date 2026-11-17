import { describe, expect, it } from "vitest";
import {
  amikadRelease,
  TOOLCHAIN_LOCK,
  toolchainLockJson,
  toolchainPlatform,
} from "./index";

describe("toolchain lockfile", () => {
  it("pins every archive by sha256 for both platforms", () => {
    for (const tool of TOOLCHAIN_LOCK.tools) {
      if (tool.kind !== "archive") continue;
      for (const platform of ["linux/amd64", "linux/arm64"] as const) {
        const artifact = tool.artifacts?.[platform];
        expect(artifact?.url, `${tool.name} ${platform}`).toMatch(/^https:/);
        expect(artifact?.sha256, `${tool.name} ${platform}`).toMatch(
          /^[0-9a-f]{64}$/,
        );
      }
    }
  });

  it("gives the control plane amikad's release", () => {
    const { version, artifact } = amikadRelease("linux/arm64");
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    expect(artifact.url).toContain(`amikad@v${version}`);
  });

  it("serializes for amikad install", () => {
    expect(JSON.parse(toolchainLockJson())).toEqual(TOOLCHAIN_LOCK);
  });

  it("maps uname -m", () => {
    expect(toolchainPlatform("x86_64\n")).toBe("linux/amd64");
    expect(toolchainPlatform("aarch64")).toBe("linux/arm64");
    expect(toolchainPlatform("riscv64")).toBeNull();
  });
});
