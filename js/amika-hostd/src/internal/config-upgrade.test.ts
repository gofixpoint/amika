/** Cover the rewrite of an old config.toml in the current format. */
import { describe, expect, it } from "vitest";
import { resolveConfig } from "./config.js";
import { upgradeConfig } from "./config-upgrade.js";

const OLD = `hostname = "builder"

# --- Preset images ---
# The image each Amika preset boots on this host.

[preset_images]
amika-coder = "ghcr.io/gofixpoint/amika-coder:latest"
"amika-coder-plus-docker" = 'ghcr.io/gofixpoint/amika-coder-plus-docker:latest'
custom = "ghcr.io/me/custom:1"

# Sizes come after.
[sizes.tiny]
vcpus = 1
memory_gib = 2
disk_gib = 20
`;

describe("upgradeConfig", () => {
  it("rewrites [preset_images] in place as smol preset tables, with Amika's names", () => {
    const { contents, upgraded } = upgradeConfig(OLD);
    expect(upgraded).toBe(true);
    expect(contents).toBe(`hostname = "builder"

# --- Preset images ---
# The image each Amika preset boots on this host.

[presets.coder.runtimes.smol]
image = "ghcr.io/gofixpoint/amika-coder:latest"

[presets.coder-plus-docker.runtimes.smol]
image = "ghcr.io/gofixpoint/amika-coder-plus-docker:latest"

[presets.custom.runtimes.smol]
image = "ghcr.io/me/custom:1"

# Sizes come after.
[sizes.tiny]
vcpus = 1
memory_gib = 2
disk_gib = 20
`);
    const config = resolveConfig({ file: { path: "/c.toml", contents } });
    expect(Object.keys(config.runtimes.presets)).toEqual([
      "coder",
      "coder-plus-docker",
      "custom",
    ]);
    expect(Object.keys(config.sizes)).toEqual(["tiny"]);
  });

  it("leaves a current file as it is", () => {
    const current = `[presets.coder.runtimes.smol]\nimage = "ghcr.io/x:y"\n`;
    expect(upgradeConfig(current)).toEqual({
      contents: current,
      upgraded: false,
    });
  });

  it("refuses a file that sets one preset in both formats", () => {
    expect(() =>
      upgradeConfig(`[preset_images]
amika-coder = "ghcr.io/x:1"
[presets.coder.runtimes.smol]
image = "ghcr.io/x:2"
`),
    ).toThrow("[preset_images] and [presets.coder] both set preset coder");
  });

  it("leaves a file that is not TOML for the config check to report", () => {
    expect(upgradeConfig("[preset_images")).toEqual({
      contents: "[preset_images",
      upgraded: false,
    });
  });
});
