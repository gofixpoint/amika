import type { Comment } from "../store/types.js";
import type { Side } from "../types.js";

/** Pierre uses 'deletions' / 'additions'; we expose 'old' / 'new' to consumers. */
export type AnnotationSide = "deletions" | "additions";

export function sideToAnnotationSide(side: Side | undefined): AnnotationSide {
  return side === "old" ? "deletions" : "additions";
}

export interface AmikaLineAnnotationMetadata {
  comments: Comment[];
}

export interface AmikaDiffLineAnnotation {
  lineNumber: number;
  side: AnnotationSide;
  metadata: AmikaLineAnnotationMetadata;
}

export interface AmikaLineAnnotation {
  lineNumber: number;
  metadata: AmikaLineAnnotationMetadata;
}

/** Group line-scope comments into pierre-compatible DiffLineAnnotations. */
export function commentsToDiffLineAnnotations(
  comments: Comment[],
): AmikaDiffLineAnnotation[] {
  const buckets = new Map<string, AmikaDiffLineAnnotation>();
  for (const c of comments) {
    if (c.scope.kind !== "line") continue;
    const side = sideToAnnotationSide(c.scope.side);
    const key = `${side}:${c.scope.line}`;
    let entry = buckets.get(key);
    if (!entry) {
      entry = {
        lineNumber: c.scope.line,
        side,
        metadata: { comments: [] },
      };
      buckets.set(key, entry);
    }
    entry.metadata.comments.push(c);
  }
  return [...buckets.values()];
}

/** Group line-scope comments into pierre-compatible LineAnnotations (no side). */
export function commentsToLineAnnotations(
  comments: Comment[],
): AmikaLineAnnotation[] {
  const buckets = new Map<number, AmikaLineAnnotation>();
  for (const c of comments) {
    if (c.scope.kind !== "line") continue;
    let entry = buckets.get(c.scope.line);
    if (!entry) {
      entry = { lineNumber: c.scope.line, metadata: { comments: [] } };
      buckets.set(c.scope.line, entry);
    }
    entry.metadata.comments.push(c);
  }
  return [...buckets.values()];
}
