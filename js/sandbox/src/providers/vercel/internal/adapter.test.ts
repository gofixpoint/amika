import { describe, expect, it } from "vitest";
import { buildVercelCommand, redactCommandForLabel } from "./adapter";

describe("buildVercelCommand", () => {
  it("sources the managed env before the command", () => {
    const script = buildVercelCommand("echo hi");
    const lines = script.split("\n");
    expect(lines[0]).toContain("/etc/environment");
    expect(lines.at(-1)).toBe("echo hi");
  });

  it("exports explicit env vars (quoted) before changing directory and running", () => {
    const script = buildVercelCommand("npm install", {
      env: { FOO: "bar baz" },
      cwd: "/home/sandbox/workspace/app",
    });
    const lines = script.split("\n");
    expect(lines).toEqual([
      expect.stringContaining("/etc/environment"),
      `export FOO='bar baz'`,
      `cd '/home/sandbox/workspace/app' || exit 1`,
      "npm install",
    ]);
  });

  it("omits the export/cd segments when no env or cwd is given", () => {
    const script = buildVercelCommand("ls");
    expect(script.split("\n")).toHaveLength(2);
  });
});

describe("redactCommandForLabel", () => {
  it("masks a GitHub token embedded in a clone URL", () => {
    const command =
      "git clone 'https://x-access-token:ghs_secretTokenValue@github.com/org/repo.git' '/home/repo'";
    const redacted = redactCommandForLabel(command);
    expect(redacted).not.toContain("ghs_secretTokenValue");
    expect(redacted).toContain("https://***@github.com/org/repo.git");
  });

  it("masks credentials in any http(s) userinfo, not just clone", () => {
    expect(redactCommandForLabel("git ls-remote https://user:pw@host/x")).toBe(
      "git ls-remote https://***@host/x",
    );
  });

  it("leaves credential-free commands unchanged", () => {
    expect(redactCommandForLabel("npm install")).toBe("npm install");
    expect(redactCommandForLabel("git clone https://github.com/org/repo")).toBe(
      "git clone https://github.com/org/repo",
    );
  });
});
