import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { hostPlatformFor } from "../platforms/index.js";
import { DaemonError } from "./daemon.js";
import {
  buildMacosImage,
  findMacosImageFiles,
  MACOS_BASE_VM,
  missingMacosImages,
  type MacosImageDeps,
} from "./lume-setup.js";

const LUME = "/home/op/.local/bin/lume";
const FILES = {
  buildScript: "/opt/hostd/macos-image/build.sh",
  versionsEnv: "/opt/hostd/macos-image/versions.env",
};

/** A Mac whose Lume storage has `vms`; each command exits with `exit`. */
function mac({ vms = [] as string[], exit = 0 } = {}) {
  const out: string[] = [];
  const run = vi.fn(
    async (
      _command: string,
      _args: readonly string[],
      _env: NodeJS.ProcessEnv,
    ) => exit as number | null,
  );
  const deps = {
    env: { PATH: "/usr/bin", HOME: "/home/op" },
    out: (line: string) => out.push(line),
    platform: hostPlatformFor("darwin", { arch: () => "arm64" } as never),
    findLume: () => LUME,
    hasLumeVm: vi.fn(async (_lume: string, name: string) => vms.includes(name)),
    run,
    imageFiles: () => FILES,
    installAmikad: vi.fn(async () => "/data/amikad/0.3.0/amikad"),
  } satisfies MacosImageDeps;
  return { deps, out, run };
}

describe("missingMacosImages", () => {
  it("names the templates Lume does not have, once each", async () => {
    const { deps } = mac({ vms: ["amika-macos-coder"] });
    expect(
      await missingMacosImages(
        ["amika-macos-coder", "my-image", "my-image"],
        deps,
      ),
    ).toEqual(["my-image"]);
  });

  it("names them all when Lume is not installed", async () => {
    const { deps } = mac();
    expect(
      await missingMacosImages(["amika-macos-coder"], {
        ...deps,
        findLume: () => undefined,
      }),
    ).toEqual(["amika-macos-coder"]);
    expect(deps.hasLumeVm).not.toHaveBeenCalled();
  });
});

describe("buildMacosImage", () => {
  it("makes the base VM, then runs build.sh with hostd's amikad and pins", async () => {
    const { deps, run } = mac();
    await buildMacosImage("amika-macos-coder", {}, deps);
    expect(run.mock.calls.map(([command, args]) => [command, args])).toEqual([
      [
        LUME,
        ["create", "--ipsw", "latest", "--unattended", "tahoe", MACOS_BASE_VM],
      ],
      ["/bin/bash", [FILES.buildScript, MACOS_BASE_VM, "amika-macos-coder"]],
    ]);
    const env = run.mock.calls[1][2];
    expect(env).toMatchObject({
      AMIKAD_BIN: "/data/amikad/0.3.0/amikad",
      VERSIONS_ENV: FILES.versionsEnv,
      // build.sh parses Lume's JSON with it, needing no python3.
      NODE: process.execPath,
    });
    // build.sh calls `lume` by name.
    expect(env.PATH?.split(path.delimiter)[0]).toBe(path.dirname(LUME));
  });

  it("reuses a base VM that is already there", async () => {
    const { deps, run } = mac({ vms: [MACOS_BASE_VM] });
    await buildMacosImage("amika-macos-coder", {}, deps);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0]).toBe("/bin/bash");
  });

  it("installs from the restore image AMIKA_HOSTD_MACOS_IPSW names", async () => {
    const { deps, run } = mac();
    await buildMacosImage(
      "amika-macos-coder",
      {},
      {
        ...deps,
        env: { ...deps.env, AMIKA_HOSTD_MACOS_IPSW: "/srv/macos-26.5.2.ipsw" },
      },
    );
    expect(run.mock.calls[0][1]).toContain("/srv/macos-26.5.2.ipsw");
  });

  it("stops at a failed step, naming it", async () => {
    const { deps, run } = mac({ exit: 1 });
    await expect(
      buildMacosImage("amika-macos-coder", {}, deps),
    ).rejects.toThrow(/lume create.*failed \(exit 1\)/);
    expect(run).toHaveBeenCalledOnce();
    expect(deps.installAmikad).not.toHaveBeenCalled();
  });

  it("refuses without Lume or without the build files", async () => {
    const { deps } = mac();
    await expect(
      buildMacosImage("x", {}, { ...deps, findLume: () => undefined }),
    ).rejects.toThrow(DaemonError);
    await expect(
      buildMacosImage("x", {}, { ...deps, imageFiles: () => undefined }),
    ).rejects.toThrow(/no macOS image build files/);
  });
});

describe("findMacosImageFiles", () => {
  it("finds this checkout's build.sh and version pins from the source", () => {
    const repo = path.resolve(import.meta.dirname, "..", "..", "..", "..");
    expect(findMacosImageFiles(import.meta.dirname)).toEqual({
      buildScript: path.join(repo, "macos-image", "build.sh"),
      versionsEnv: path.join(repo, "sandbox-image", "versions.env"),
    });
  });

  it("finds nothing where neither layout is", () => {
    expect(findMacosImageFiles("/nonexistent/a/b/c/d")).toBeUndefined();
  });
});
