import { describe, expect, it } from "vitest";
import {
  commentsToDiffLineAnnotations,
  commentsToLineAnnotations,
  sideToAnnotationSide,
} from "./annotations.js";
import type { Comment } from "../store/types.js";

function comment(
  over: Partial<Comment> & { scope: Comment["scope"] },
): Comment {
  return {
    id: "x",
    parentId: null,
    body: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    resolved: false,
    ...over,
  };
}

describe("annotations", () => {
  it("sideToAnnotationSide maps old/new to deletions/additions", () => {
    expect(sideToAnnotationSide("old")).toBe("deletions");
    expect(sideToAnnotationSide("new")).toBe("additions");
    expect(sideToAnnotationSide(undefined)).toBe("additions");
  });

  it("commentsToDiffLineAnnotations groups by (side, line)", () => {
    const annotations = commentsToDiffLineAnnotations([
      comment({
        id: "c1",
        scope: {
          kind: "line",
          itemId: "i",
          path: "a.ts",
          line: 10,
          side: "new",
        },
      }),
      comment({
        id: "c2",
        scope: {
          kind: "line",
          itemId: "i",
          path: "a.ts",
          line: 10,
          side: "new",
        },
      }),
      comment({
        id: "c3",
        scope: {
          kind: "line",
          itemId: "i",
          path: "a.ts",
          line: 10,
          side: "old",
        },
      }),
    ]);
    expect(annotations).toHaveLength(2);
    const additions = annotations.find((a) => a.side === "additions")!;
    expect(additions.metadata.comments).toHaveLength(2);
    const deletions = annotations.find((a) => a.side === "deletions")!;
    expect(deletions.metadata.comments).toHaveLength(1);
  });

  it("commentsToLineAnnotations groups by line only", () => {
    const annotations = commentsToLineAnnotations([
      comment({
        id: "c1",
        scope: { kind: "line", itemId: "i", path: "a.ts", line: 5 },
      }),
      comment({
        id: "c2",
        scope: { kind: "line", itemId: "i", path: "a.ts", line: 5 },
      }),
    ]);
    expect(annotations).toHaveLength(1);
    expect(annotations[0].metadata.comments).toHaveLength(2);
  });

  it("ignores non-line scopes", () => {
    expect(
      commentsToDiffLineAnnotations([
        comment({ id: "c", scope: { kind: "series" } }),
      ]),
    ).toHaveLength(0);
  });
});
