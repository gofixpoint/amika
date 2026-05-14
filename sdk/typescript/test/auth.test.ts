import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { AuthCommands } from "../src/commands/auth.js";
import { Runner } from "../src/runner.js";
import { fakeBinaryPath } from "./helpers.js";

describe("AuthCommands.buildExtractArgs", () => {
  const runner = new Runner({ binary: fakeBinaryPath });
  const auth = new AuthCommands(runner);

  it("emits all flags when set", () => {
    assert.deepEqual(
      auth.buildExtractArgs({ exportShell: true, homedir: "/tmp/h", noOauth: true }),
      ["auth", "extract", "--export", "--homedir", "/tmp/h", "--no-oauth"],
    );
  });

  it("emits nothing extra when no options", () => {
    assert.deepEqual(auth.buildExtractArgs(), ["auth", "extract"]);
  });
});
