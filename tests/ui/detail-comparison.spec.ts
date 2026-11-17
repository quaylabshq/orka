import { test, expect } from "@playwright/test";
import { detailGalleryFixture } from "./fixtures/detail-gallery.js";

for (const kind of ["memory", "plan"] as const)
  for (const viewport of [
    { width: 1160, height: 800 },
    { width: 900, height: 640 },
  ])
    test(`${kind} keeps cached comparisons on older WebViews at ${viewport.width}px`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      const rendererRequests: string[] = [];
      page.on("request", (request) => {
        if (request.url().includes("/src/components/pierre-diff.tsx"))
          rendererRequests.push(request.url());
      });
      // Match an older supported WebView without importing the modern renderer.
      await page.addInitScript(() => {
        const supports = CSS.supports.bind(CSS);
        CSS.supports = ((...args: string[]) =>
          args.some((argument) => argument.includes("light-dark("))
            ? false
            : Reflect.apply(supports, CSS, args)) as typeof CSS.supports;
      });
      const view = await detailGalleryFixture(page, {
        kind,
        disconnected: true,
        offline: true,
      });
      await expect(
        view.getByRole("button", { name: "Open in editor", exact: true }),
      ).toBeDisabled();
      await view
        .getByRole("button", { name: "View changes", exact: true })
        .click();
      const comparison = view.getByRole("group", { name: "File changes" });
      await expect(comparison.locator(".deletion")).toContainText(
        kind === "memory" ? "960px" : "- [ ] Move sessions",
      );
      await expect(comparison.locator(".addition")).toContainText(
        kind === "memory" ? "870px" : "- [x] Move sessions",
      );
      await expect(comparison.locator("diffs-container")).toHaveCount(0);
      expect(rendererRequests).toEqual([]);
      await view
        .getByRole("button", { name: "Show content", exact: true })
        .click();
      await expect(
        view.getByRole("article", { name: "Rendered Markdown" }),
      ).toBeVisible();
    });
