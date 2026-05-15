import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePatch, parsePatches } from "./parser.js";
import { loadFromText } from "./io.js";
import { hashItemId } from "./util/hashItemId.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  readFileSync(join(HERE, "test/fixtures", name), "utf8");

describe("parsePatch", () => {
  it("parses a single-file modification with one hunk", () => {
    const item = parsePatch(fixture("single-file.patch"));
    expect(item.kind).toBe("patch");
    if (item.kind !== "patch") throw new Error("unreachable");
    expect(item.parsed?.files).toHaveLength(1);
    const f = item.parsed!.files[0];
    expect(f.from).toBe("src/hello.ts");
    expect(f.to).toBe("src/hello.ts");
    expect(f.status).toBe("modified");
    expect(f.hunks).toHaveLength(1);
    const adds = f.hunks[0].lines.filter((l) => l.type === "add");
    const dels = f.hunks[0].lines.filter((l) => l.type === "del");
    expect(adds).toHaveLength(2);
    expect(dels).toHaveLength(1);
    expect(adds[0].newLine).toBeGreaterThan(0);
    expect(dels[0].oldLine).toBeGreaterThan(0);
  });

  it("parses a multi-file patch with add, modify, and delete", () => {
    const item = parsePatch(fixture("multi-file.patch"));
    if (item.kind !== "patch") throw new Error("unreachable");
    expect(item.parsed?.files).toHaveLength(3);
    const byStatus = Object.fromEntries(
      item.parsed!.files.map((f) => [f.status, f]),
    );
    expect(byStatus.added.to).toBe("src/b.ts");
    expect(byStatus.added.from).toBeNull();
    expect(byStatus.deleted.from).toBe("src/c.ts");
    expect(byStatus.deleted.to).toBeNull();
    expect(byStatus.modified.from).toBe("src/a.ts");
  });

  it("parses a rename as `renamed` with distinct from/to paths", () => {
    const item = parsePatch(fixture("rename.patch"));
    if (item.kind !== "patch") throw new Error("unreachable");
    const f = item.parsed!.files[0];
    expect(f.status).toBe("renamed");
    expect(f.from).toBe("src/old-name.ts");
    expect(f.to).toBe("src/new-name.ts");
  });

  it("classifies a hunk-less binary patch as `binary`", () => {
    const item = parsePatch(fixture("binary.patch"));
    if (item.kind !== "patch") throw new Error("unreachable");
    expect(item.parsed?.files).toHaveLength(1);
    const f = item.parsed!.files[0];
    expect(f.status).toBe("binary");
    expect(f.hunks).toHaveLength(0);
  });

  it("does not throw on malformed input; produces zero files", () => {
    const item = parsePatch(fixture("malformed.patch"));
    if (item.kind !== "patch") throw new Error("unreachable");
    expect(item.parsed?.files).toHaveLength(0);
    expect(item.patchText.length).toBeGreaterThan(0);
  });
});

describe("parsePatches / loadFromText", () => {
  it("returns one ReviewItem per input string", () => {
    const items = parsePatches([
      fixture("single-file.patch"),
      fixture("rename.patch"),
    ]);
    expect(items).toHaveLength(2);
    expect(items[0].id).not.toBe(items[1].id);
  });

  it("loadFromText accepts a single string", () => {
    const items = loadFromText(fixture("single-file.patch"));
    expect(items).toHaveLength(1);
  });

  it("loadFromText accepts an array of strings", () => {
    const items = loadFromText([
      fixture("single-file.patch"),
      fixture("multi-file.patch"),
    ]);
    expect(items).toHaveLength(2);
  });
});

describe("hashItemId", () => {
  it("is deterministic for the same input", () => {
    expect(hashItemId("hello world")).toBe(hashItemId("hello world"));
  });

  it("differs for different inputs", () => {
    expect(hashItemId("a")).not.toBe(hashItemId("b"));
  });

  it("produces a 12-character hex string", () => {
    expect(hashItemId("anything")).toMatch(/^[0-9a-f]{12}$/);
  });
});
