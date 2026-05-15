import { useCallback, useEffect, useMemo } from "react";
import { useReview, useReviewState } from "./hooks.js";
import type { ReviewLocation } from "../location/types.js";

/**
 * Read + write the current ReviewLocation. The returned setter calls
 * `store.navigate(...)`, which updates selection and fires a scroll request
 * for line / comment targets.
 *
 * Pair this hook with `<ReviewProvider linkSync>` to bind it to the browser
 * URL automatically, or call it manually from a router-aware host component.
 */
export function useReviewLocation(): readonly [
  ReviewLocation,
  (next: ReviewLocation) => void,
] {
  const store = useReview();
  // Subscribe so the read side updates when selection changes.
  useReviewState();
  const location = useMemo(() => store.getLocation(), [store]);
  const navigate = useCallback(
    (next: ReviewLocation) => store.navigate(next),
    [store],
  );
  return [location, navigate] as const;
}

export interface LinkSyncAdapter {
  read(): string;
  write(search: string): void;
  subscribe?(listener: () => void): () => void;
}

/**
 * Bind the store's location to an external system (browser URL or a router).
 * Reads the current search on mount, calls navigate(), and pushes back on
 * selection changes. Returns the unbind cleanup.
 */
export function useLinkSync(
  enabled: boolean | LinkSyncAdapter | undefined,
): void {
  const store = useReview();

  useEffect(() => {
    if (!enabled) return;
    const adapter: LinkSyncAdapter =
      typeof enabled === "object"
        ? enabled
        : {
            read: () => window.location.search,
            write: (search) => {
              const url =
                window.location.pathname + (search ? "?" + search : "");
              window.history.pushState({}, "", url);
            },
            subscribe: (listener) => {
              const handler = () => listener();
              window.addEventListener("popstate", handler);
              return () => window.removeEventListener("popstate", handler);
            },
          };

    // Hydrate from URL on mount.
    const initial = store.locationFromSearch(adapter.read());
    if (initial.kind !== "none") store.navigate(initial);

    // Push selection changes back to URL.
    let lastSearch = adapter.read();
    const unsubState = store.subscribe(() => {
      const next = store.locationToSearch(store.getLocation());
      if (next === lastSearch) return;
      lastSearch = next;
      adapter.write(next);
    });

    // Respond to external URL changes.
    const unsubExt = adapter.subscribe?.(() => {
      const loc = store.locationFromSearch(adapter.read());
      store.navigate(loc);
    });

    return () => {
      unsubState();
      unsubExt?.();
    };
  }, [enabled, store]);
}
