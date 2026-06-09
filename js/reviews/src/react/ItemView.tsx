import { useMemo } from "react";
import {
  File as PierreFile,
  FileDiff as PierreFileDiff,
  MultiFileDiff as PierreMultiFileDiff,
  PatchDiff as PierrePatchDiff,
  UnresolvedFile as PierreUnresolvedFile,
  type DiffLineAnnotation as PierreDiffLineAnnotation,
  type FileDiffMetadata as PierreFileDiffMetadata,
  type LineAnnotation as PierreLineAnnotation,
} from "@pierre/diffs/react";
import { useComments } from "./hooks.js";
import {
  type AmikaLineAnnotationMetadata,
  commentsToDiffLineAnnotations,
  commentsToLineAnnotations,
} from "./annotations.js";
import type { ReviewItem } from "../types.js";

export interface ItemViewProps {
  item: ReviewItem;
  /** When set, narrows the view to a single file inside the item. */
  selectedPath?: string | null;
  className?: string;
}

/**
 * Given a multi-file unified diff, return the section for a single file
 * matched by its "b/" path (the post-change path). Returns null when the
 * path is not found so callers can fall back to the full text.
 */
function extractFilePatch(patchText: string, path: string): string | null {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sections = patchText.split(/(?=^diff --git )/m);
  for (const section of sections) {
    if (new RegExp(`^diff --git \\S+ b/${escaped}\\n`).test(section)) {
      return section.trimEnd();
    }
  }
  return null;
}

export function ItemView({ item, selectedPath, className }: ItemViewProps) {
  const comments = useComments({ itemId: item.id, scope: "line" });

  const diffAnnotations = useMemo<
    PierreDiffLineAnnotation<AmikaLineAnnotationMetadata>[]
  >(() => {
    const scoped = selectedPath
      ? comments.filter(
          (c) => c.scope.kind === "line" && c.scope.path === selectedPath,
        )
      : comments;
    return commentsToDiffLineAnnotations(scoped);
  }, [comments, selectedPath]);

  const lineAnnotations = useMemo<
    PierreLineAnnotation<AmikaLineAnnotationMetadata>[]
  >(() => {
    const scoped = selectedPath
      ? comments.filter(
          (c) => c.scope.kind === "line" && c.scope.path === selectedPath,
        )
      : comments;
    return commentsToLineAnnotations(scoped);
  }, [comments, selectedPath]);

  switch (item.kind) {
    case "patch": {
      // PierrePatchDiff requires exactly 1 file diff. Resolve a target path:
      // prefer the explicit selectedPath, then fall back to the first parsed
      // file so the component always receives a single-file slice.
      const targetPath =
        selectedPath ??
        (item.parsed?.files[0]?.to ?? item.parsed?.files[0]?.from ?? null);
      const patch = targetPath
        ? (extractFilePatch(item.patchText, targetPath) ?? item.patchText)
        : item.patchText;
      return (
        <PierrePatchDiff<AmikaLineAnnotationMetadata>
          patch={patch}
          lineAnnotations={diffAnnotations}
          className={className}
        />
      );
    }

    case "multi-file-diff": {
      const path =
        selectedPath ??
        Object.keys(item.after)[0] ??
        Object.keys(item.before)[0];
      if (!path) return null;
      const oldContents = item.before[path] ?? "";
      const newContents = item.after[path] ?? "";
      return (
        <PierreMultiFileDiff<AmikaLineAnnotationMetadata>
          oldFile={{ name: path, contents: oldContents }}
          newFile={{ name: path, contents: newContents }}
          lineAnnotations={diffAnnotations}
          className={className}
        />
      );
    }

    case "file-diff":
      return (
        <PierreFileDiff<AmikaLineAnnotationMetadata>
          fileDiff={item.metadata as unknown as PierreFileDiffMetadata}
          lineAnnotations={diffAnnotations}
          className={className}
        />
      );

    case "file":
      return (
        <PierreFile<AmikaLineAnnotationMetadata>
          file={{ name: item.path, contents: item.content }}
          lineAnnotations={lineAnnotations}
          className={className}
        />
      );

    case "unresolved-file":
      return (
        <PierreUnresolvedFile<AmikaLineAnnotationMetadata>
          file={{ name: item.path, contents: item.content }}
          lineAnnotations={diffAnnotations}
          className={className}
        />
      );
  }
}
