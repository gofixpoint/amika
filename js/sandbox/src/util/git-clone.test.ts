import { describe, expect, it } from "vitest";
import {
  buildGitCheckoutNewBranchCmd,
  buildGitSetPlainRemoteCmd,
  buildRefreshClonedRepoScript,
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

describe("buildRefreshClonedRepoScript", () => {
  const url = "https://github.com/gofixpoint/amika.git";

  it("syncs and checks out submodules by default", () => {
    const lines = buildRefreshClonedRepoScript(url, "main").split("\n");

    expect(lines.at(-2)).toBe("git submodule sync --recursive");
    expect(lines.at(-1)).toBe("git submodule update --init --recursive");
  });

  it("syncs submodules after the branch checkout, not before", () => {
    const script = buildRefreshClonedRepoScript(url, "main");

    // The submodule commits a superproject pins are a property of the checked
    // out tree, so updating before the checkout would sync against the old one.
    expect(script.indexOf("git submodule update")).toBeGreaterThan(
      script.indexOf("git checkout -f -B 'main'"),
    );
  });

  it("recurses on the default-branch path too", () => {
    const script = buildRefreshClonedRepoScript(url);

    expect(script).toContain("git submodule update --init --recursive");
  });

  it("omits the submodule commands when recursion is disabled", () => {
    const script = buildRefreshClonedRepoScript(url, "main", false);

    expect(script).not.toContain("git submodule");
    expect(script).toContain("git checkout -f -B 'main'");
  });
});
