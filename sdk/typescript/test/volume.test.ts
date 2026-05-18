import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { VolumeCommands } from "../src/commands/volume.js";
import { Runner } from "../src/runner.js";
import { fakeBinaryPath } from "./helpers.js";

describe("VolumeCommands", () => {
  const runner = new Runner({ binary: fakeBinaryPath });
  const volume = new VolumeCommands(runner);

  it("buildListArgs", () => {
    assert.deepEqual(volume.buildListArgs(), ["volume", "list"]);
  });

  it("buildDeleteArgs with force", () => {
    assert.deepEqual(
      volume.buildDeleteArgs({ names: ["v1"], force: true }),
      ["volume", "delete", "--force", "v1"],
    );
  });

  it("buildDeleteArgs without flags", () => {
    assert.deepEqual(
      volume.buildDeleteArgs({ names: ["v1", "v2"] }),
      ["volume", "delete", "v1", "v2"],
    );
  });
});
