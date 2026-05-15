import { useContext, useMemo, useSyncExternalStore } from "react";
import type { ReviewItem } from "../types.js";
import type { ReviewStore } from "../store/store.js";
import type { Comment, CommentFilter, ReviewState } from "../store/types.js";
import { ReviewStoreContext } from "./context.js";

/**
 * The store (and full ReviewAPI). Stable across renders. Throws if used
 * outside of <ReviewProvider>.
 */
export function useReview(): ReviewStore {
  const store = useContext(ReviewStoreContext);
  if (!store) {
    throw new Error("useReview must be used inside <ReviewProvider>");
  }
  return store;
}

/** Subscribe to the full review state. Re-renders on every change. */
export function useReviewState(): ReviewState {
  const store = useReview();
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

/** All items currently loaded in the review (one per uploaded patch/file). */
export function usePatches(): ReviewItem[] {
  return useReviewState().items;
}

/**
 * Comments matching the supplied filter. The result is memoized against
 * the relevant slices of state and filter so consumers can use it in
 * dependency arrays safely.
 */
export function useComments(filter?: CommentFilter): Comment[] {
  const state = useReviewState();
  const scope = filter?.scope;
  const itemId = filter?.itemId;
  const path = filter?.path;
  const line = filter?.line;
  return useMemo(() => {
    const all = Object.values(state.comments);
    if (!filter) return all;
    return all.filter((c) => {
      if (scope && c.scope.kind !== scope) return false;
      if (itemId !== undefined) {
        if (c.scope.kind === "series") return false;
        if ("itemId" in c.scope && c.scope.itemId !== itemId) return false;
      }
      if (path !== undefined) {
        if (c.scope.kind !== "line" && c.scope.kind !== "file") return false;
        if (c.scope.path !== path) return false;
      }
      if (line !== undefined) {
        if (c.scope.kind !== "line") return false;
        if (c.scope.line !== line) return false;
      }
      return true;
    });
  }, [state.comments, filter, scope, itemId, path, line]);
}

/**
 * Resolves the currently selected file (or null when nothing is selected
 * or the selection is stale).
 */
export function useSelectedFile(): {
  itemId: string;
  path: string;
  item: ReviewItem;
} | null {
  const state = useReviewState();
  const { itemId, path } = state.selection;
  if (!itemId || !path) return null;
  const item = state.items.find((i) => i.id === itemId);
  if (!item) return null;
  return { itemId, path, item };
}
