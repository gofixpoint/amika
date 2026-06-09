import { expect, test } from "@playwright/test";

test.describe("@amika/reviews — basic flows", () => {
  test("loads fixture series and renders a diff", async ({ page }) => {
    await page.goto("/?fixtures=1");
    // Wait for items to be in the store (auto-loaded via ?fixtures=1).
    await expect(page.locator('[data-amika="item-count"]')).not.toHaveText("0");
    await expect(
      page.locator('[data-amika="selected-path"]'),
    ).not.toHaveText("");
  });

  test("adds a series-level comment via the sidebar", async ({ page }) => {
    await page.goto("/?fixtures=1");
    await expect(page.locator('[data-amika="item-count"]')).not.toHaveText("0");

    await page
      .locator('[data-amika="series-comment-trigger"]')
      .click();
    await page
      .locator('[data-amika="series-comment-panel"] textarea')
      .fill("looks good!");
    await page
      .locator('[data-amika="series-comment-panel"] button:has-text("Add review comment")')
      .click();

    await expect(
      page.locator('[data-amika="series-comment-panel"] [data-amika="comment-body"]'),
    ).toHaveText("looks good!");
  });

  test("adds an item-level comment", async ({ page }) => {
    await page.goto("/?fixtures=1");
    await expect(page.locator('[data-amika="item-count"]')).not.toHaveText("0");

    await page.locator('[data-amika="item-comment-trigger"]').first().click();
    await page
      .locator('[data-amika="item-comment-panel"] textarea')
      .first()
      .fill("nit on this patch");
    await page
      .locator('[data-amika="item-comment-panel"] button:has-text("Add patch comment")')
      .first()
      .click();

    await expect(
      page
        .locator('[data-amika="item-comment-panel"] [data-amika="comment-body"]')
        .first(),
    ).toHaveText("nit on this patch");
  });

  test("adds a file-level comment", async ({ page }) => {
    await page.goto("/?fixtures=1");
    await expect(page.locator('[data-amika="item-count"]')).not.toHaveText("0");

    await page.locator('[data-amika="file-comment-trigger"]').click();
    await page
      .locator('[data-amika="file-comment-panel"] textarea')
      .fill("file nit");
    await page
      .locator('[data-amika="file-comment-panel"] button:has-text("Add file comment")')
      .click();

    await expect(
      page.locator('[data-amika="file-comment-panel"] [data-amika="comment-body"]'),
    ).toHaveText("file nit");
  });

  test("replies to a comment", async ({ page }) => {
    await page.goto("/?fixtures=1");
    await page.locator('[data-amika="series-comment-trigger"]').click();
    await page
      .locator('[data-amika="series-comment-panel"] textarea')
      .fill("root comment");
    await page
      .locator('[data-amika="series-comment-panel"] button:has-text("Add review comment")')
      .click();

    await page
      .locator('[data-amika="series-comment-panel"] [data-amika="comment-thread-reply-trigger"]')
      .click();
    await page
      .locator('[data-amika="series-comment-panel"] textarea')
      .last()
      .fill("reply!");
    await page
      .locator('[data-amika="series-comment-panel"] button:has-text("Reply"):not([data-amika="comment-thread-reply-trigger"])')
      .click();

    const bodies = page.locator(
      '[data-amika="series-comment-panel"] [data-amika="comment-body"]',
    );
    await expect(bodies).toHaveCount(2);
    await expect(bodies.nth(1)).toHaveText("reply!");
  });
});

test.describe("@amika/reviews — persistence and deep linking", () => {
  test("persists comments via persistKey across reloads", async ({ page }) => {
    const key = `e2e-${Math.random().toString(36).slice(2, 10)}`;
    await page.goto(`/?fixtures=1&persistKey=${key}`);
    await page.locator('[data-amika="series-comment-trigger"]').click();
    await page
      .locator('[data-amika="series-comment-panel"] textarea')
      .fill("survives reload");
    await page
      .locator('[data-amika="series-comment-panel"] button:has-text("Add review comment")')
      .click();
    await expect(
      page.locator('[data-amika="series-comment-panel"] [data-amika="comment-body"]'),
    ).toHaveText("survives reload");

    await page.reload();
    await expect(
      page.locator('[data-amika="series-comment-panel"] [data-amika="comment-body"]'),
    ).toHaveText("survives reload");
  });

  test("deep link by item selects that item in the URL", async ({ page }) => {
    await page.goto("/?fixtures=1");
    await expect(page.locator('[data-amika="item-count"]')).not.toHaveText("0");
    const itemId = await page
      .locator('[data-amika="selected-item"]')
      .textContent();
    expect(itemId).toBeTruthy();

    // URL should already reflect the selected item thanks to linkSync.
    expect(page.url()).toContain(`item=${itemId}`);
  });

  test("deep link by file navigates and selects the file", async ({ page }) => {
    await page.goto("/?fixtures=1");
    await expect(page.locator('[data-amika="item-count"]')).not.toHaveText("0");
    const itemId = await page
      .locator('[data-amika="selected-item"]')
      .textContent();

    await page.goto(`/?fixtures=1&item=${itemId}&file=src/hello.ts`);
    await expect(page.locator('[data-amika="selected-path"]')).toHaveText(
      "src/hello.ts",
    );
  });
});

test.describe("@amika/reviews — export", () => {
  test("exports a ReviewExportV1 JSON download with comments", async ({
    page,
  }) => {
    await page.goto("/?fixtures=1");
    await page.locator('[data-amika="series-comment-trigger"]').click();
    await page
      .locator('[data-amika="series-comment-panel"] textarea')
      .fill("export me");
    await page
      .locator('[data-amika="series-comment-panel"] button:has-text("Add review comment")')
      .click();

    const downloadPromise = page.waitForEvent("download");
    await page.locator('[data-amika="export-button"]').click();
    const download = await downloadPromise;
    const path = await download.path();
    expect(path).toBeTruthy();

    const fs = await import("node:fs");
    const json = JSON.parse(fs.readFileSync(path!, "utf8"));
    expect(json.schemaVersion).toBe(1);
    expect(Array.isArray(json.items)).toBe(true);
    expect(json.items.length).toBeGreaterThan(0);
    const bodies = (json.comments as { body: string }[]).map((c) => c.body);
    expect(bodies).toContain("export me");
  });
});
