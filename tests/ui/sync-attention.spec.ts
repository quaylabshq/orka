import { test, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { syncAttentionFixture } from "./fixtures/sync-attention.js";

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
    modal.getByText("Local edits are preserved on this Mac.", { exact: true }),
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
      .getByRole("button", { name: "Review copies" }),
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

test("saved history previews keep the original bytes and expose no publication controls", async ({
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
  await expect(openHistory).toHaveCSS("background-color", "rgb(28, 28, 28)");
  await expect(openHistory).toHaveCSS("height", "32px");
  await openHistory.press("Enter");
  const management = page.getByRole("region", { name: "Manage", exact: true });
  const history = management.getByRole("region", { name: "Request history" });
  await expect(history.locator("details")).toHaveAttribute("open", "");
  await expect(history.locator("summary")).toBeFocused();
  await management
    .getByRole("button", { name: "View saved change", exact: true })
    .click();
  const saved = page.getByRole("dialog", { name: "Saved change", exact: true });
  await expect(saved).toContainText("Preserved older instructions");
  for (const name of [
    "Publish update",
    "Send for approval",
    "Review latest and retry",
  ])
    await expect(saved.getByRole("button", { name, exact: true })).toHaveCount(
      0,
    );
  await saved.getByRole("button", { name: "Close", exact: true }).click();
  await management
    .getByRole("button", { name: "View request", exact: true })
    .filter({ hasText: "View request" })
    .last()
    .click();
  const request = page.getByRole("dialog", {
    name: "Request history",
    exact: true,
  });
  await expect(
    request.getByRole("button", { name: "Approve request", exact: true }),
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

test("review and attention actions retain their alignment and resting fill at the compact size", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 640 });
  const status = page.locator(".workspace-header .sync-status");
  const modal = page.getByRole("dialog", {
    name: "Sync status and notifications",
  });
  await status.click();
  const selected = modal.getByRole("group", {
    name: "Writing guide",
    exact: true,
  });
  const review = selected.getByRole("button", {
    name: "Review copies",
    exact: true,
  });
  const conflict = modal.getByRole("button", {
    name: "Review conflict",
    exact: true,
  });
  const sync = modal.getByRole("button", { name: "Sync now", exact: true });
  await expect(modal).toHaveCSS("background-color", "rgb(18, 18, 18)");
  for (const action of [review, conflict, sync])
    await expect(action).toHaveCSS("background-color", "rgb(28, 28, 28)");
  const rightEdge = async (action: typeof review) => {
    const bounds = (await action.boundingBox())!;
    return bounds.x + bounds.width;
  };
  const reviewEdge = await rightEdge(review);
  expect(await rightEdge(conflict)).toBeCloseTo(reviewEdge, 0);
  await expect(
    selected.getByRole("button", { name: "Review requests" }),
  ).toBeVisible();
  await selected.locator("summary").press("Enter");
  await expect(
    selected.getByText("/synthetic/product/.agents/skills/writing", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    selected.getByText("/synthetic/product/.claude/skills/writing", {
      exact: true,
    }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("combobox", { name: /Select project/ }).click();
  await page.getByRole("option", { name: "Docs", exact: true }).click();
  await status.click();
  const other = modal.getByRole("group", { name: "Writing guide in Product" });
  const compactReview = other.getByRole("button", {
    name: "Review copies for Writing guide",
  });
  await expect(compactReview).toHaveText("Review copies");
  expect(await rightEdge(compactReview)).toBeCloseTo(reviewEdge, 0);
  await expect(other.locator("summary")).toHaveCount(0);
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
  const history = page.getByRole("region", { name: "Request history" });
  const disclosure = history.locator("details");
  const summary = disclosure.locator("summary");
  await expect(disclosure).toHaveAttribute("open", "");
  await expect(summary).toBeFocused();
  await summary.press("Enter");
  await expect(disclosure).not.toHaveAttribute("open", "");

  await openSettings.click();
  await page.keyboard.press("Escape");
  await expect(disclosure).toBeVisible();
  await expect(disclosure).not.toHaveAttribute("open", "");
});
