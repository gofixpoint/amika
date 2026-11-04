/**
 * The line runs here through a local shell, as sshd runs it in the guest
 * (`$SHELL -c <line>`), so the tests check what the command does. The guest
 * is macOS with zsh, so the tests run only on macOS.
 */
import { describe, expect, it } from "vitest";
import { remoteCommand } from "./remote-command";
import { runProcess } from "./process";

async function runLine(line: string) {
  const result = await runProcess("/bin/zsh", ["-c", line]);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe.runIf(process.platform === "darwin")("remoteCommand", () => {
  it("keeps the exit code and the two streams", async () => {
    expect(
      await runLine(remoteCommand("echo out; echo err 1>&2; exit 7")),
    ).toEqual({
      exitCode: 7,
      stdout: "out\n",
      stderr: "err\n",
    });
  });

  it("runs in the working directory", async () => {
    expect(
      (await runLine(remoteCommand("pwd", { cwd: "/tmp" }))).stdout,
    ).toMatch(/\/tmp\n$/);
  });

  it("fails without running the command when the directory is missing", async () => {
    const result = await runLine(
      remoteCommand("echo ran", { cwd: "/no/such/dir" }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("passes env values with quotes, spaces, and newlines unchanged", async () => {
    const value = `it's "two"\nlines $HOME`;
    const result = await runLine(
      remoteCommand(`printf '%s' "$CONTRACT_VAR"`, {
        env: { CONTRACT_VAR: value },
      }),
    );
    expect(result.stdout).toBe(value);
  });

  it("refuses an env var name the shell would run as code", () => {
    expect(() => remoteCommand("true", { env: { "A;rm -rf /": "x" } })).toThrow(
      /Invalid env var name/,
    );
  });
});
