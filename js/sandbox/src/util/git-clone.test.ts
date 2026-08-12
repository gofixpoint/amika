import { describe, expect, it } from "vitest";
import {
  buildGitCheckoutNewBranchCmd,
  buildGitSetPlainRemoteCmd,
} from "./git-clone";

describe("buildGitCheckoutNewBranchCmd", () => {
  it("builds a checkout command with the branch shell-quoted and a `--` guard", () => {
    expect(buildGitCheckoutNewBranchCmd("feature/x")).toBe(
      "git checkout -b 'feature/x' --",
    );
  });

  it("throws for a branch name starting with '-' (argument injection)", () => {
    expect(() => buildGitCheckoutNewBranchCmd("-b")).toThrow(
      /argument injection/,
    );
  });

  it("throws for a branch name with shell metacharacters", () => {
    expect(() => buildGitCheckoutNewBranchCmd("main; rm -rf /")).toThrow(
      /shell metacharacters/,
    );
  });

  it("throws for an empty branch name", () => {
    expect(() => buildGitCheckoutNewBranchCmd("")).toThrow(/empty/);
  });
});

describe("buildGitSetPlainRemoteCmd", () => {
  it("builds a set-url command with the URL shell-quoted", () => {
    expect(
      buildGitSetPlainRemoteCmd("https://github.com/gofixpoint/amika.git"),
    ).toBe(
      "git remote set-url origin 'https://github.com/gofixpoint/amika.git'",
    );
  });

  it("neutralizes single quotes in the URL", () => {
    expect(buildGitSetPlainRemoteCmd("https://host/x'y")).toBe(
      `git remote set-url origin 'https://host/x'"'"'y'`,
    );
  });
});
