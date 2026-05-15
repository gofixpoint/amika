import { fireEvent, render, type RenderResult } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReviewProvider } from "./ReviewProvider.js";
import { ItemCommentPanel } from "./ItemCommentPanel.js";
import { SeriesCommentPanel } from "./SeriesCommentPanel.js";
import { createReviewStore } from "../store/store.js";

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

function renderWithStore(
  store: ReturnType<typeof makeStore>,
  ui: React.ReactNode,
): RenderResult {
  return render(<ReviewProvider store={store}>{ui}</ReviewProvider>);
}

describe("ItemCommentPanel", () => {
  it("adds an item-scope comment via the composer", () => {
    const store = makeStore();
    store.addItem({ id: "id1", kind: "file", path: "a.ts", content: "x" });
    const { getByRole } = renderWithStore(
      store,
      <ItemCommentPanel itemId="id1" author="alice" />,
    );
    fireEvent.click(getByRole("button", { name: /add patch comment/i }));
    fireEvent.change(getByRole("textbox"), {
      target: { value: "review this" },
    });
    fireEvent.click(getByRole("button", { name: /add patch comment/i }));
    const comments = store.getComments({ scope: "item", itemId: "id1" });
    expect(comments).toHaveLength(1);
    expect(comments[0].author).toBe("alice");
  });

  it("scopes comments to the right item", () => {
    const store = makeStore();
    store.addItem({ id: "a", kind: "file", path: "a.ts", content: "x" });
    store.addItem({ id: "b", kind: "file", path: "b.ts", content: "y" });
    store.addComment({ scope: { kind: "item", itemId: "a" }, body: "for a" });
    const { queryByText, getByText } = renderWithStore(
      store,
      <>
        <ItemCommentPanel itemId="a" />
        <div data-testid="separator" />
        <ItemCommentPanel itemId="b" />
      </>,
    );
    expect(getByText("for a")).toBeInTheDocument();
    expect(queryByText("for b")).toBeNull();
  });
});

describe("SeriesCommentPanel", () => {
  it("adds a series-scope comment via the composer", () => {
    const store = makeStore();
    const { getByRole } = renderWithStore(store, <SeriesCommentPanel />);
    fireEvent.click(getByRole("button", { name: /add review comment/i }));
    fireEvent.change(getByRole("textbox"), {
      target: { value: "looks good overall" },
    });
    fireEvent.click(getByRole("button", { name: /add review comment/i }));
    expect(store.getComments({ scope: "series" })).toHaveLength(1);
  });

  it("renders an empty-state when no comments exist", () => {
    const store = makeStore();
    const { getByText } = renderWithStore(store, <SeriesCommentPanel />);
    expect(getByText(/no review-level comments yet/i)).toBeInTheDocument();
  });
});
