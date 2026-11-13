import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConfigError } from "./config.js";
import {
  DEFAULT_SMOLVM_VERSION,
  engineInstalled,
  installEngine,
  installSmolvm,
  pinnedEngine,
  smolvmVersionToInstall,
  type EngineFiles,
} from "./smol-setup.js";

const PKG = "smolmachines-linux-x64-gnu";

/** A release's engine files, pinning an npm archive of `version`. */
function release(version = "1.22.2") {
  const root = mkdtempSync(path.join(tmpdir(), "amika-hostd-engine-"));
  const src = path.join(root, "src", "package");
  mkdirSync(src, { recursive: true });
  writeFileSync(path.join(src, "package.json"), JSON.stringify({ version }));
  const archive = `${PKG}-${version}.tgz`;
  const tgz = path.join(root, archive);
  execFileSync("tar", ["-czf", tgz, "-C", path.dirname(src), "package"]);
  const bytes = readFileSync(tgz);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const files: EngineFiles = {
    dir: path.join(root, "hostd"),
    checksums: `${sha}  ${archive}\n`,
  };
  mkdirSync(files.dir);
  const fetcher = vi.fn(async () => new Response(bytes));
  return { files, fetcher, archive };
}

describe("pinnedEngine", () => {
  it("reads the archive, version and sha256 the release pins", () => {
    const { files, archive } = release("1.22.2");
    expect(pinnedEngine(files, PKG)).toMatchObject({
      archive,
      version: "1.22.2",
    });
  });

  it("refuses a release with no engine for this platform", () => {
    const { files } = release();
    expect(() => pinnedEngine(files, "smolmachines-darwin-arm64")).toThrow(
      ConfigError,
    );
  });
});

describe("installEngine", () => {
  it("downloads the pinned engine from the registry and unpacks it", async () => {
    const { files, fetcher, archive } = release();
    expect(engineInstalled(files, PKG)).toBe(false);
    await installEngine(PKG, files, {
      env: { AMIKA_HOSTD_NPM_REGISTRY: "https://npm.example/" },
      out: () => {},
      fetch: fetcher,
    });
    expect(fetcher).toHaveBeenCalledWith(
      `https://npm.example/${PKG}/-/${archive}`,
      expect.anything(),
    );
    expect(engineInstalled(files, PKG)).toBe(true);
  });

  it("installs nothing that does not match the checksum", async () => {
    const { files } = release();
    await expect(
      installEngine(PKG, files, {
        env: {},
        out: () => {},
        fetch: async () => new Response("tampered"),
      }),
    ).rejects.toThrow(/does not match/);
    expect(existsSync(path.join(files.dir, "node_modules", PKG))).toBe(false);
  });

  it("counts an engine from another release as not installed", async () => {
    const old = release("1.22.1");
    await installEngine(PKG, old.files, {
      env: {},
      out: () => {},
      fetch: old.fetcher,
    });
    const next = { ...old.files, checksums: release("1.22.2").files.checksums };
    expect(engineInstalled(next, PKG)).toBe(false);
  });
});

describe("installSmolvm", () => {
  it("runs smolvm's installer for the pinned version, without Amika's secrets", async () => {
    const run = vi.fn(async () => 0);
    await installSmolvm({
      env: { AMIKA_HOSTD_API_KEY: "k", PATH: "/usr/bin" },
      out: () => {},
      fetch: async () => new Response("#!/bin/bash\n"),
      run,
      findSmolvm: () => "/home/op/.smolvm/smolvm",
    });
    const [command, args, env] = run.mock.calls[0] as unknown as [
      string,
      string[],
      NodeJS.ProcessEnv,
    ];
    expect(command).toBe("/bin/bash");
    expect(args.slice(1)).toEqual(["--version", DEFAULT_SMOLVM_VERSION]);
    expect(env).not.toHaveProperty("AMIKA_HOSTD_API_KEY");
  });

  it("refuses a failed installer", async () => {
    await expect(
      installSmolvm({
        env: {},
        out: () => {},
        fetch: async () => new Response(""),
        run: async () => 1,
        findSmolvm: () => undefined,
      }),
    ).rejects.toThrow(/installer failed/);
  });

  it("takes the version from the environment, or latest", () => {
    expect(smolvmVersionToInstall({})).toBe(DEFAULT_SMOLVM_VERSION);
    expect(
      smolvmVersionToInstall({ AMIKA_HOSTD_SMOLVM_VERSION: "v1.30.0" }),
    ).toBe("1.30.0");
    expect(
      smolvmVersionToInstall({ AMIKA_HOSTD_SMOLVM_VERSION: "latest" }),
    ).toBe("latest");
  });
});
