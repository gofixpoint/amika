/** Cover the config edits of `capabilities update`, and the reload check. */
import { describe, expect, it } from "vitest";
import { resolveConfig } from "./config.js";
import { checkReload } from "./reload.js";
import { updateRuntimes } from "./runtime-update.js";

const STORAGE = "/home/me/.local/share/amika-hostd/lume";
const PRESETS = `hostname = "builder"

[presets.coder.runtimes.smol]
image = "ghcr.io/gofixpoint/amika-coder:latest"
`;

function config(contents: string) {
  return resolveConfig({ file: { path: "/c.toml", contents } });
}

describe("updateRuntimes", () => {
  it("turns lume on, keeps smol on, and adds the macOS preset", () => {
    const { contents, steps } = updateRuntimes(
      PRESETS,
      { enable: ["lume"], disable: [] },
      STORAGE,
    );
    expect(steps).toEqual([
      "Turn on lume",
      "Add preset macos-coder on lume, booting template amika-macos-coder",
    ]);
    expect(contents).toBe(`${PRESETS}
[runtimes.smol]

[runtimes.lume]
storage_dir = "${STORAGE}"

[presets.macos-coder.runtimes.lume]
image = "amika-macos-coder"
`);
    const resolved = config(contents).runtimes;
    expect(Object.keys(resolved.runtimes)).toEqual(["smol", "lume"]);
    expect(Object.keys(resolved.presets)).toEqual(["coder", "macos-coder"]);
  });

  it("makes no change when it runs again with the same flags", () => {
    const once = updateRuntimes(
      PRESETS,
      { enable: ["lume"], disable: [] },
      STORAGE,
    );
    const twice = updateRuntimes(
      once.contents,
      { enable: ["lume"], disable: [] },
      STORAGE,
    );
    expect(twice).toEqual({ contents: once.contents, steps: [] });
  });

  it("turns a runtime off in its own table, and back on", () => {
    const on = updateRuntimes(
      PRESETS,
      { enable: ["lume"], disable: [] },
      STORAGE,
    ).contents;
    const off = updateRuntimes(on, { enable: [], disable: ["lume"] }, STORAGE);
    expect(off.steps).toEqual(["Turn off lume"]);
    expect(Object.keys(config(off.contents).runtimes.runtimes)).toEqual([
      "smol",
    ]);
    const again = updateRuntimes(
      off.contents,
      { enable: ["lume"], disable: [] },
      STORAGE,
    );
    expect(again.steps).toEqual(["Turn on lume"]);
    expect(config(again.contents).runtimes.runtimes.lume?.storageDir).toBe(
      STORAGE,
    );
  });

  it("turns off smol where the file only left it on by default", () => {
    const { contents, steps } = updateRuntimes(
      PRESETS,
      { enable: [], disable: ["smol"] },
      STORAGE,
    );
    expect(steps).toEqual(["Turn off smol"]);
    expect(config(contents).runtimes.runtimes).toEqual({});
  });
});

describe("checkReload", () => {
  const SMOL = config(PRESETS);
  const BOTH = config(
    updateRuntimes(PRESETS, { enable: ["lume"], disable: [] }, STORAGE)
      .contents,
  );

  it("allows adding a runtime", () => {
    expect(checkReload(SMOL, BOTH, [["linux", "smol"]])).toEqual({
      warnings: [],
    });
  });

  it("refuses to remove a runtime that has rigs, naming them", () => {
    expect(checkReload(BOTH, SMOL, [["ios-build", "lume"]]).error).toBe(
      "lume has 1 rig (ios-build). Delete it, then try again.",
    );
    expect(checkReload(BOTH, SMOL, [["linux", "smol"]]).error).toBeUndefined();
  });

  it("refuses to turn smol on, which needs smolvm and so a restart", () => {
    const lumeOnly = config(
      updateRuntimes(PRESETS, { enable: ["lume"], disable: ["smol"] }, STORAGE)
        .contents,
    );
    expect(checkReload(lumeOnly, BOTH, []).error).toMatch(
      /turning on smol needs a restart/,
    );
  });

  it("warns that other settings wait for a restart", () => {
    const moved = config(PRESETS.replace("builder", "builder2"));
    expect(checkReload(SMOL, moved, []).warnings).toEqual([
      "hostname changed; restart amika-hostd to apply it",
    ]);
  });
});
