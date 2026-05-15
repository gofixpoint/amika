import { describe, expect, it } from "vitest";
import { initialState, reducer } from "./reducer.js";
import type { Comment, ReviewState } from "./types.js";

function makeComment(over: Partial<Comment> = {}): Comment {
  return {
    id: "c1",
    parentId: null,
    scope: { kind: "series" },
    body: "hello",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    resolved: false,
    ...over,
  };
}

function withComments(...cs: Comment[]): ReviewState {
  const comments: Record<string, Comment> = {};
  for (const c of cs) comments[c.id] = c;
  return { ...initialState, comments };
}

describe("reducer", () => {
  it("LOAD_ITEMS replaces items and clears selection", () => {
    const state: ReviewState = {
      ...initialState,
      selection: { itemId: "a", path: "x.ts" },
    };
    const next = reducer(state, {
      type: "LOAD_ITEMS",
      items: [{ id: "id1", kind: "file", path: "x.ts", content: "x" }],
    });
    expect(next.items).toHaveLength(1);
    expect(next.selection).toEqual({ itemId: null, path: null });
  });

  it("ADD_ITEM appends without clearing selection", () => {
    const state: ReviewState = {
      ...initialState,
      items: [{ id: "id1", kind: "file", path: "a.ts", content: "x" }],
      selection: { itemId: "id1", path: "a.ts" },
    };
    const next = reducer(state, {
      type: "ADD_ITEM",
      item: { id: "id2", kind: "file", path: "b.ts", content: "y" },
    });
    expect(next.items).toHaveLength(2);
    expect(next.selection.itemId).toBe("id1");
  });

  it("ADD_COMMENT inserts top-level comments", () => {
    const c = makeComment();
    const next = reducer(initialState, { type: "ADD_COMMENT", comment: c });
    expect(next.comments[c.id]).toEqual(c);
  });

  it("ADD_COMMENT rejects replies whose parent does not exist", () => {
    const reply = makeComment({ id: "c2", parentId: "ghost" });
    const next = reducer(initialState, {
      type: "ADD_COMMENT",
      comment: reply,
    });
    expect(next).toBe(initialState);
  });

  it("EDIT_COMMENT updates body and updatedAt", () => {
    const c = makeComment();
    const state = withComments(c);
    const next = reducer(state, {
      type: "EDIT_COMMENT",
      id: c.id,
      body: "new",
      updatedAt: "2026-02-01T00:00:00.000Z",
    });
    expect(next.comments[c.id].body).toBe("new");
    expect(next.comments[c.id].updatedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(next.comments[c.id].createdAt).toBe(c.createdAt);
  });

  it("EDIT_COMMENT is a no-op for unknown ids", () => {
    const next = reducer(initialState, {
      type: "EDIT_COMMENT",
      id: "ghost",
      body: "x",
      updatedAt: "x",
    });
    expect(next).toBe(initialState);
  });

  it("DELETE_COMMENT removes the comment and all descendants", () => {
    const root = makeComment({ id: "root" });
    const child = makeComment({ id: "child", parentId: "root" });
    const grand = makeComment({ id: "grand", parentId: "child" });
    const unrelated = makeComment({ id: "other" });
    const state = withComments(root, child, grand, unrelated);
    const next = reducer(state, { type: "DELETE_COMMENT", id: "root" });
    expect(Object.keys(next.comments)).toEqual(["other"]);
  });

  it("SET_RESOLVED toggles and is idempotent", () => {
    const c = makeComment({ resolved: false });
    const state = withComments(c);
    const resolved = reducer(state, {
      type: "SET_RESOLVED",
      id: c.id,
      resolved: true,
      updatedAt: "2026-02-01T00:00:00.000Z",
    });
    expect(resolved.comments[c.id].resolved).toBe(true);

    const noop = reducer(resolved, {
      type: "SET_RESOLVED",
      id: c.id,
      resolved: true,
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    expect(noop).toBe(resolved);
  });

  it("RESET returns the initial state", () => {
    const state: ReviewState = {
      items: [{ id: "id1", kind: "file", path: "a.ts", content: "x" }],
      comments: { c1: makeComment() },
      selection: { itemId: "id1", path: "a.ts" },
    };
    const next = reducer(state, { type: "RESET" });
    expect(next).toEqual(initialState);
  });

  it("IMPORT replaces items + comments and clears selection", () => {
    const state: ReviewState = {
      ...initialState,
      selection: { itemId: "x", path: "y" },
    };
    const next = reducer(state, {
      type: "IMPORT",
      payload: {
        items: [{ id: "id1", kind: "file", path: "z.ts", content: "z" }],
        comments: [makeComment({ id: "c1" }), makeComment({ id: "c2" })],
      },
    });
    expect(next.items).toHaveLength(1);
    expect(Object.keys(next.comments).sort()).toEqual(["c1", "c2"]);
    expect(next.selection).toEqual({ itemId: null, path: null });
  });
});
