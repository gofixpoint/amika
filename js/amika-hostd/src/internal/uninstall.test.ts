import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveConfig } from "./config.js";
import type { MachineIndex } from "./runtime-router.js";
import type { RuntimeName } from "./runtimes.js";
import { uninstall } from "./uninstall.js";

const LUME_CONFIG = resolveConfig({
  file: {
    path: "/config/config.toml",
    contents: `[runtimes.smol]
[runtimes.lume]
storage_dir = "/data/lume"
[presets.macos-coder.runtimes.lume]
image = "amika-macos-coder"
`,
  },
});

function index(...entries: [string, RuntimeName][]): MachineIndex {
  return { entries: () => entries } as unknown as MachineIndex;
}

/** A home with smolvm in it, Lume found, and every effect faked. */
function harness(answers: (string | undefined)[] = [], { tty = true } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "amika-hostd-uninstall-"));
  mkdirSync(path.join(home, ".smolvm"));
  writeFileSync(path.join(home, ".smolvm", "smolvm"), "");
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
  return { home, out, deps };
}

const lumeCalls = (h: ReturnType<typeof harness>) =>
  h.deps.run.mock.calls.map(
    (call) => (call as unknown as [string, string[]])[1],
  );

describe("uninstall", () => {
  it("deletes the Lume rigs and storage_dir, and asks about the rest", async () => {
    const h = harness(["", ""]);
    await uninstall(
      LUME_CONFIG,
      index(["mac-1", "lume"], ["linux-1", "smol"]),
      { yes: true, dryRun: false },
      h.deps,
    );
    expect(lumeCalls(h)).toEqual([
      ["stop", "mac-1", "--storage", "/data/lume", "--force"],
      ["delete", "mac-1", "--storage", "/data/lume", "--force"],
    ]);
    expect(h.deps.remove).toHaveBeenCalledWith("/data/lume");
    // Enter keeps the macOS images and smolvm.
    expect(h.deps.prompt?.mock.calls.map(([q]) => q)).toEqual([
      expect.stringMatching(
        /amika-macos-base, amika-macos-coder.*'remove macos images'/,
      ),
      expect.stringMatching(/'remove smolvm'/),
    ]);
    expect(h.deps.remove).toHaveBeenCalledTimes(1);
    expect(h.out).toContain("Not deleted, as other tools can use them:");
  });

  it("deletes the macOS images and smolvm only for the typed phrase", async () => {
    const h = harness(["remove macos images", "remove smolvm"]);
    await uninstall(LUME_CONFIG, index(), { yes: true, dryRun: false }, h.deps);
    expect(lumeCalls(h)).toEqual([
      ["delete", "amika-macos-base", "--force"],
      ["delete", "amika-macos-coder", "--force"],
    ]);
    expect(h.deps.remove).toHaveBeenCalledWith(path.join(h.home, ".smolvm"));
  });

  it("keeps everything a typed phrase guards without a terminal", async () => {
    const h = harness([], { tty: false });
    await uninstall(LUME_CONFIG, index(), { yes: true, dryRun: false }, h.deps);
    expect(lumeCalls(h)).toEqual([]);
    expect(h.deps.remove).not.toHaveBeenCalledWith(
      path.join(h.home, ".smolvm"),
    );
  });

  it("keeps the Lume rigs without a yes", async () => {
    const h = harness([], { tty: false });
    await uninstall(
      LUME_CONFIG,
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
      LUME_CONFIG,
      index(["mac-1", "lume"]),
      { yes: true, dryRun: true },
      h.deps,
    );
    expect(h.deps.run).not.toHaveBeenCalled();
    expect(h.deps.remove).not.toHaveBeenCalled();
    expect(h.out).toContain("Would delete the Lume rigs mac-1 and /data/lume");
  });
});
