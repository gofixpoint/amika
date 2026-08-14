import { describe, expect, it, vi } from "vitest";
import type { SandboxAdapter } from "./adapter";
import { EXEC_INPUT_STAGING_ROOT, execWithStagedInput } from "./exec-input";

describe("execWithStagedInput", () => {
  it("keeps input out of commands and removes the staging directory", async () => {
    const commands: string[] = [];
    const uploadFile = vi.fn(
      async (_content: Buffer | string, _path: string) => {},
    );
    const adapter: SandboxAdapter = {
      async exec(command) {
        commands.push(command);
        return {
          exitCode: 0,
          stdout: command.startsWith("(") ? "ok" : "",
          stderr: "",
        };
      },
      uploadFile,
      downloadFile: async () => null,
    };

    await expect(
      execWithStagedInput(adapter, "amikad connect-token set", "secret-token", {
        sudo: true,
      }),
    ).resolves.toEqual({ exitCode: 0, stdout: "ok", stderr: "" });
    expect(commands.join("\n")).not.toContain("secret-token");
    expect(uploadFile).toHaveBeenCalledWith(
      "secret-token",
      expect.stringMatching(
        new RegExp(`^${EXEC_INPUT_STAGING_ROOT}/[^/]+/stdin$`, "u"),
      ),
    );
    expect(commands.at(-1)).toMatch(/^rm -rf -- /u);
  });
});
