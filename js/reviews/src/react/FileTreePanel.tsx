import { useMemo } from "react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { useComments, useReview, useReviewState } from "./hooks.js";

export interface FileTreePanelProps {
  /** Optional class applied to the host element wrapping the tree. */
  className?: string;
  /**
   * Optional callback fired when a file is selected. Defaults to calling
   * `store.selectFile(itemId, path)` against the most recently loaded item
   * that contains the path.
   */
  onSelectFile?: (itemId: string, path: string) => void;
}

/**
 * Left-rail file tree. Reads the current set of files from the store, renders
 * them through `@pierre/trees/react`, and forwards selection back to the
 * store so the diff viewer can react. Each file row carries a row decoration
 * showing the count of comments scoped to that path (when non-zero).
 */
export function FileTreePanel({ className, onSelectFile }: FileTreePanelProps) {
  const store = useReview();
  const state = useReviewState();
  const fileComments = useComments();

  // Deduplicate paths across items; remember which item each path most
  // recently came from so selection can route the right itemId back.
  const { paths, itemForPath } = useMemo(() => {
    const map = new Map<string, string>(); // path -> itemId
    for (const entry of store.listFiles()) {
      map.set(entry.path, entry.itemId);
    }
    return { paths: [...map.keys()], itemForPath: map };
    // listFiles is derived from items, so we recompute when items change.
  }, [store, state.items]);

  // Comment counts per path (only line + file scopes contribute).
  const countsByPath = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of fileComments) {
      if (c.scope.kind !== "line" && c.scope.kind !== "file") continue;
      counts.set(c.scope.path, (counts.get(c.scope.path) ?? 0) + 1);
    }
    return counts;
  }, [fileComments]);

  const { model } = useFileTree({
    paths,
    initialExpansion: "open",
    onSelectionChange: (selected) => {
      if (selected.length === 0) return;
      const path = selected[selected.length - 1];
      // Directories also fire selection events; route only files.
      if (!itemForPath.has(path)) return;
      const itemId = itemForPath.get(path)!;
      if (onSelectFile) onSelectFile(itemId, path);
      else store.selectFile(itemId, path);
    },
    renderRowDecoration: ({ row }) => {
      if (row.kind !== "file") return null;
      const n = countsByPath.get(row.path);
      if (!n) return null;
      return { text: String(n), title: `${n} comment${n === 1 ? "" : "s"}` };
    },
  });

  return <FileTree model={model} className={className} />;
}
