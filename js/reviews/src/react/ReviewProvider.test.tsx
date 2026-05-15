import { act, render, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReviewProvider } from "./ReviewProvider.js";
import {
  useComments,
  usePatches,
  useReview,
  useReviewState,
  useSelectedFile,
} from "./hooks.js";
import { createReviewStore } from "../store/store.js";

function wrapper(store: ReturnType<typeof makeStore>) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <ReviewProvider store={store}>{children}</ReviewProvider>;
  };
}

function makeStore() {
  let id = 1;
  let t = Date.UTC(2026, 0, 1);
  return createReviewStore({
    newCommentId: () => `cmt_${id++}`,
    now: () => {
      const iso = new Date(t).toISOString();
      t += 1000;
      return iso;
    },
  });
}

describe("ReviewProvider + hooks", () => {
  it("useReview returns the same store across renders", () => {
    const store = makeStore();
    const { result, rerender } = renderHook(() => useReview(), {
      wrapper: wrapper(store),
    });
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    expect(first).toBe(store);
  });

  it("useReview throws outside of a provider", () => {
    expect(() => renderHook(() => useReview())).toThrow();
  });

  it("useReviewState re-renders when state changes", () => {
    const store = makeStore();
    const { result } = renderHook(() => useReviewState(), {
      wrapper: wrapper(store),
    });
    expect(result.current.items).toHaveLength(0);
    act(() => {
      store.addItem({
        id: "id1",
        kind: "file",
        path: "a.ts",
        content: "x",
      });
    });
    expect(result.current.items).toHaveLength(1);
  });

  it("usePatches mirrors store.getItems()", () => {
    const store = makeStore();
    store.addItem({ id: "id1", kind: "file", path: "a.ts", content: "x" });
    const { result } = renderHook(() => usePatches(), {
      wrapper: wrapper(store),
    });
    expect(result.current).toHaveLength(1);
    expect(result.current[0].id).toBe("id1");
  });

  it("useComments filters and updates on additions", () => {
    const store = makeStore();
    store.addItem({ id: "id1", kind: "file", path: "a.ts", content: "x" });
    const { result } = renderHook(
      () => useComments({ scope: "file", itemId: "id1" }),
      { wrapper: wrapper(store) },
    );
    expect(result.current).toHaveLength(0);
    act(() => {
      store.addComment({
        scope: { kind: "file", itemId: "id1", path: "a.ts" },
        body: "Q",
      });
    });
    expect(result.current).toHaveLength(1);
  });

  it("useSelectedFile resolves a valid selection", () => {
    const store = makeStore();
    store.addItem({ id: "id1", kind: "file", path: "a.ts", content: "x" });
    const { result } = renderHook(() => useSelectedFile(), {
      wrapper: wrapper(store),
    });
    expect(result.current).toBeNull();
    act(() => {
      store.selectFile("id1", "a.ts");
    });
    expect(result.current?.path).toBe("a.ts");
    expect(result.current?.item.id).toBe("id1");
  });

  it("useSelectedFile returns null for a stale selection", () => {
    const store = makeStore();
    store.addItem({ id: "id1", kind: "file", path: "a.ts", content: "x" });
    store.selectFile("does-not-exist", "a.ts");
    const { result } = renderHook(() => useSelectedFile(), {
      wrapper: wrapper(store),
    });
    expect(result.current).toBeNull();
  });

  it("renders children", () => {
    const store = makeStore();
    const { container } = render(
      <ReviewProvider store={store}>
        <div data-testid="child">hi</div>
      </ReviewProvider>,
    );
    expect(container.querySelector('[data-testid="child"]')).toBeTruthy();
  });
});
