import { useEffect, useState } from "react";
import {
  CodeReview,
  ReviewProvider,
  useReview,
  usePatches,
  useReviewState,
} from "@amika/reviews";
import type { ReviewItem } from "@amika/reviews";

const FIXTURES = [
  "/fixtures/simple.patch",
  "/fixtures/multi-file.patch",
  "/fixtures/rename.patch",
];

export function App() {
  const url = new URL(window.location.href);
  const persistKey = url.searchParams.get("persistKey") ?? undefined;
  const author = url.searchParams.get("author") ?? "demo-user";

  return (
    <ReviewProvider
      persistKey={persistKey}
      author={author}
      linkSync
    >
      <AppInner />
    </ReviewProvider>
  );
}

function AppInner() {
  const store = useReview();
  return (
    <>
      <Toolbar />
      <CodeReview store={store} />
    </>
  );
}

function patchLabel(item: ReviewItem): string {
  if (item.label) return item.label;
  if (item.kind === "patch") {
    const match = item.patchText.match(/^Subject: (?:\[PATCH[^\]]*\] )?(.+)$/m);
    if (match) return match[1].trim();
  }
  return item.id.slice(0, 8);
}

function PatchNavigator() {
  const store = useReview();
  const items = usePatches();
  const state = useReviewState();

  if (items.length === 0) return null;

  const currentIndex = items.findIndex(
    (i) => i.id === state.selection.itemId,
  );
  const displayIndex = currentIndex === -1 ? 0 : currentIndex;
  const current = items[displayIndex];

  function go(index: number) {
    const target = items[index];
    const files = store.listFiles(target.id);
    if (files.length > 0) {
      store.selectFile(files[0].itemId, files[0].path);
    } else {
      store.selectFile(target.id, null);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 13,
      }}
    >
      <button
        type="button"
        onClick={() => go(displayIndex - 1)}
        disabled={displayIndex === 0}
        aria-label="Previous patch"
      >
        ←
      </button>
      <span
        title={patchLabel(current)}
        style={{
          maxWidth: 260,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: "#24292f",
        }}
      >
        {patchLabel(current)}{" "}
        <span style={{ color: "#57606a" }}>
          ({displayIndex + 1}/{items.length})
        </span>
      </span>
      <button
        type="button"
        onClick={() => go(displayIndex + 1)}
        disabled={displayIndex === items.length - 1}
        aria-label="Next patch"
      >
        →
      </button>
    </div>
  );
}

function Toolbar() {
  const store = useReview();
  const [loading, setLoading] = useState(false);

  async function loadFixtures() {
    setLoading(true);
    try {
      const texts = await Promise.all(
        FIXTURES.map((u) => fetch(u).then((r) => r.text())),
      );
      store.loadFromText(texts);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Optional auto-load via ?fixtures=1 for Playwright convenience.
    const url = new URL(window.location.href);
    if (url.searchParams.get("fixtures") === "1") {
      void loadFixtures();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      style={{
        padding: 8,
        borderBottom: "1px solid #d0d7de",
        display: "flex",
        gap: 8,
        alignItems: "center",
      }}
      data-amika-example="toolbar"
    >
      <button
        type="button"
        onClick={loadFixtures}
        disabled={loading}
        data-amika-example="load-fixtures"
      >
        {loading ? "Loading…" : "Load fixture series"}
      </button>
      <button
        type="button"
        onClick={() => store.reset()}
        data-amika-example="reset"
      >
        Reset
      </button>
      <PatchNavigator />
      <span style={{ marginLeft: "auto", color: "#57606a" }}>
        @amika/reviews · example
      </span>
    </div>
  );
}
