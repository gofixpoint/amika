import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// jsdom doesn't implement CSSStyleSheet.replaceSync used by @pierre/diffs.
// Stub the components to null returns for these layout tests; the pierre
// internals are covered by Playwright.
vi.mock("@pierre/diffs/react", () => ({
  PatchDiff: () => null,
  MultiFileDiff: () => null,
  FileDiff: () => null,
  File: () => null,
  UnresolvedFile: () => null,
}));

import { CodeReview } from "./CodeReview.js";
import { ExportButton } from "./ExportButton.js";
import { UploadDropzone } from "./UploadDropzone.js";
import { ReviewProvider } from "./ReviewProvider.js";
import { createReviewStore } from "../store/store.js";
import { isReviewExportV1 } from "../store/export.js";

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

describe("UploadDropzone", () => {
  it("parses dropped files into items", async () => {
    const store = makeStore();
    const content = fixture("single-file.patch");
    const file = new File([content], "x.patch", { type: "text/plain" });
    // jsdom doesn't implement File.text(); patch on for this test.
    Object.defineProperty(file, "text", {
      value: () => Promise.resolve(content),
    });
    const onLoaded = vi.fn();
    const { getByText } = render(
      <ReviewProvider store={store}>
        <UploadDropzone onLoaded={onLoaded}>
          <span>drop here</span>
        </UploadDropzone>
      </ReviewProvider>,
    );
    fireEvent.drop(getByText("drop here").parentElement!, {
      dataTransfer: { files: [file] },
    });
    // wait a microtask for the async loadFromFiles
    await new Promise((r) => setTimeout(r, 10));
    expect(store.getItems()).toHaveLength(1);
    expect(onLoaded).toHaveBeenCalledWith(1);
  });
});

describe("ExportButton", () => {
  it("hands a valid ReviewExportV1 to onExport", () => {
    const store = makeStore();
    store.loadFromText(fixture("single-file.patch"));
    store.addComment({ scope: { kind: "series" }, body: "lgtm" });
    let captured = "";
    const { getByRole } = render(
      <ReviewProvider store={store}>
        <ExportButton onExport={(json) => (captured = json)} />
      </ReviewProvider>,
    );
    fireEvent.click(getByRole("button"));
    const parsed = JSON.parse(captured);
    expect(isReviewExportV1(parsed)).toBe(true);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.comments).toHaveLength(1);
  });
});

describe("CodeReview", () => {
  it("renders an empty state when no items are loaded", () => {
    const store = makeStore();
    const { getByText } = render(<CodeReview store={store} />);
    expect(getByText(/drop one or more/i)).toBeInTheDocument();
  });

  it("auto-selects the first file once items are loaded", () => {
    const store = makeStore();
    store.loadFromText(fixture("single-file.patch"));
    const { container } = render(<CodeReview store={store} />);
    const sel = container.querySelector('[data-amika="selected-path"]');
    expect(sel?.textContent).toBe("src/hello.ts");
  });
});
