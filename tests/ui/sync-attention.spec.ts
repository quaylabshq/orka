import { test, expect, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { syncAttentionFixture } from "./fixtures/sync-attention.js";

const reviews = (page: Page) =>
  page.getByRole("region", { name: "Reviews", exact: true });
const viewButton = (page: Page, name: "Open" | "History") =>
  reviews(page)
    .getByRole("group", { name: "Reviews view", exact: true })
    .getByRole("button", { name, exact: true });

test.beforeEach(async ({ page }) => {
  await syncAttentionFixture(page);
  await page.goto("/");
});

test("modal counts unique project resources and preserves completed activity in history", async ({
  page,
}) => {
  const status = page.locator(".workspace-header .sync-status");
  await expect(status).toHaveAttribute(
    "aria-label",
    "Needs attention, 3 notifications",
  );
  await status.click();
  const modal = page.getByRole("dialog", {
    name: "Sync status and notifications",
  });
  await expect(
    modal.getByRole("group", { name: "Writing guide", exact: true }),
  ).toHaveCount(1);
  await expect(
    modal.getByText(
      "Local skill edits preserved; resolve them before applying the shared update",
      { exact: true },
    ),
  ).toHaveCount(1);
  await expect(
    modal.getByRole("group", { name: "Writing guide", exact: true }),
  ).toContainText("Skill installation recovery pending");
  await expect(
    modal.getByRole("group", { name: "Writing guide", exact: true }),
  ).toContainText("Publication needs a fresh review");
  await expect(
    modal
      .getByRole("group", { name: "Writing guide", exact: true })
      .getByRole("button", { name: "Review local copies" }),
  ).toBeVisible();
  await expect(
    modal.getByRole("group", { name: "Release checklist", exact: true }),
  ).toContainText("409: Resource changed");
  await expect(
    modal.getByRole("button", { name: "Retry uploads" }),
  ).toHaveCount(0);
  await expect(
    modal.getByRole("button", { name: "Review conflict" }),
  ).toBeVisible();
  await expect(modal).not.toContainText("Docs access changed");
  await expect(
    modal.getByText("Project setup notes", { exact: true }),
  ).not.toBeVisible();
  await modal.locator("summary").filter({ hasText: "History (" }).click();
  await expect(
    modal.getByRole("listitem").filter({ hasText: "Project setup notes" }),
  ).toContainText("approved");
  await expect(
    modal.getByRole("listitem").filter({ hasText: "Earlier writing guide" }),
  ).toContainText("superseded");
  await expect(modal.getByRole("button", { name: "View copy" })).toBeVisible();
  await expect(status).toHaveAttribute(
    "aria-label",
    "Needs attention, 3 notifications",
  );
  const accessibility = await new AxeBuilder({ page })
    .include(".sync-menu")
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await page.keyboard.press("Escape");
  await page.getByRole("combobox", { name: /Select project/ }).click();
  await page.getByRole("option", { name: "Docs", exact: true }).click();
  await expect(status).toHaveAttribute(
    "aria-label",
    "Needs attention, 2 notifications",
  );
  await status.click();
  await expect(modal).toContainText("Docs access changed");
  await expect(
    modal.getByRole("group", { name: "Writing guide in Product", exact: true }),
  ).toBeVisible();
  await expect(modal).not.toContainText("Release checklist");
});

// History lists decided requests only. The read-only preview of a saved local
// change that this test also covered was removed with the Reviews tab.
test("request history opens decided requests read-only and exposes no decision controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 640 });
  await page.locator(".workspace-header .sync-status").click();
  const modal = page.getByRole("dialog", {
    name: "Sync status and notifications",
  });
  await modal
    .locator("summary")
    .filter({ hasText: "History (" })
    .press("Enter");
  const openHistory = modal.getByRole("button", {
    name: "Open request history",
  });
  await expect(openHistory).toHaveCSS("border-top-width", "1px");
  await expect(openHistory).toHaveCSS("height", "32px");
  await openHistory.press("Enter");
  await expect(viewButton(page, "History")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const history = reviews(page).getByRole("region", {
    name: "Requests",
    exact: true,
  });
  await expect(history.locator("tbody tr")).toHaveCount(1);
  await expect(
    history.getByRole("row", { name: /Project setup notes/ }),
  ).toContainText("Approved");
  await expect(reviews(page)).not.toContainText("Earlier writing guide");
  await history
    .getByRole("button", { name: "Project setup notes", exact: true })
    .click();
  const request = page.getByRole("region", {
    name: "Review details",
    exact: true,
  });
  await expect(
    request.getByRole("heading", { name: "Project setup notes", exact: true }),
  ).toBeVisible();
  // The status sits in the details panel, or on the details line when narrow.
  await expect(request).toContainText("Approved");
  await expect(
    request.getByRole("button", { name: "Approve", exact: true }),
  ).toHaveCount(0);
  await expect(
    request.getByRole("button", { name: "Reject", exact: true }),
  ).toHaveCount(0);
  const mutations = await page.evaluate(() =>
    window.attentionFixture.calls.filter(
      (call) =>
        call.name === "governance_command" &&
        ["submit-draft", "refresh-draft", "decide", "dismiss"].includes(
          String(call.args?.action),
        ),
    ),
  );
  expect(mutations).toEqual([]);
});

// Opening History from the sync menu also moves the keyboard there.
test("opening request history moves focus to the History view", async ({
  page,
}) => {
  await page.locator(".workspace-header .sync-status").click();
  const modal = page.getByRole("dialog", {
    name: "Sync status and notifications",
  });
  await modal
    .locator("summary")
    .filter({ hasText: "History (" })
    .press("Enter");
  await modal
    .getByRole("button", { name: "Open request history", exact: true })
    .press("Enter");
  await expect(viewButton(page, "History")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(viewButton(page, "History")).toBeFocused();
});

test("history navigation respects a Settings draft and does not replay after opening Settings again", async ({
  page,
}) => {
  const settings = page.getByRole("region", { name: "Settings", exact: true });
  const openSettings = page.getByRole("button", {
    name: "Settings",
    exact: true,
  });
  const sync = page.locator(".workspace-header .sync-status");
  await openSettings.click();
  await settings
    .getByRole("button", { name: "Sync & startup", exact: true })
    .click();
  const interval = settings.getByRole("button", { name: "5 min", exact: true });
  await interval.click();

  const openHistory = async () => {
    await sync.press("Enter");
    const popover = page.getByRole("dialog", {
      name: "Sync status and notifications",
    });
    await popover
      .locator("summary")
      .filter({ hasText: "History (" })
      .press("Enter");
    await popover
      .getByRole("button", { name: "Open request history", exact: true })
      .press("Enter");
  };
  const guard = page.getByRole("dialog", { name: "Save your changes?" });
  await openHistory();
  await guard.getByRole("button", { name: "Stay", exact: true }).press("Enter");
  await expect(interval).toHaveAttribute("aria-pressed", "true");
  await expect(sync).toBeFocused();

  await openHistory();
  await guard
    .getByRole("button", { name: "Discard", exact: true })
    .press("Enter");
  const history = viewButton(page, "History");
  await expect(history).toHaveAttribute("aria-pressed", "true");
  await viewButton(page, "Open").press("Enter");
  await expect(history).toHaveAttribute("aria-pressed", "false");

  await openSettings.click();
  await page.keyboard.press("Escape");
  await expect(reviews(page)).toBeVisible();
  await expect(history).toHaveAttribute("aria-pressed", "false");
});
