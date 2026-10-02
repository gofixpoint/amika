/** Write files that hold secrets so that only their owner can read them. */
import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Write `contents` so only the owner can read it, replacing `file`
 * atomically. The directory is created owner-only if it is missing.
 */
export function writePrivateFile(file: string, contents: string) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // A fresh, unguessable name created exclusively, so the mode applies and no
  // existing file (or link) is written through.
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
