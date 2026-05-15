import { useEffect, useMemo, type ReactNode } from "react";
import { ReviewProvider } from "./ReviewProvider.js";
import { FileTreePanel } from "./FileTreePanel.js";
import { ItemView } from "./ItemView.js";
import { UploadDropzone } from "./UploadDropzone.js";
import { ExportButton } from "./ExportButton.js";
import { FileCommentPanel } from "./FileCommentPanel.js";
import { ItemCommentPanel } from "./ItemCommentPanel.js";
import { SeriesCommentPanel } from "./SeriesCommentPanel.js";
import { useReview, useReviewState, useSelectedFile } from "./hooks.js";
import type { ReviewItem } from "../types.js";
import type { ReviewStore } from "../store/store.js";

export interface CodeReviewProps {
  initialItems?: ReviewItem[];
  author?: string;
  persistKey?: string;
  store?: ReviewStore;
  /** Extra content rendered in the header bar (e.g. a logo or user menu). */
  headerExtras?: ReactNode;
  className?: string;
}

/**
 * Top-level composition. Wraps everything in a ReviewProvider and lays out
 * the four panels (file tree, diff viewer, sidebar with comment panels,
 * header with upload + export).
 *
 * For granular layouts, host apps can skip this component and compose the
 * pieces (FileTreePanel / ItemView / *CommentPanel / UploadDropzone /
 * ExportButton) directly.
 */
export function CodeReview({
  initialItems,
  author,
  persistKey,
  store,
  headerExtras,
  className,
}: CodeReviewProps) {
  return (
    <ReviewProvider
      initialItems={initialItems}
      author={author}
      persistKey={persistKey}
      store={store}
    >
      <CodeReviewLayout headerExtras={headerExtras} className={className} />
    </ReviewProvider>
  );
}

function CodeReviewLayout({
  headerExtras,
  className,
}: {
  headerExtras?: ReactNode;
  className?: string;
}) {
  const state = useReviewState();
  const selected = useSelectedFile();
  const store = useReview();

  // Default selection: first file of first item once items are loaded and
  // nothing is selected.
  useDefaultSelection();

  const activeItem = useMemo(() => {
    if (selected) return selected.item;
    return state.items[0];
  }, [selected, state.items]);

  return (
    <div className={className} data-amika="code-review">
      <header data-amika="code-review-header">
        <UploadDropzone />
        <ExportButton />
        {headerExtras}
      </header>

      <div data-amika="code-review-tree">
        <FileTreePanel />
      </div>

      <div data-amika="code-review-diff">
        {activeItem ? (
          <ItemView item={activeItem} selectedPath={selected?.path ?? null} />
        ) : (
          <p data-amika="code-review-empty">
            Drop one or more .diff / .patch files to begin.
          </p>
        )}
      </div>

      <aside data-amika="code-review-sidebar">
        {selected && (
          <FileCommentPanel itemId={selected.itemId} path={selected.path} />
        )}
        {activeItem && (
          <ItemCommentPanel itemId={activeItem.id} label={activeItem.label} />
        )}
        <SeriesCommentPanel />
      </aside>

      {/* Hidden: lets tests / Playwright inspect items/selection without
          reaching into pierre's shadow DOM. */}
      <div hidden data-amika="code-review-meta">
        <span data-amika="item-count">{state.items.length}</span>
        <span data-amika="selected-item">{selected?.itemId ?? ""}</span>
        <span data-amika="selected-path">{selected?.path ?? ""}</span>
      </div>

      {/* unused store ref keeps strict-TS happy in the layout sub-component
          while making the store easy to grab from devtools. */}
      <input type="hidden" value={store.getItems().length} readOnly />
    </div>
  );
}

function useDefaultSelection() {
  const state = useReviewState();
  const store = useReview();
  const hasSelection = state.selection.itemId !== null;
  useEffect(() => {
    if (hasSelection) return;
    if (state.items.length === 0) return;
    const files = store.listFiles();
    if (files.length === 0) return;
    store.selectFile(files[0].itemId, files[0].path);
  }, [hasSelection, state.items, store]);
}
