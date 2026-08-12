import { describe, expect, it } from "vitest";
import { buildLifecycleCommands } from "./lifecycle-commands";
import {
  POST_SETUP_SCRIPT,
  PRE_SETUP_SCRIPT,
  RUN_HOOK_SCRIPT,
  SANDBOX_SETUP_SCRIPT,
  SANDBOX_START_SCRIPT,
} from "../../constants";

describe("buildLifecycleCommands", () => {
  it("wraps each lifecycle hook in the run-hook wrapper", () => {
    expect(buildLifecycleCommands()).toEqual({
      preSetup: `${RUN_HOOK_SCRIPT} ${PRE_SETUP_SCRIPT}`,
      setup: `${RUN_HOOK_SCRIPT} ${SANDBOX_SETUP_SCRIPT}`,
      postSetup: `${RUN_HOOK_SCRIPT} ${POST_SETUP_SCRIPT}`,
      start: `${RUN_HOOK_SCRIPT} ${SANDBOX_START_SCRIPT}`,
    });
  });

  it("routes every hook through the same run-hook script", () => {
    const commands = buildLifecycleCommands();
    for (const command of Object.values(commands)) {
      expect(command.startsWith(`${RUN_HOOK_SCRIPT} `)).toBe(true);
    }
  });
});
