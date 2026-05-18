import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReviewProvider } from "./ReviewProvider.js";
import { CopyLinkButton } from "./CopyLinkButton.js";
import { createReviewStore } from "../store/store.js";

describe("CopyLinkButton", () => {
  it("copies a baseHref+search URL for the location", async () => {
    const store = createReviewStore();
    const write = vi.fn(() => Promise.resolve());
    const { getByRole } = render(
      <ReviewProvider store={store}>
        <CopyLinkButton
          baseHref="/review"
          writeClipboard={write}
          location={{ kind: "file", itemId: "abc", path: "src/x.ts" }}
        />
      </ReviewProvider>,
    );
    fireEvent.click(getByRole("button"));
    expect(write).toHaveBeenCalledWith("/review?item=abc&file=src%2Fx.ts");
  });

  it("omits the search when location is 'none'", async () => {
    const store = createReviewStore();
    const write = vi.fn(() => Promise.resolve());
    const { getByRole } = render(
      <ReviewProvider store={store}>
        <CopyLinkButton
          baseHref="/r"
          writeClipboard={write}
          location={{ kind: "none" }}
        />
      </ReviewProvider>,
    );
    fireEvent.click(getByRole("button"));
    expect(write).toHaveBeenCalledWith("/r");
  });
});
