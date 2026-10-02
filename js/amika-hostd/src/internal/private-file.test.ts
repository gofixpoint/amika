/** Cover writing a secret-holding file only its owner can read. */
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writePrivateFile } from "./private-file.js";

describe("writePrivateFile", () => {
  it("creates the directory and a file only its owner can read", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "amika-hostd-"));
    const file = path.join(dir, "nested", "secret");
    writePrivateFile(file, "secret\n");
    expect(readFileSync(file, "utf8")).toBe("secret\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    // Nothing is left beside it.
    expect(readdirSync(path.dirname(file))).toEqual(["secret"]);
  });

  it("replaces an existing file, giving it the owner-only mode", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "amika-hostd-"));
    const file = path.join(dir, "secret");
    writeFileSync(file, "old\n", { mode: 0o644 });
    writePrivateFile(file, "new\n");
    expect(readFileSync(file, "utf8")).toBe("new\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(file)).toBe(true);
  });
});
