import { fireEvent, render, type RenderResult } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReviewProvider } from "./ReviewProvider.js";
import { CommentThread } from "./CommentThread.js";
import { FileCommentPanel } from "./FileCommentPanel.js";
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

describe("CommentThread", () => {
  it("renders the root and supports a reply", () => {
    const store = makeStore();
    const root = store.addComment({ scope: { kind: "series" }, body: "root" });
    const { getByRole, getByText } = renderWithStore(
      store,
      <CommentThread rootId={root.id} author="alice" />,
    );
    expect(getByText("root")).toBeInTheDocument();

    fireEvent.click(getByRole("button", { name: /^reply$/i }));
    fireEvent.change(getByRole("textbox"), { target: { value: "reply!" } });
    fireEvent.click(getByRole("button", { name: /^reply$/i }));
    expect(store.getComments()).toHaveLength(2);
    const reply = store.getComments().find((c) => c.parentId === root.id);
    expect(reply?.body).toBe("reply!");
    expect(reply?.author).toBe("alice");
  });

  it("supports editing and deleting a comment", () => {
    const store = makeStore();
    const c = store.addComment({ scope: { kind: "series" }, body: "v1" });
    const { getAllByRole, getByRole, getByText } = renderWithStore(
      store,
      <CommentThread rootId={c.id} />,
    );
    fireEvent.click(getByRole("button", { name: /^edit$/i }));
    fireEvent.change(getByRole("textbox"), { target: { value: "v2" } });
    fireEvent.click(getByRole("button", { name: /^save$/i }));
    expect(getByText("v2")).toBeInTheDocument();

    fireEvent.click(getAllByRole("button", { name: /^delete$/i })[0]);
    expect(store.getComments()).toHaveLength(0);
  });

  it("toggles resolved on the root only", () => {
    const store = makeStore();
    const c = store.addComment({ scope: { kind: "series" }, body: "x" });
    const { getByRole } = renderWithStore(
      store,
      <CommentThread rootId={c.id} />,
    );
    fireEvent.click(getByRole("button", { name: /^resolve$/i }));
    expect(store.getComment(c.id)?.resolved).toBe(true);
    fireEvent.click(getByRole("button", { name: /^reopen$/i }));
    expect(store.getComment(c.id)?.resolved).toBe(false);
  });
});

describe("FileCommentPanel", () => {
  it("adds a file-scope comment via the composer", () => {
    const store = makeStore();
    store.addItem({
      id: "id1",
      kind: "file",
      path: "a.ts",
      content: "x",
    });
    const { getByRole } = renderWithStore(
      store,
      <FileCommentPanel itemId="id1" path="a.ts" author="bob" />,
    );
    fireEvent.click(getByRole("button", { name: /add file comment/i }));
    fireEvent.change(getByRole("textbox"), { target: { value: "needs work" } });
    fireEvent.click(getByRole("button", { name: /add file comment/i }));
    const comments = store.getComments({ scope: "file", itemId: "id1" });
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toBe("needs work");
    expect(comments[0].author).toBe("bob");
  });
});
