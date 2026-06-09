import parseDiff from "parse-diff";
import { hashItemId } from "./util/hashItemId.js";
import type {
  FileStatus,
  Hunk,
  HunkLine,
  ParsedFile,
  ParsedPatch,
  ReviewItem,
} from "./types.js";

/**
 * Parse one unified-diff / patch string into a `patch` ReviewItem. The item's
 * id is a content-hash of the patch text by default; callers wanting to use a
 * commit SHA should override after the fact.
 */
export function parsePatch(text: string): ReviewItem {
  const parsed = normalizeParsed(parseDiff(text));
  return {
    id: hashItemId(text),
    kind: "patch",
    patchText: text,
    parsed,
  };
}

/** Parse multiple patches at once. Returns one ReviewItem per input string. */
export function parsePatches(texts: string[]): ReviewItem[] {
  return texts.map(parsePatch);
}

function normalizeParsed(files: parseDiff.File[]): ParsedPatch {
  return { files: files.map(toParsedFile) };
}

function toParsedFile(f: parseDiff.File): ParsedFile {
  const from = normalizePath(f.from);
  const to = normalizePath(f.to);
  return {
    from,
    to,
    status: deriveStatus(f, from, to),
    hunks: f.chunks.map(toHunk),
  };
}

function normalizePath(p: string | undefined): string | null {
  if (!p || p === "/dev/null") return null;
  // parse-diff leaves the "a/" / "b/" prefixes in place.
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

function deriveStatus(
  f: parseDiff.File,
  from: string | null,
  to: string | null,
): FileStatus {
  // parse-diff doesn't surface binary patches with hunks, so we infer.
  if (f.chunks.length === 0 && from && to && from !== to) return "renamed";
  if (f.chunks.length === 0) return "binary";
  if (f.new || from === null) return "added";
  if (f.deleted || to === null) return "deleted";
  if (from && to && from !== to) return "renamed";
  return "modified";
}

function toHunk(c: parseDiff.Chunk): Hunk {
  return {
    oldStart: c.oldStart,
    oldLines: c.oldLines,
    newStart: c.newStart,
    newLines: c.newLines,
    lines: c.changes.map(toHunkLine),
  };
}

function toHunkLine(ch: parseDiff.Change): HunkLine {
  switch (ch.type) {
    case "add":
      return { type: "add", content: ch.content, newLine: ch.ln };
    case "del":
      return { type: "del", content: ch.content, oldLine: ch.ln };
    case "normal":
      return {
        type: "context",
        content: ch.content,
        oldLine: ch.ln1,
        newLine: ch.ln2,
      };
  }
}
