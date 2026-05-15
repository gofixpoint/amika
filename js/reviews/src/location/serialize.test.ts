import { describe, expect, it } from "vitest";
import { locationFromSearch, locationToSearch } from "./serialize.js";
import type { ReviewLocation } from "./types.js";

const cases: ReviewLocation[] = [
  { kind: "none" },
  { kind: "item", itemId: "abc123" },
  { kind: "file", itemId: "abc123", path: "src/x.ts" },
  { kind: "line", itemId: "abc123", path: "src/x.ts", line: 42, side: "new" },
  { kind: "line", itemId: "abc123", path: "src/x.ts", line: 1 },
  { kind: "comment", commentId: "cmt_42" },
];

describe("location serialize/parse round-trip", () => {
  for (const loc of cases) {
    it(`round-trips ${loc.kind}`, () => {
      const search = locationToSearch(loc);
      const parsed = locationFromSearch(search);
      expect(parsed).toEqual(loc);
    });
  }
});

describe("locationFromSearch — degradation", () => {
  it("returns 'none' on empty input", () => {
    expect(locationFromSearch("")).toEqual({ kind: "none" });
  });

  it("accepts leading ?", () => {
    expect(locationFromSearch("?item=x")).toEqual({
      kind: "item",
      itemId: "x",
    });
  });

  it("ignores unknown side values", () => {
    expect(locationFromSearch("item=x&file=a.ts&line=1&side=ham")).toEqual({
      kind: "line",
      itemId: "x",
      path: "a.ts",
      line: 1,
    });
  });

  it("degrades to file when line is non-numeric", () => {
    expect(locationFromSearch("item=x&file=a.ts&line=banana")).toEqual({
      kind: "file",
      itemId: "x",
      path: "a.ts",
    });
  });

  it("encodes paths safely", () => {
    const search = locationToSearch({
      kind: "file",
      itemId: "x",
      path: "src/sub dir/a b.ts",
    });
    expect(search).toContain("file=src%2Fsub+dir%2Fa+b.ts");
    expect(locationFromSearch(search)).toEqual({
      kind: "file",
      itemId: "x",
      path: "src/sub dir/a b.ts",
    });
  });
});
