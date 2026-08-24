import { describe, expect, it } from "vitest";
import {
  buildCloneUrl,
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

// The token is a GitHub App installation token or a PAT. Git sends whatever is in
// a URL's userinfo to whatever host the URL names, and a clone may persist the
// result into `.git/config` — so what this embeds it into decides where a
// credential can end up.
describe("buildCloneUrl", () => {
  const TOKEN = "ghs_installation_token";

  it("authenticates an https github.com clone", () => {
    expect(buildCloneUrl("https://github.com/acme/widgets", TOKEN)).toBe(
      `https://x-access-token:${TOKEN}@github.com/acme/widgets`,
    );
  });

  it("never sends the token to another host", () => {
    for (const url of [
      "https://gitlab.com/group/project",
      "https://github.com.example.test/acme/widgets",
      "https://example.test/acme/widgets",
      "https://127.0.0.1:8080/acme/widgets",
    ]) {
      expect(buildCloneUrl(url, TOKEN), url).toBe(url);
    }
  });

  it("never sends the token over plaintext http", () => {
    expect(buildCloneUrl("http://github.com/acme/widgets", TOKEN)).toBe(
      "http://github.com/acme/widgets",
    );
  });

  it("ignores the case of the host", () => {
    expect(buildCloneUrl("https://GitHub.com/acme/widgets", TOKEN)).toContain(
      `x-access-token:${TOKEN}@`,
    );
  });

  it("leaves a non-URL alone rather than making it usable", () => {
    for (const value of [
      "ext::sh -c id",
      "--upload-pack=/bin/sh",
      "/etc/passwd",
      "git@github.com:acme/widgets.git",
    ]) {
      expect(buildCloneUrl(value, TOKEN), value).toBe(value);
    }
  });

  it("clones anonymously when there is no token", () => {
    for (const token of [undefined, null, ""]) {
      expect(buildCloneUrl("https://github.com/acme/widgets", token)).toBe(
        "https://github.com/acme/widgets",
      );
    }
  });

  // Percent-encoded via URL.password rather than spliced into the authority, so
  // a token containing URL-significant characters cannot reshape the URL.
  it("encodes the token rather than splicing it in", () => {
    const built = buildCloneUrl(
      "https://github.com/acme/widgets",
      "tok/en?with#chars",
    );

    expect(built).toBe(
      "https://x-access-token:tok%2Fen%3Fwith%23chars@github.com/acme/widgets",
    );
    expect(new URL(built).hostname).toBe("github.com");
  });
});
