import { describe, expect, it } from "vitest";
import {
  execChecked,
  type ExecOptions,
  type ExecResult,
  type SandboxAdapter,
} from "./adapter";

/** Adapter whose `exec` returns a fixed result and records the call. */
function stubAdapter(result: ExecResult): {
  adapter: SandboxAdapter;
  calls: { command: string; opts?: ExecOptions }[];
} {
  const calls: { command: string; opts?: ExecOptions }[] = [];
  const adapter: SandboxAdapter = {
    async exec(command, opts) {
      calls.push({ command, opts });
      return result;
    },
    async uploadFile() {},
    async downloadFile() {
      return null;
    },
  };
  return { adapter, calls };
}

describe("execChecked", () => {
  it("resolves without throwing when the command exits 0", async () => {
    const { adapter } = stubAdapter({ exitCode: 0, stdout: "ok", stderr: "" });
    await expect(execChecked(adapter, "true")).resolves.toBeUndefined();
  });

  it("forwards the command and options to the adapter", async () => {
    const { adapter, calls } = stubAdapter({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    const opts: ExecOptions = { cwd: "/work", sudo: true, env: { A: "1" } };
    await execChecked(adapter, "ls", opts);
    expect(calls).toEqual([{ command: "ls", opts }]);
  });

  it("throws with the command output on a non-zero exit", async () => {
    const { adapter } = stubAdapter({
      exitCode: 1,
      stdout: "boom",
      stderr: "",
    });
    await expect(execChecked(adapter, "false")).rejects.toThrow("boom");
  });

  it("falls back to a descriptive message when output is empty", async () => {
    const { adapter } = stubAdapter({ exitCode: 127, stdout: "", stderr: "" });
    await expect(execChecked(adapter, "nope")).rejects.toThrow(
      "Command failed: nope",
    );
  });
});
