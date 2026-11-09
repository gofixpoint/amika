import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fileRigOwners } from "./rig-owners.js";

describe("fileRigOwners", () => {
  it("keeps owners across restarts, in a private file", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "hd-own-")), "o");
    fileRigOwners(file).set("demo", { kind: "user", id: "user_1" });
    expect(fileRigOwners(file).get("demo")).toEqual({
      kind: "user",
      id: "user_1",
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const owners = fileRigOwners(file);
    owners.remove("demo");
    expect(fileRigOwners(file).get("demo")).toBeNull();
  });
});
