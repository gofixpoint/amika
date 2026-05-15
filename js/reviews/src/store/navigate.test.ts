import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createReviewStore, type ScrollTarget } from "./store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  readFileSync(join(HERE, "..", "test", "fixtures", name), "utf8");

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

describe("store.navigate", () => {
  it("selects item, file, and emits scroll request for line targets", () => {
    const store = makeStore();
    const [item] = store.loadFromText(fixture("single-file.patch"));
    const scrolls: ScrollTarget[] = [];
    store.onScrollRequest((t) => scrolls.push(t));

    store.navigate({ kind: "item", itemId: item.id });
    expect(store.getSelection()).toEqual({ itemId: item.id, path: null });

    store.navigate({ kind: "file", itemId: item.id, path: "src/hello.ts" });
    expect(store.getSelection()).toEqual({
      itemId: item.id,
      path: "src/hello.ts",
    });

    store.navigate({
      kind: "line",
      itemId: item.id,
      path: "src/hello.ts",
      line: 2,
      side: "new",
    });
    expect(scrolls).toEqual([
      {
        itemId: item.id,
        path: "src/hello.ts",
        line: 2,
        side: "new",
      },
    ]);
  });

  it("navigates to a comment by resolving its scope and scrolling", () => {
    const store = makeStore();
    const [item] = store.loadFromText(fixture("single-file.patch"));
    const c = store.addComment({
      scope: {
        kind: "line",
        itemId: item.id,
        path: "src/hello.ts",
        line: 2,
        side: "new",
      },
      body: "?",
    });
    const scrolls: ScrollTarget[] = [];
    store.onScrollRequest((t) => scrolls.push(t));

    store.navigate({ kind: "comment", commentId: c.id });
    expect(store.getSelection().path).toBe("src/hello.ts");
    expect(scrolls[0]?.line).toBe(2);
    expect(scrolls[0]?.commentId).toBe(c.id);
  });

  it("is a no-op for unknown items or comments", () => {
    const store = makeStore();
    const before = store.getSelection();
    store.navigate({ kind: "item", itemId: "ghost" });
    expect(store.getSelection()).toEqual(before);
    store.navigate({ kind: "comment", commentId: "missing" });
    expect(store.getSelection()).toEqual(before);
  });

  it("locationToSearch / locationFromSearch round-trip via the store", () => {
    const store = makeStore();
    const search = store.locationToSearch({
      kind: "line",
      itemId: "x",
      path: "a.ts",
      line: 5,
    });
    expect(store.locationFromSearch(search)).toEqual({
      kind: "line",
      itemId: "x",
      path: "a.ts",
      line: 5,
    });
  });

  it("getLocation reflects the selection", () => {
    const store = makeStore();
    const [item] = store.loadFromText(fixture("single-file.patch"));
    expect(store.getLocation()).toEqual({ kind: "none" });
    store.selectFile(item.id, null);
    expect(store.getLocation()).toEqual({ kind: "item", itemId: item.id });
    store.selectFile(item.id, "src/hello.ts");
    expect(store.getLocation()).toEqual({
      kind: "file",
      itemId: item.id,
      path: "src/hello.ts",
    });
  });

  it("onScrollRequest returns an unsubscribe", () => {
    const store = makeStore();
    const [item] = store.loadFromText(fixture("single-file.patch"));
    const listener = vi.fn();
    const unsub = store.onScrollRequest(listener);
    store.navigate({
      kind: "line",
      itemId: item.id,
      path: "src/hello.ts",
      line: 1,
    });
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    store.navigate({
      kind: "line",
      itemId: item.id,
      path: "src/hello.ts",
      line: 2,
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
