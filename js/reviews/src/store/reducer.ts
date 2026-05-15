import type { Action, Comment, ReviewState } from "./types.js";

export const initialState: ReviewState = {
  items: [],
  comments: {},
  selection: { itemId: null, path: null },
};

export function reducer(state: ReviewState, action: Action): ReviewState {
  switch (action.type) {
    case "LOAD_ITEMS":
      return {
        ...state,
        items: action.items,
        selection: { itemId: null, path: null },
      };

    case "ADD_ITEM":
      return { ...state, items: [...state.items, action.item] };

    case "RESET":
      return initialState;

    case "SELECT_FILE":
      return {
        ...state,
        selection: { itemId: action.itemId, path: action.path },
      };

    case "ADD_COMMENT": {
      if (
        action.comment.parentId !== null &&
        !state.comments[action.comment.parentId]
      ) {
        return state;
      }
      return {
        ...state,
        comments: { ...state.comments, [action.comment.id]: action.comment },
      };
    }

    case "EDIT_COMMENT": {
      const existing = state.comments[action.id];
      if (!existing) return state;
      const next: Comment = {
        ...existing,
        body: action.body,
        updatedAt: action.updatedAt,
      };
      return { ...state, comments: { ...state.comments, [action.id]: next } };
    }

    case "DELETE_COMMENT": {
      if (!state.comments[action.id]) return state;
      const toRemove = collectDescendants(state.comments, action.id);
      const comments = { ...state.comments };
      for (const id of toRemove) delete comments[id];
      return { ...state, comments };
    }

    case "SET_RESOLVED": {
      const existing = state.comments[action.id];
      if (!existing || existing.resolved === action.resolved) return state;
      const next: Comment = {
        ...existing,
        resolved: action.resolved,
        updatedAt: action.updatedAt,
      };
      return { ...state, comments: { ...state.comments, [action.id]: next } };
    }

    case "IMPORT": {
      const comments: Record<string, Comment> = {};
      for (const c of action.payload.comments) comments[c.id] = c;
      return {
        items: action.payload.items,
        comments,
        selection: { itemId: null, path: null },
      };
    }
  }
}

function collectDescendants(
  comments: Record<string, Comment>,
  rootId: string,
): Set<string> {
  const ids = new Set<string>([rootId]);
  let added = true;
  while (added) {
    added = false;
    for (const c of Object.values(comments)) {
      if (c.parentId && ids.has(c.parentId) && !ids.has(c.id)) {
        ids.add(c.id);
        added = true;
      }
    }
  }
  return ids;
}
