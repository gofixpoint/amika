import { describe, it, expect } from "vitest";
import {
  buildDaytonaCommand,
  buildDaytonaSessionCommand,
  executeCommand,
} from "./commands";
import { fakeDaytonaSandbox } from "./test-support";

type DaytonaSandbox = Parameters<typeof executeCommand>[0];

describe("buildDaytonaCommand", () => {
  it("runs a non-sudo command verbatim", () => {
    expect(buildDaytonaCommand("echo hi")).toBe("echo hi");
    expect(buildDaytonaCommand("echo hi", { sudo: false })).toBe("echo hi");
  });

  it("wraps a sudo command in a root bash -c so a compound command runs fully elevated", () => {
    // A bare `sudo touch a && touch b` would elevate only the first `touch`;
    // the whole command must be the `bash -c` argument.
    const cmd = buildDaytonaCommand("touch /root/a && touch /root/b", {
      sudo: true,
    });
    expect(cmd.startsWith("sudo -n")).toBe(true);
    expect(cmd).toContain("bash -c 'touch /root/a && touch /root/b'");
  });

  it("preserves the caller's env keys across the sudo boundary (plus the Amika hook vars)", () => {
    const cmd = buildDaytonaCommand("printenv FOO", {
      sudo: true,
      env: { FOO: "bar" },
    });
    expect(cmd).toContain(
      "--preserve-env=AMIKA_AGENT_CWD,AMIKA_OPENCODE_WEB,OPENCODE_SERVER_PASSWORD,FOO",
    );
  });
});

describe("buildDaytonaSessionCommand", () => {
  it("applies cwd and env in the outer shell, before sudo", () => {
    // Sessions take no cwd/env parameters, so both must be emitted into the
    // command string, and env must be exported *before* sudo, or
    // `--preserve-env` has nothing to preserve.
    const cmd = buildDaytonaSessionCommand("printenv FOO", {
      cwd: "/home/amika",
      env: { FOO: "bar" },
      sudo: true,
    });
    expect(
      cmd.startsWith("cd '/home/amika' && export FOO='bar' && sudo -n"),
    ).toBe(true);
  });

  it("rejects an environment variable name that is not shell-legal", () => {
    // The name is interpolated into an `export`, so it can't be trusted.
    expect(() =>
      buildDaytonaSessionCommand("true", { env: { "A; rm -rf /": "x" } }),
    ).toThrow(/Invalid environment variable name/u);
  });
});

describe("executeCommand", () => {
  it("keeps stderr out of stdout on a successful command", async () => {
    // The regression this guards: `sudo` writes "unable to resolve host …" to
    // stderr on images whose hostname doesn't resolve. Merging that into the
    // value stream broke every stdout parser, `amikad host-key show` first.
    const { sandbox } = fakeDaytonaSandbox(() => ({
      exitCode: 0,
      stdout: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5\n",
      stderr: "sudo: unable to resolve host sandbox\n",
    }));

    const result = await executeCommand(
      sandbox as DaytonaSandbox,
      "amikad host-key show",
      { sudo: true },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5\n");
    expect(result.stdout).not.toContain("unable to resolve host");
    expect(result.stderr).toBe("sudo: unable to resolve host sandbox\n");
  });

  it("pipes input to the command and closes stdin at the exact byte count", async () => {
    const { sandbox, commands } = fakeDaytonaSandbox();

    await executeCommand(
      sandbox as DaytonaSandbox,
      "amikad authorized-keys set",
      {
        input: "ssh-ed25519 AAAA\n",
      },
    );

    expect(commands).toHaveLength(1);
    expect(commands[0]!.command).toContain("head -c 17 | (");
    expect(commands[0]!.input).toBe("ssh-ed25519 AAAA\n");
  });

  it("treats empty input as no stdin wiring", async () => {
    const { sandbox, commands } = fakeDaytonaSandbox();

    await executeCommand(sandbox as DaytonaSandbox, "true", { input: "" });

    expect(commands[0]!.command).not.toContain("head -c");
    expect(commands[0]!.input).toBeUndefined();
  });

  it("deletes the session even when the command fails", async () => {
    const { sandbox, openSessions } = fakeDaytonaSandbox(() => ({
      exitCode: 1,
      stderr: "boom",
    }));

    const result = await executeCommand(sandbox as DaytonaSandbox, "false");

    expect(result.exitCode).toBe(1);
    expect(openSessions.size).toBe(0);
  });
});
