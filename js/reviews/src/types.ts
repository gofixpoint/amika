/**
 * Public type surface for @amika/reviews. Intentionally library-agnostic:
 * the parsed-patch representation is our own normalized shape, not parse-diff's.
 * FileDiffMetadata is treated as opaque caller-supplied data; it will be tightened
 * to @pierre/diffs/react's exported type when that integration lands.
 */

export type Side = "old" | "new";

export type ReviewItemId = string;
export type CommentId = string;

export type FileMap = Record<string, string>;

/**
 * Pre-parsed diff metadata for a single file. We require `name` (the file
 * path) here so the file tree can show the row; everything else is
 * library-defined and forwarded verbatim. Structurally compatible with
 * `@pierre/diffs`'s `FileDiffMetadata`.
 */
export interface FileDiffMetadata {
  name: string;
  [key: string]: unknown;
}

export type ReviewItem =
  | {
      id: ReviewItemId;
      kind: "patch";
      patchText: string;
      label?: string;
      parsed?: ParsedPatch;
    }
  | {
      id: ReviewItemId;
      kind: "multi-file-diff";
      before: FileMap;
      after: FileMap;
      label?: string;
    }
  | {
      id: ReviewItemId;
      kind: "file-diff";
      metadata: FileDiffMetadata;
      label?: string;
    }
  | {
      id: ReviewItemId;
      kind: "file";
      path: string;
      content: string;
      label?: string;
    }
  | {
      id: ReviewItemId;
      kind: "unresolved-file";
      path: string;
      content: string;
      label?: string;
    };

export type ReviewItemKind = ReviewItem["kind"];

export interface ParsedPatch {
  files: ParsedFile[];
}

export type FileStatus =
  | "added"
  | "deleted"
  | "modified"
  | "renamed"
  | "binary";

export interface ParsedFile {
  /** Pre-change path; null when the file is newly added. */
  from: string | null;
  /** Post-change path; null when the file is deleted. */
  to: string | null;
  status: FileStatus;
  hunks: Hunk[];
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: HunkLine[];
}

export interface HunkLine {
  type: "context" | "add" | "del";
  content: string;
  oldLine?: number;
  newLine?: number;
}
