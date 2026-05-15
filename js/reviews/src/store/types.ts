import type { CommentId, ReviewItem, ReviewItemId, Side } from "../types.js";

export type CommentScope =
  | {
      kind: "line";
      itemId: ReviewItemId;
      path: string;
      line: number;
      side?: Side;
    }
  | { kind: "file"; itemId: ReviewItemId; path: string }
  | { kind: "item"; itemId: ReviewItemId }
  | { kind: "series" };

export type CommentScopeKind = CommentScope["kind"];

export interface Comment {
  id: CommentId;
  parentId: CommentId | null;
  scope: CommentScope;
  body: string;
  author?: string;
  createdAt: string;
  updatedAt: string;
  resolved: boolean;
}

export interface ReviewState {
  items: ReviewItem[];
  comments: Record<CommentId, Comment>;
  selection: { itemId: ReviewItemId | null; path: string | null };
}

export interface CommentFilter {
  scope?: CommentScopeKind;
  itemId?: ReviewItemId;
  path?: string;
  line?: number;
}

/**
 * Reducer action payloads. All IDs and timestamps are supplied by the caller
 * (createReviewStore) so the reducer itself stays pure and deterministic.
 */
export type Action =
  | { type: "LOAD_ITEMS"; items: ReviewItem[] }
  | { type: "ADD_ITEM"; item: ReviewItem }
  | { type: "RESET" }
  | {
      type: "SELECT_FILE";
      itemId: ReviewItemId | null;
      path: string | null;
    }
  | { type: "ADD_COMMENT"; comment: Comment }
  | {
      type: "EDIT_COMMENT";
      id: CommentId;
      body: string;
      updatedAt: string;
    }
  | { type: "DELETE_COMMENT"; id: CommentId }
  | {
      type: "SET_RESOLVED";
      id: CommentId;
      resolved: boolean;
      updatedAt: string;
    }
  | {
      type: "IMPORT";
      payload: { items: ReviewItem[]; comments: Comment[] };
    };
