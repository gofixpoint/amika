import { useEffect, useState } from "react";
import { CodeReview, ReviewProvider, useReview } from "@amika/reviews";

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
      <Toolbar />
      <CodeReview store={undefined} />
    </ReviewProvider>
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
      <span style={{ marginLeft: "auto", color: "#57606a" }}>
        @amika/reviews · example
      </span>
    </div>
  );
}
