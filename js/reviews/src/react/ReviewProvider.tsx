import { useMemo, type ReactNode } from "react";
import { createReviewStore, type ReviewStore } from "../store/store.js";
import type { ReviewItem } from "../types.js";
import { ReviewStoreContext } from "./context.js";

export interface ReviewProviderProps {
  /** Items the store starts with. Read once on mount; later changes are ignored. */
  initialItems?: ReviewItem[];
  /** Default author for comments that don't specify their own. */
  author?: string;
  /**
   * When set, the store persists to localStorage under this key and
   * re-hydrates on mount. Omit for ephemeral sessions.
   */
  persistKey?: string;
  /**
   * Inject a pre-built store. Lets the host control creation (e.g. for
   * testing with deterministic ids, or for sharing one store between
   * multiple providers).
   */
  store?: ReviewStore;
  children: ReactNode;
}

/**
 * React provider for @amika/reviews. Creates a framework-agnostic store on
 * mount (or accepts a caller-supplied one) and exposes it via context so
 * `useReview`, `useReviewState`, and the other hooks can subscribe.
 */
export function ReviewProvider({
  initialItems,
  author,
  persistKey,
  store: storeProp,
  children,
}: ReviewProviderProps) {
  const store = useMemo(
    () => storeProp ?? createReviewStore({ initialItems, author, persistKey }),
    // Store is intentionally constructed once. Prop changes after mount
    // are deliberately ignored so the store remains the source of truth.
    [storeProp],
  );

  return (
    <ReviewStoreContext.Provider value={store}>
      {children}
    </ReviewStoreContext.Provider>
  );
}
