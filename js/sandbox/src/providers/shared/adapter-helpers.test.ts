import { describe, expect, it } from "vitest";
import { getRepoDir, getWorkspaceDir } from "./adapter-helpers";

describe("getWorkspaceDir", () => {
  it("appends /workspace to the home directory", () => {
    expect(getWorkspaceDir("/home/amika")).toBe("/home/amika/workspace");
  });

  it("works for a root home directory", () => {
    expect(getWorkspaceDir("/root")).toBe("/root/workspace");
  });
});

describe("getRepoDir", () => {
  it("nests the repo name under the workspace directory", () => {
    expect(getRepoDir("/home/amika", "amika")).toBe(
      "/home/amika/workspace/amika",
    );
  });

  it("returns the workspace directory when no repo name is given", () => {
    expect(getRepoDir("/home/amika")).toBe("/home/amika/workspace");
  });

  it("returns the workspace directory when the repo name is null", () => {
    expect(getRepoDir("/home/amika", null)).toBe("/home/amika/workspace");
  });

  it("returns the workspace directory when the repo name is empty", () => {
    expect(getRepoDir("/home/amika", "")).toBe("/home/amika/workspace");
  });
});
