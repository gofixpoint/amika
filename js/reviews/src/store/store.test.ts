import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createReviewStore } from "./store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  readFileSync(join(HERE, "..", "test", "fixtures", name), "utf8");

interface TestStoreOpts {
  initialIds?: number;
  initialTime?: number;
}

function makeStore(opts: TestStoreOpts = {}) {
  let id = opts.initialIds ?? 1;
  let t = opts.initialTime ?? Date.UTC(2026, 0, 1);
  return createReviewStore({
    newCommentId: () => `cmt_${id++}`,
    now: () => {
      const iso = new Date(t).toISOString();
      t += 1000;
      return iso;
    },
  });
}

describe("createReviewStore — loading", () => {
  it("loadFromText parses a patch and exposes items", () => {
    const store = makeStore();
    const items = store.loadFromText(fixture("single-file.patch"));
    expect(items).toHaveLength(1);
    expect(store.getItems()).toEqual(items);
  });

  it("listFiles enumerates paths across items", () => {
    const store = makeStore();
    store.loadFromText([
      fixture("single-file.patch"),
      fixture("multi-file.patch"),
    ]);
    const files = store.listFiles();
    expect(files.length).toBeGreaterThanOrEqual(4);
    const paths = files.map((f) => f.path).sort();
    expect(paths).toContain("src/hello.ts");
    expect(paths).toContain("src/a.ts");
    expect(paths).toContain("src/b.ts");
    expect(paths).toContain("src/c.ts");
  });

  it("listFiles filters by itemId", () => {
    const store = makeStore();
    const [a, b] = store.loadFromText([
      fixture("single-file.patch"),
      fixture("multi-file.patch"),
    ]);
    expect(store.listFiles(a.id)).toHaveLength(1);
    expect(store.listFiles(b.id).length).toBeGreaterThan(1);
  });
});

describe("createReviewStore — comments", () => {
  it("addComment creates a top-level comment with author + timestamps", () => {
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
      body: "why?",
      author: "alice",
    });
    expect(c.id).toBe("cmt_1");
    expect(c.parentId).toBeNull();
    expect(c.author).toBe("alice");
    expect(c.createdAt).toBe(c.updatedAt);
    expect(store.getComment(c.id)).toEqual(c);
  });

  it("reply creates a comment with inherited scope and parentId", () => {
    const store = makeStore();
    const [item] = store.loadFromText(fixture("single-file.patch"));
    const root = store.addComment({
      scope: { kind: "file", itemId: item.id, path: "src/hello.ts" },
      body: "root",
    });
    const reply = store.reply(root.id, "reply");
    expect(reply.parentId).toBe(root.id);
    expect(reply.scope).toEqual(root.scope);
  });

  it("getComments filters by scope kind, itemId, path, and line", () => {
    const store = makeStore();
    const [item] = store.loadFromText(fixture("single-file.patch"));
    store.addComment({ scope: { kind: "series" }, body: "series" });
    store.addComment({
      scope: { kind: "item", itemId: item.id },
      body: "item",
    });
    store.addComment({
      scope: { kind: "file", itemId: item.id, path: "src/hello.ts" },
      body: "file",
    });
    store.addComment({
      scope: { kind: "line", itemId: item.id, path: "src/hello.ts", line: 2 },
      body: "line",
    });

    expect(store.getComments({ scope: "series" })).toHaveLength(1);
    expect(store.getComments({ itemId: item.id })).toHaveLength(3);
    expect(store.getComments({ path: "src/hello.ts" })).toHaveLength(2);
    expect(store.getComments({ line: 2 })).toHaveLength(1);
  });

  it("editComment updates body and bumps updatedAt", () => {
    const store = makeStore();
    const c = store.addComment({ scope: { kind: "series" }, body: "v1" });
    const updated = store.editComment(c.id, "v2");
    expect(updated?.body).toBe("v2");
    expect(updated?.updatedAt).not.toBe(c.updatedAt);
  });

  it("deleteComment removes the comment and all descendants", () => {
    const store = makeStore();
    const root = store.addComment({ scope: { kind: "series" }, body: "root" });
    const child = store.reply(root.id, "child");
    store.reply(child.id, "grand");
    const other = store.addComment({
      scope: { kind: "series" },
      body: "other",
    });
    store.deleteComment(root.id);
    expect(store.getComments().map((c) => c.id)).toEqual([other.id]);
  });

  it("setResolved toggles resolved flag", () => {
    const store = makeStore();
    const c = store.addComment({ scope: { kind: "series" }, body: "x" });
    expect(store.setResolved(c.id, true)?.resolved).toBe(true);
    expect(store.setResolved(c.id, false)?.resolved).toBe(false);
  });

  it("reply throws on unknown parent", () => {
    const store = makeStore();
    expect(() => store.reply("ghost", "hi")).toThrow();
  });

  it("getThread returns root + descendants in createdAt order", () => {
    const store = makeStore();
    const root = store.addComment({ scope: { kind: "series" }, body: "root" });
    const a = store.reply(root.id, "a");
    const b = store.reply(root.id, "b");
    const aa = store.reply(a.id, "aa");
    expect(store.getThread(root.id).map((c) => c.id)).toEqual([
      root.id,
      a.id,
      b.id,
      aa.id,
    ]);
  });
});

describe("createReviewStore — export/import + persistence", () => {
  it("export → import round-trips state", () => {
    const a = makeStore();
    a.loadFromText(fixture("single-file.patch"));
    const [item] = a.getItems();
    a.addComment({
      scope: { kind: "line", itemId: item.id, path: "src/hello.ts", line: 2 },
      body: "Q",
    });
    const snapshot = a.export();

    const b = makeStore({ initialIds: 999 });
    b.import(snapshot);
    expect(b.getItems()).toEqual(a.getItems());
    expect(b.getComments()).toEqual(a.getComments());
  });

  it("subscribe fires on every state change", () => {
    const store = makeStore();
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls++;
    });
    store.loadFromText(fixture("single-file.patch"));
    store.addComment({ scope: { kind: "series" }, body: "x" });
    expect(calls).toBe(2);
    unsubscribe();
    store.reset();
    expect(calls).toBe(2);
  });

  it("custom persistence adapter is read on init and written on changes", () => {
    let saved: unknown = null;
    const fakeAdapter = {
      load: () => null,
      save: (s: unknown) => {
        saved = s;
      },
      subscribeRemote: () => () => {},
    };
    const store = createReviewStore({
      now: () => "2026-01-01T00:00:00.000Z",
      newCommentId: () => "cmt_x",
      persistence: fakeAdapter,
    });
    store.addComment({ scope: { kind: "series" }, body: "hi" });
    expect(saved).not.toBeNull();
  });
});
