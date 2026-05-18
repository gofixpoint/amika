import type { ReviewState } from "./types.js";
import { isReviewExportV1 } from "./export.js";

const KEY_PREFIX = "@amika/reviews/";

export interface PersistenceAdapter {
  load(): Partial<ReviewState> | null;
  save(state: ReviewState): void;
  subscribeRemote(listener: (state: Partial<ReviewState>) => void): () => void;
}

/**
 * localStorage-backed adapter, scoped by `key`. Read/write failures (quota,
 * SSR, disabled storage) are swallowed so the store still functions.
 */
export function createLocalStoragePersistence(
  key: string,
  storage: Storage | undefined = typeof window === "undefined"
    ? undefined
    : window.localStorage,
): PersistenceAdapter {
  const storageKey = KEY_PREFIX + key;

  return {
    load() {
      if (!storage) return null;
      try {
        const raw = storage.getItem(storageKey);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!isReviewExportV1(parsed)) return null;
        const comments: ReviewState["comments"] = {};
        for (const c of parsed.comments) comments[c.id] = c;
        return { items: parsed.items, comments };
      } catch {
        return null;
      }
    },

    save(state) {
      if (!storage) return;
      try {
        const payload = {
          schemaVersion: 1 as const,
          exportedAt: new Date().toISOString(),
          items: state.items,
          comments: Object.values(state.comments),
        };
        storage.setItem(storageKey, JSON.stringify(payload));
      } catch {
        // ignore quota / serialization failures
      }
    },

    subscribeRemote(listener) {
      if (typeof window === "undefined") return () => {};
      const handler = (e: StorageEvent) => {
        if (e.key !== storageKey || e.newValue === null) return;
        try {
          const parsed = JSON.parse(e.newValue);
          if (!isReviewExportV1(parsed)) return;
          const comments: ReviewState["comments"] = {};
          for (const c of parsed.comments) comments[c.id] = c;
          listener({ items: parsed.items, comments });
        } catch {
          // ignore
        }
      };
      window.addEventListener("storage", handler);
      return () => window.removeEventListener("storage", handler);
    },
  };
}
