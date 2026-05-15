import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReviewProvider } from "./ReviewProvider.js";
import { FileTreePanel } from "./FileTreePanel.js";
import { createReviewStore } from "../store/store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  readFileSync(join(HERE, "..", "test", "fixtures", name), "utf8");

describe("FileTreePanel", () => {
  it("mounts without errors when items are loaded", () => {
    const store = createReviewStore();
    store.loadFromText([
      fixture("single-file.patch"),
      fixture("multi-file.patch"),
    ]);
    const { container } = render(
      <ReviewProvider store={store}>
        <FileTreePanel className="tree" />
      </ReviewProvider>,
    );
    // pierre renders into a shadow root, so we only assert host presence.
    expect(container.querySelector(".tree")).toBeTruthy();
  });

  it("mounts without errors when no items are loaded", () => {
    const store = createReviewStore();
    const { container } = render(
      <ReviewProvider store={store}>
        <FileTreePanel className="empty" />
      </ReviewProvider>,
    );
    expect(container.querySelector(".empty")).toBeTruthy();
  });
});
