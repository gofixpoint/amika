import type { CommentId, ReviewItem, ReviewItemId } from "../types.js";
import { loadFromFiles, loadFromText } from "../io.js";
import {
  type ReviewExportV1,
  exportReview,
  isReviewExportV1,
} from "./export.js";
import { initialState, reducer } from "./reducer.js";
import {
  type PersistenceAdapter,
  createLocalStoragePersistence,
} from "./persistence.js";
import type {
  Action,
  Comment,
  CommentFilter,
  CommentScope,
  ReviewState,
} from "./types.js";

export interface CreateReviewStoreOptions {
  initialItems?: ReviewItem[];
  /**
   * When set, state is persisted to localStorage under the matching key and
   * re-hydrated on construction. Use any string; values from different keys
   * never collide.
   */
  persistKey?: string;
  /** Default author attached to comments that don't specify their own. */
  author?: string;
  /** Inject for tests; defaults to `() => new Date().toISOString()`. */
  now?: () => string;
  /** Inject for tests; defaults to `crypto.randomUUID()` with a `cmt_` prefix. */
  newCommentId?: () => CommentId;
  /** Inject a custom persistence adapter (e.g. for tests or non-browser hosts). */
  persistence?: PersistenceAdapter;
}

export interface ReviewStore {
  // Read
  getState(): ReviewState;
  subscribe(listener: (state: ReviewState) => void): () => void;

  // Loading
  loadFromText(input: string | string[]): ReviewItem[];
  loadFromFiles(files: File[]): Promise<ReviewItem[]>;
  addItem(item: ReviewItem): void;
  reset(): void;

  // Navigation
  getItems(): ReviewItem[];
  getItem(itemId: ReviewItemId): ReviewItem | undefined;
  listFiles(itemId?: ReviewItemId): { itemId: ReviewItemId; path: string }[];
  getSelection(): { itemId: ReviewItemId | null; path: string | null };
  selectFile(itemId: ReviewItemId | null, path: string | null): void;

  // Comments
  addComment(input: {
    scope: CommentScope;
    body: string;
    author?: string;
  }): Comment;
  reply(parentId: CommentId, body: string, author?: string): Comment;
  editComment(id: CommentId, body: string): Comment | undefined;
  deleteComment(id: CommentId): void;
  setResolved(id: CommentId, resolved: boolean): Comment | undefined;
  getComment(id: CommentId): Comment | undefined;
  getComments(filter?: CommentFilter): Comment[];
  getThread(rootId: CommentId): Comment[];

  // Snapshot
  export(): ReviewExportV1;
  import(snapshot: ReviewExportV1): void;
}

export function createReviewStore(
  options: CreateReviewStoreOptions = {},
): ReviewStore {
  const now = options.now ?? (() => new Date().toISOString());
  const newCommentId = options.newCommentId ?? defaultCommentId;
  const persistence =
    options.persistence ??
    (options.persistKey
      ? createLocalStoragePersistence(options.persistKey)
      : null);

  let state: ReviewState = {
    ...initialState,
    items: options.initialItems ?? [],
  };

  if (persistence) {
    const loaded = persistence.load();
    if (loaded) {
      state = {
        items: loaded.items ?? state.items,
        comments: loaded.comments ?? state.comments,
        selection: { itemId: null, path: null },
      };
    }
  }

  const listeners = new Set<(state: ReviewState) => void>();

  function setState(next: ReviewState) {
    if (next === state) return;
    state = next;
    for (const l of listeners) l(state);
    persistence?.save(state);
  }

  function dispatch(action: Action) {
    setState(reducer(state, action));
  }

  if (persistence) {
    persistence.subscribeRemote((partial) => {
      setState({
        ...state,
        items: partial.items ?? state.items,
        comments: partial.comments ?? state.comments,
      });
    });
  }

  function getItem(itemId: ReviewItemId): ReviewItem | undefined {
    return state.items.find((i) => i.id === itemId);
  }

  function listFiles(itemId?: ReviewItemId) {
    const items = itemId
      ? state.items.filter((i) => i.id === itemId)
      : state.items;
    const out: { itemId: ReviewItemId; path: string }[] = [];
    for (const item of items) {
      for (const path of pathsForItem(item)) {
        out.push({ itemId: item.id, path });
      }
    }
    return out;
  }

  function commentMatchesFilter(c: Comment, f: CommentFilter): boolean {
    if (f.scope && c.scope.kind !== f.scope) return false;
    if (f.itemId !== undefined) {
      if (c.scope.kind === "series") return false;
      if ("itemId" in c.scope && c.scope.itemId !== f.itemId) return false;
    }
    if (f.path !== undefined) {
      if (c.scope.kind !== "line" && c.scope.kind !== "file") return false;
      if (c.scope.path !== f.path) return false;
    }
    if (f.line !== undefined) {
      if (c.scope.kind !== "line") return false;
      if (c.scope.line !== f.line) return false;
    }
    return true;
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    loadFromText(input) {
      const items = loadFromText(input);
      dispatch({ type: "LOAD_ITEMS", items });
      return items;
    },

    async loadFromFiles(files) {
      const items = await loadFromFiles(files);
      dispatch({ type: "LOAD_ITEMS", items });
      return items;
    },

    addItem(item) {
      dispatch({ type: "ADD_ITEM", item });
    },

    reset() {
      dispatch({ type: "RESET" });
    },

    getItems: () => state.items,
    getItem,
    listFiles,
    getSelection: () => state.selection,

    selectFile(itemId, path) {
      dispatch({ type: "SELECT_FILE", itemId, path });
    },

    addComment(input) {
      const ts = now();
      const comment: Comment = {
        id: newCommentId(),
        parentId: null,
        scope: input.scope,
        body: input.body,
        author: input.author ?? options.author,
        createdAt: ts,
        updatedAt: ts,
        resolved: false,
      };
      dispatch({ type: "ADD_COMMENT", comment });
      return comment;
    },

    reply(parentId, body, author) {
      const parent = state.comments[parentId];
      if (!parent) {
        throw new Error(`reply: parent comment ${parentId} not found`);
      }
      const ts = now();
      const comment: Comment = {
        id: newCommentId(),
        parentId,
        scope: parent.scope,
        body,
        author: author ?? options.author,
        createdAt: ts,
        updatedAt: ts,
        resolved: false,
      };
      dispatch({ type: "ADD_COMMENT", comment });
      return comment;
    },

    editComment(id, body) {
      if (!state.comments[id]) return undefined;
      dispatch({ type: "EDIT_COMMENT", id, body, updatedAt: now() });
      return state.comments[id];
    },

    deleteComment(id) {
      dispatch({ type: "DELETE_COMMENT", id });
    },

    setResolved(id, resolved) {
      if (!state.comments[id]) return undefined;
      dispatch({ type: "SET_RESOLVED", id, resolved, updatedAt: now() });
      return state.comments[id];
    },

    getComment: (id) => state.comments[id],

    getComments(filter) {
      const all = Object.values(state.comments);
      if (!filter) return all;
      return all.filter((c) => commentMatchesFilter(c, filter));
    },

    getThread(rootId) {
      const root = state.comments[rootId];
      if (!root) return [];
      const result: Comment[] = [root];
      const seen = new Set([rootId]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const c of Object.values(state.comments)) {
          if (c.parentId && seen.has(c.parentId) && !seen.has(c.id)) {
            result.push(c);
            seen.add(c.id);
            changed = true;
          }
        }
      }
      result.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return result;
    },

    export: () => exportReview(state, now),

    import(snapshot) {
      if (!isReviewExportV1(snapshot)) {
        throw new Error("import: invalid ReviewExportV1 payload");
      }
      dispatch({
        type: "IMPORT",
        payload: { items: snapshot.items, comments: snapshot.comments },
      });
    },
  };
}

function pathsForItem(item: ReviewItem): string[] {
  switch (item.kind) {
    case "patch": {
      if (!item.parsed) return [];
      const out: string[] = [];
      for (const f of item.parsed.files) {
        const p = f.to ?? f.from;
        if (p) out.push(p);
      }
      return out;
    }
    case "multi-file-diff": {
      const set = new Set<string>([
        ...Object.keys(item.before),
        ...Object.keys(item.after),
      ]);
      return [...set];
    }
    case "file":
    case "unresolved-file":
      return [item.path];
    case "file-diff":
      return [];
  }
}

function defaultCommentId(): CommentId {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return "cmt_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  }
  return "cmt_" + Math.random().toString(36).slice(2, 18);
}
