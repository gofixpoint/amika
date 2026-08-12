import { describe, expect, it } from "vitest";
import { getRepoNameFromGithubUrl } from "./github";

describe("getRepoNameFromGithubUrl", () => {
  it("extracts the repo name from an owner/repo URL", () => {
    expect(
      getRepoNameFromGithubUrl("https://github.com/gofixpoint/amika"),
    ).toBe("amika");
  });

  it("strips a trailing .git suffix", () => {
    expect(
      getRepoNameFromGithubUrl("https://github.com/gofixpoint/amika.git"),
    ).toBe("amika");
  });

  it("only strips .git at the end, not mid-name", () => {
    expect(
      getRepoNameFromGithubUrl("https://github.com/gofixpoint/my.git.repo"),
    ).toBe("my.git.repo");
  });

  it("ignores trailing slashes", () => {
    expect(
      getRepoNameFromGithubUrl("https://github.com/gofixpoint/amika/"),
    ).toBe("amika");
  });

  it("returns the repo even when the path has extra segments", () => {
    expect(
      getRepoNameFromGithubUrl(
        "https://github.com/gofixpoint/amika/tree/main/js",
      ),
    ).toBe("amika");
  });

  it("accepts http as well as https", () => {
    expect(getRepoNameFromGithubUrl("http://github.com/owner/repo")).toBe(
      "repo",
    );
  });

  it("returns null for a non-github host", () => {
    expect(
      getRepoNameFromGithubUrl("https://gitlab.com/owner/repo"),
    ).toBeNull();
  });

  it("rejects look-alike hosts (no substring match)", () => {
    expect(
      getRepoNameFromGithubUrl("https://github.com.evil.com/owner/repo"),
    ).toBeNull();
    expect(
      getRepoNameFromGithubUrl("https://notgithub.com/owner/repo"),
    ).toBeNull();
  });

  it("returns null when the owner or repo segment is missing", () => {
    expect(getRepoNameFromGithubUrl("https://github.com/owner")).toBeNull();
    expect(getRepoNameFromGithubUrl("https://github.com/")).toBeNull();
  });

  it("returns null for a non-URL string", () => {
    expect(getRepoNameFromGithubUrl("not a url")).toBeNull();
    expect(getRepoNameFromGithubUrl("")).toBeNull();
  });
});
