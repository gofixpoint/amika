import { describe, expect, it } from "vitest";
import { gcpCommandLine } from "./exec";

describe("gcpCommandLine", () => {
  it("runs the command with bash -lc", () => {
    expect(gcpCommandLine("echo hi")).toBe("env bash -lc 'echo hi'");
  });

  it("quotes env values and the working directory", () => {
    expect(
      gcpCommandLine("pwd", { cwd: "/tmp/it's", env: { A: "x y", B: "$Z" } }),
    ).toBe(
      `env 'A=x y' 'B=$Z' bash -lc 'cd -- '"'"'/tmp/it'"'"'"'"'"'"'"'"'s'"'"' && pwd'`,
    );
  });

  it("puts sudo outside env, which sudo would reset", () => {
    expect(gcpCommandLine("id -u", { sudo: true, env: { A: "1" } })).toBe(
      "sudo -n env 'A=1' bash -lc 'id -u'",
    );
  });

  it("refuses an env name the shell would parse", () => {
    expect(() => gcpCommandLine("true", { env: { "A;rm": "1" } })).toThrow(
      /Invalid environment variable name/,
    );
  });
});
