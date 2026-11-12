import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveConfig } from "./config.js";
import type { MachineIndex } from "./runtime-router.js";
import type { RuntimeName } from "./runtimes.js";
import { uninstall } from "./uninstall.js";

/** A config with Lume on, its rigs in `storageDir`. */
function lumeConfig(storageDir: string) {
  return resolveConfig({
    file: {
      path: "/config/config.toml",
      contents: `[runtimes.smol]
[runtimes.lume]
storage_dir = "${storageDir}"
[presets.macos-coder.runtimes.lume]
image = "amika-macos-coder"
`,
    },
  });
}

function index(...entries: [string, RuntimeName][]): MachineIndex {
  return { entries: () => entries } as unknown as MachineIndex;
}

/**
 * A home with smolvm and a kept macOS restore image in it, and an operator's
 * own (empty) Lume storage folder, Lume found, and every Lume command and
 * deletion faked.
 */
function harness(answers: (string | undefined)[] = [], { tty = true } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "amika-hostd-uninstall-"));
  mkdirSync(path.join(home, ".smolvm"));
  writeFileSync(path.join(home, ".smolvm", "smolvm"), "");
  const restoreDir = path.join(home, ".cache", "amika-hostd", "macos");
  mkdirSync(restoreDir, { recursive: true });
  writeFileSync(path.join(restoreDir, "restore-macos26.ipsw"), "");
  const storageDir = path.join(home, "lume-rigs");
  mkdirSync(storageDir);
  const out: string[] = [];
  const deps = {
    env: { HOME: home, TMPDIR: home },
    out: (line: string) => out.push(line),
    prompt: tty ? vi.fn(async (_q: string) => answers.shift()) : undefined,
    findLume: () => "/usr/local/bin/lume",
    missingMacosImages: vi.fn(async () => []),
    run: vi.fn(async () => 0),
    remove: vi.fn(),
  };
  return {
    home,
    storageDir,
    restoreDir,
    config: lumeConfig(storageDir),
    out,
    deps,
  };
}

const lumeCalls = (h: ReturnType<typeof harness>) =>
  h.deps.run.mock.calls.map(
    (call) => (call as unknown as [string, string[]])[1],
  );

describe("uninstall", () => {
  it("deletes the Lume rigs and an emptied storage_dir, and asks about the rest", async () => {
    const h = harness(["", "", ""]);
    await uninstall(
      h.config,
      index(["mac-1", "lume"], ["linux-1", "smol"]),
      { yes: true, dryRun: false },
      h.deps,
    );
    expect(lumeCalls(h)).toEqual([
      ["stop", "mac-1", "--storage", h.storageDir, "--force"],
      ["delete", "mac-1", "--storage", h.storageDir, "--force"],
    ]);
    expect(h.deps.remove).toHaveBeenCalledWith(h.storageDir);
    // Enter keeps the macOS images, the restore image and smolvm.
    expect(h.deps.prompt?.mock.calls.map(([q]) => q)).toEqual([
      expect.stringMatching(
        /amika-macos-base, amika-macos-coder.*'remove macos images'/,
      ),
      expect.stringMatching(/'remove macos restore image'/),
      expect.stringMatching(/'remove smolvm'/),
    ]);
    expect(h.deps.remove).toHaveBeenCalledTimes(1);
    expect(h.out).toContain("Not deleted, as other tools can use them:");
  });

  it("keeps an operator's storage_dir that still holds other files", async () => {
    const h = harness(["", ""]);
    writeFileSync(path.join(h.storageDir, "not-a-rig"), "");
    await uninstall(
      h.config,
      index(["mac-1", "lume"]),
      { yes: true, dryRun: false },
      h.deps,
    );
    expect(h.deps.remove).not.toHaveBeenCalled();
    expect(h.out).toContain(
      `Kept ${h.storageDir}: it holds files that are not Lume rigs`,
    );
  });

  it("deletes the macOS images and smolvm only for the typed phrase", async () => {
    const h = harness(["remove macos images", "", "remove smolvm"]);
    const link = path.join(h.home, ".local", "bin", "smolvm");
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(path.join(h.home, ".smolvm", "smolvm"), link);
    await uninstall(h.config, index(), { yes: true, dryRun: false }, h.deps);
    expect(lumeCalls(h)).toEqual([
      ["delete", "amika-macos-base", "--force"],
      ["delete", "amika-macos-coder", "--force"],
    ]);
    expect(h.deps.remove).toHaveBeenCalledWith(link);
    expect(h.deps.remove).toHaveBeenCalledWith(path.join(h.home, ".smolvm"));
    expect(h.deps.remove).not.toHaveBeenCalledWith(h.restoreDir);
  });

  it("deletes the restore image only for its own typed phrase", async () => {
    // No to the Lume storage folder; the restore image's phrase is typed.
    const h = harness(["n", "", "remove macos restore image", ""]);
    await uninstall(h.config, index(), { yes: false, dryRun: false }, h.deps);
    expect(lumeCalls(h)).toEqual([]);
    expect(h.deps.remove.mock.calls).toEqual([[h.restoreDir]]);
  });

  it("leaves a smolvm in ~/.local/bin that is not a link into ~/.smolvm", async () => {
    const h = harness(["", "", "remove smolvm"]);
    const own = path.join(h.home, ".local", "bin", "smolvm");
    mkdirSync(path.dirname(own), { recursive: true });
    writeFileSync(own, "");
    await uninstall(h.config, index(), { yes: true, dryRun: false }, h.deps);
    expect(h.deps.remove).not.toHaveBeenCalledWith(own);
  });

  it("keeps everything a typed phrase guards without a terminal", async () => {
    const h = harness([], { tty: false });
    await uninstall(h.config, index(), { yes: true, dryRun: false }, h.deps);
    expect(lumeCalls(h)).toEqual([]);
    expect(h.deps.remove).not.toHaveBeenCalledWith(
      path.join(h.home, ".smolvm"),
    );
    expect(h.deps.remove).not.toHaveBeenCalledWith(h.restoreDir);
  });

  it("keeps the Lume rigs without a yes", async () => {
    const h = harness([], { tty: false });
    await uninstall(
      h.config,
      index(["mac-1", "lume"]),
      { yes: false, dryRun: false },
      h.deps,
    );
    expect(lumeCalls(h)).toEqual([]);
    expect(h.deps.remove).not.toHaveBeenCalled();
  });

  it("changes nothing on a dry run", async () => {
    const h = harness();
    await uninstall(
      h.config,
      index(["mac-1", "lume"]),
      { yes: true, dryRun: true },
      h.deps,
    );
    expect(h.deps.run).not.toHaveBeenCalled();
    expect(h.deps.remove).not.toHaveBeenCalled();
    expect(h.out).toContain(
      `Would delete the Lume rigs mac-1 and ${h.storageDir}`,
    );
    expect(h.out).toContain(
      `Would ask about the macOS restore image in ${h.restoreDir}`,
    );
  });
});
