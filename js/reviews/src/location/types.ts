import type { CommentId, ReviewItemId, Side } from "../types.js";

/**
 * Encodes "what's currently focused" in a review session: an item, a file,
 * a line, or a comment thread. Self-resolving: comment links don't need to
 * separately carry item/file/line because the comment's stored scope is
 * authoritative.
 */
export type ReviewLocation =
  | { kind: "none" }
  | { kind: "item"; itemId: ReviewItemId }
  | { kind: "file"; itemId: ReviewItemId; path: string }
  | {
      kind: "line";
      itemId: ReviewItemId;
      path: string;
      line: number;
      side?: Side;
    }
  | { kind: "comment"; commentId: CommentId };
