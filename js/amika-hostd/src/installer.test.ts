/**
 * Drive install-amika-hostd.sh end to end against a local release, npm
 * registry and Node.js dist, with fake `node` binaries that report a chosen
 * version. Covers which node the installer accepts and what the launcher runs.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const installer = path.join(repoRoot, "install-amika-hostd.sh");
// The fake release must carry the version the installer asks for, so a
// DEFAULT_VERSION bump never needs a matching edit here.
const hostdVersion = readFileSync(installer, "utf8").match(
  /^DEFAULT_VERSION="([^"]+)"$/m,
)![1];
const engineVersion = "1.22.2";

/** The installer's names for this host, or undefined where it cannot run. */
function hostPlatform():
  | { os: string; nodeArch: string; engine: string }
  | undefined {
  const nodeArch = { x64: "x64", arm64: "arm64" }[process.arch as string];
  if (process.platform === "linux" && nodeArch) {
    const glibc = spawnSync("getconf", ["GNU_LIBC_VERSION"], {
      encoding: "utf8",
    });
    if (glibc.status !== 0) return undefined;
    return {
      os: "linux",
      nodeArch,
      engine: `smolmachines-linux-${nodeArch}-gnu`,
    };
  }
  if (process.platform === "darwin" && nodeArch === "arm64") {
    return { os: "darwin", nodeArch, engine: "smolmachines-darwin-arm64" };
  }
  return undefined;
}

const platform = hostPlatform();

// Everything the installer runs besides node, linked into one directory so a
// test controls exactly which `node` is on PATH.
const tools = [
  "awk",
  "basename",
  "cat",
  "chmod",
  "cp",
  "curl",
  "dirname",
  "getconf",
  "grep",
  "gzip",
  "head",
  "hostname",
  "install",
  "mkdir",
  "mktemp",
  "mv",
  "readlink",
  "rm",
  "sed",
  "sh",
  "sha256sum",
  "shasum",
  "tar",
  "tr",
  "uname",
];

describe.skipIf(!platform)("install-amika-hostd.sh Node.js selection", () => {
  const { os, nodeArch, engine } = platform ?? {
    os: "",
    nodeArch: "",
    engine: "",
  };
  let root: string;
  let home: string;
  let hostdHome: string;
  let installDir: string;
  let toolsDir: string;
  let systemNodeDir: string;
  let nodeDist: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "amika-hostd-installer-"));
    home = path.join(root, "home");
    hostdHome = path.join(home, ".local/share/amika-hostd");
    installDir = path.join(root, "bin");
    toolsDir = path.join(root, "tools");
    systemNodeDir = path.join(root, "system-node");
    nodeDist = path.join(root, "node-dist");
    for (const dir of [home, installDir, toolsDir, systemNodeDir, nodeDist]) {
      mkdirSync(dir, { recursive: true });
    }
    linkTools();
    writeRelease();
    for (const version of ["22.23.4", "24.22.1", "24.21.0"]) {
      writeNodeDist(version);
    }
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("downloads the default patched node when there is no system node", () => {
    const result = install();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "Node.js 22+ not found; installing Node.js 24.22.1",
    );
    expectLauncherRuns(privateNode(), "24.22.1");
  });

  it.each(["24.21.0", "22.23.3", "26.12.0", "23.11.1", "24.22.1", "27.1.0"])(
    "uses a system node on 22 or newer (%s) as it is",
    (version) => {
      writeSystemNode(version);
      rmSync(nodeDist, { recursive: true });
      const result = install();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        `Using system Node.js v${version} at ${systemNode()}`,
      );
      expect(existsSync(privateNode())).toBe(false);
      expectLauncherRuns(systemNode(), version);
    },
  );

  it.each(["20.19.6", "18.20.8"])(
    "downloads the default patched node when the system node is older than 22 (%s)",
    (version) => {
      writeSystemNode(version);
      const result = install();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        `Not using system Node.js v${version} at ${systemNode()}: amika-hostd needs Node.js 22+`,
      );
      expectLauncherRuns(privateNode(), "24.22.1");
    },
  );

  it("replaces a private node left by an earlier install when it is unpatched", () => {
    writeFakeNode(privateNode(), "24.21.0");
    const result = install();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      `Replacing Node.js v24.21.0 at ${privateNode()}: amika-hostd needs a patched release`,
    );
    expectLauncherRuns(privateNode(), "24.22.1");
  });

  it("keeps a patched private node without downloading", () => {
    writeFakeNode(privateNode(), "24.22.1");
    rmSync(nodeDist, { recursive: true });
    const result = install();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      `Using Node.js v24.22.1 at ${privateNode()}`,
    );
    expectLauncherRuns(privateNode(), "24.22.1");
  });

  it.each([false, true])(
    "replaces an unpatched private node found on PATH (symlink: %s)",
    (symlink) => {
      writeFakeNode(privateNode(), "24.21.0");
      if (symlink) symlinkSync(privateNode(), systemNode());
      const result = install({
        PATH: `${symlink ? systemNodeDir : path.dirname(privateNode())}:${toolsDir}`,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        `Replacing Node.js v24.21.0 at ${privateNode()}: amika-hostd needs a patched release`,
      );
      expectLauncherRuns(privateNode(), "24.22.1");
    },
  );

  it.each([false, true])(
    "keeps a patched private node found on PATH (symlink: %s)",
    (symlink) => {
      writeFakeNode(privateNode(), "24.22.1");
      if (symlink) symlinkSync(privateNode(), systemNode());
      rmSync(nodeDist, { recursive: true });
      const result = install({
        PATH: `${symlink ? systemNodeDir : path.dirname(privateNode())}:${toolsDir}`,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        `Using Node.js v24.22.1 at ${privateNode()}`,
      );
      expectLauncherRuns(privateNode(), "24.22.1");
    },
  );

  it("keeps a symlinked user node separate from a private node at the same version", () => {
    const userNode = path.join(root, "user-node/bin/node");
    writeFakeNode(userNode, "24.21.0");
    symlinkSync(userNode, systemNode());
    writeFakeNode(privateNode(), "24.21.0");
    rmSync(nodeDist, { recursive: true });
    const result = install();
    expect(result.status, result.stderr).toBe(0);
    expectLauncherRuns(systemNode(), "24.21.0");
    expect(
      execFileSync(userNode, ["-p", "process.versions.node"], {
        encoding: "utf8",
      }).trim(),
    ).toBe("24.21.0");
  });

  it("downloads an explicitly requested patched version", () => {
    const result = install({ AMIKA_HOSTD_NODE_VERSION: "v22.23.4" });
    expect(result.status, result.stderr).toBe(0);
    expectLauncherRuns(privateNode(), "22.23.4");
  });

  it.each(["24.21.0", "25.0.0", "24.22", "latest"])(
    "refuses to download an explicitly requested version that is not patched (%s)",
    (version) => {
      const result = install({ AMIKA_HOSTD_NODE_VERSION: version });
      expectRefused(result, version);
    },
  );

  it("refuses an unpatched requested version when the system node is too old", () => {
    writeSystemNode("20.19.6");
    expectRefused(install({ AMIKA_HOSTD_NODE_VERSION: "24.21.0" }), "24.21.0");
  });

  it("ignores an unpatched requested version when it uses the system node", () => {
    writeSystemNode("24.21.0");
    const result = install({ AMIKA_HOSTD_NODE_VERSION: "24.21.0" });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(privateNode())).toBe(false);
    expectLauncherRuns(systemNode(), "24.21.0");
  });

  it("moves the launcher to a system node installed since the last install", () => {
    expect(install().status).toBe(0);
    expectLauncherRuns(privateNode(), "24.22.1");

    writeSystemNode("24.21.0");
    const again = install();
    expect(again.status, again.stderr).toBe(0);
    expectLauncherRuns(systemNode(), "24.21.0");
  });

  it("reinstalls over itself, keeping the node it downloaded", () => {
    expect(install().status).toBe(0);
    rmSync(nodeDist, { recursive: true });
    const again = install();
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain(
      `Using Node.js v24.22.1 at ${privateNode()}`,
    );
    expectLauncherRuns(privateNode(), "24.22.1");
  });

  /** The installer failed before installing anything, naming the version. */
  function expectRefused(
    result: ReturnType<typeof spawnSync>,
    version: string,
  ) {
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `not installing Node.js ${version} (AMIKA_HOSTD_NODE_VERSION)`,
    );
    expect(existsSync(hostdHome)).toBe(false);
    expect(existsSync(launcher())).toBe(false);
  }

  function install(extraEnv: Record<string, string> = {}) {
    return spawnSync("sh", [installer, "--skip-smolvm"], {
      encoding: "utf8",
      env: {
        PATH: `${systemNodeDir}:${toolsDir}`,
        HOME: home,
        TMPDIR: root,
        AMIKA_INSTALL_DIR: installDir,
        AMIKA_RELEASE_URL: `file://${path.join(root, "release")}`,
        AMIKA_HOSTD_NPM_REGISTRY: `file://${path.join(root, "registry")}`,
        AMIKA_HOSTD_NODE_DIST_URL: `file://${nodeDist}`,
        ...extraEnv,
      },
    });
  }

  function launcher(): string {
    return path.join(installDir, "amika-hostd");
  }

  function privateNode(): string {
    return path.join(hostdHome, "node/bin/node");
  }

  function systemNode(): string {
    return path.join(systemNodeDir, "node");
  }

  /** The launcher pins `node` and, run, reaches it with the bundle. */
  function expectLauncherRuns(node: string, version: string) {
    expect(readFileSync(launcher(), "utf8")).toContain(
      `exec '${node}' '${hostdHome}/amika-hostd.mjs' "$@"`,
    );
    const output = execFileSync(launcher(), ["--help"], {
      encoding: "utf8",
      env: { PATH: toolsDir },
    });
    expect(output.trim()).toBe(
      `fake node ${version} ran ${hostdHome}/amika-hostd.mjs --help`,
    );
  }

  function writeSystemNode(version: string) {
    writeFakeNode(systemNode(), version);
  }

  function linkTools() {
    for (const tool of tools) {
      const found = spawnSync("sh", ["-c", `command -v ${tool}`], {
        encoding: "utf8",
      });
      if (found.status === 0) {
        symlinkSync(found.stdout.trim(), path.join(toolsDir, tool));
      }
    }
  }

  /** A hostd release archive and the engine package it pins. */
  function writeRelease() {
    const base = `amika-hostd_${hostdVersion}`;
    const releaseDir = path.join(root, "release");
    const archiveDir = path.join(root, "release-src", base);
    const engineArchive = `${engine}-${engineVersion}.tgz`;
    const registryDir = path.join(root, "registry", engine, "-");

    const engineSrc = path.join(root, "engine-src", "package");
    mkdirSync(engineSrc, { recursive: true });
    writeFileSync(path.join(engineSrc, "package.json"), "{}\n");
    mkdirSync(registryDir, { recursive: true });
    tarGz(
      path.join(registryDir, engineArchive),
      path.dirname(engineSrc),
      "package",
    );

    mkdirSync(path.join(archiveDir, "node_modules/smolmachines"), {
      recursive: true,
    });
    writeFileSync(path.join(archiveDir, "amika-hostd.mjs"), "// bundle\n");
    writeFileSync(
      path.join(archiveDir, "config.example.toml"),
      '# hostname = "my-host"\n',
    );
    writeFileSync(
      path.join(archiveDir, "node_modules/smolmachines/package.json"),
      "{}\n",
    );
    writeFileSync(
      path.join(archiveDir, "engines.sha256"),
      `${sha256(path.join(registryDir, engineArchive))}  ${engineArchive}\n`,
    );
    mkdirSync(releaseDir, { recursive: true });
    tarGz(
      path.join(releaseDir, `${base}.tar.gz`),
      path.dirname(archiveDir),
      base,
    );
    writeFileSync(
      path.join(releaseDir, "checksums.txt"),
      `${sha256(path.join(releaseDir, `${base}.tar.gz`))}  ${base}.tar.gz\n`,
    );
  }

  /** nodejs.org/dist/v<version>: the archive and SHASUMS256.txt. */
  function writeNodeDist(version: string) {
    const dist = `node-v${version}-${os}-${nodeArch}`;
    const src = path.join(root, "node-src", version);
    writeFakeNode(path.join(src, dist, "bin/node"), version);
    const versionDir = path.join(nodeDist, `v${version}`);
    mkdirSync(versionDir, { recursive: true });
    const archive = path.join(versionDir, `${dist}.tar.gz`);
    tarGz(archive, src, dist);
    writeFileSync(
      path.join(versionDir, "SHASUMS256.txt"),
      `${sha256(archive)}  ${dist}.tar.gz\n`,
    );
  }
});

/**
 * A `node` that reports `version` to `-p process.versions.node` and otherwise
 * says what it was asked to run.
 */
function writeFakeNode(file: string, version: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    [
      "#!/bin/sh",
      `if [ "$1" = "-p" ]; then echo ${version}; exit 0; fi`,
      `echo "fake node ${version} ran $*"`,
      "",
    ].join("\n"),
  );
  chmodSync(file, 0o755);
}

function tarGz(archive: string, cwd: string, entry: string) {
  execFileSync("tar", ["-czf", archive, "-C", cwd, entry]);
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
