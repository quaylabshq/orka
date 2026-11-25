import { test, expect } from "@playwright/test";
import { syncAttentionFixture } from "./fixtures/sync-attention.js";

test.beforeEach(async ({ page }) => {
  await syncAttentionFixture(page, { sessionRecovery: true });
  await page.goto("/");
  const status = page.locator(".workspace-header .sync-status");
  await expect(status).toHaveAttribute(
    "aria-label",
    "Needs attention, 1 notification",
  );
  await status.click();
  await page.getByText("Review sessions", { exact: true }).click();
});

test("owner selection queues pinned choices and reports changed sessions individually", async ({
  page,
}) => {
  await page.getByRole("checkbox", { name: "Design walkthrough" }).uncheck();
  await page.evaluate(() => {
    window.attentionFixture.failRecoveryId = "recovery-2";
  });
  await page.getByRole("button", { name: "Restore (2)", exact: true }).click();
  const outcome = page
    .getByRole("status")
    .filter({ hasText: "choice queued for sync" });
  await expect(outcome).toContainText("1 choice queued for sync");
  await expect(outcome).toContainText("Desktop sync notes");
  const calls = await page.evaluate(() =>
    window.attentionFixture.calls
      .filter((c) => c.name === "resolve_session_recovery")
      .map((c) => c.args),
  );
  expect(calls).toEqual(
    [0, 2].map((i) => ({
      id: "recovery-" + i,
      projectId: "one",
      expectedRevision: i + 5,
      conflictId: "candidate-" + i,
      choice: "restore",
      singleCandidate: true,
    })),
  );
});

test("owner may keep selected sessions deleted", async ({ page }) => {
  await page.getByRole("checkbox", { name: "Desktop sync notes" }).uncheck();
  await page
    .getByRole("button", { name: "Keep deleted (2)", exact: true })
    .click();
  await expect(page.getByText("2 choices queued for sync")).toBeVisible();
  expect(
    await page.evaluate(() =>
      window.attentionFixture.calls
        .filter((c) => c.name === "resolve_session_recovery")
        .map((c) => [c.args?.id, c.args?.choice]),
    ),
  ).toEqual([
    ["recovery-0", "keep"],
    ["recovery-1", "keep"],
  ]);
});

test("owner can inspect the incoming copy of a deleted session without applying a group decision", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Review Desktop sync notes" }).click();
  await expect(
    page.getByText("This shared session was deleted."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "View incoming version" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Create copy", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.attentionFixture.calls
          .filter((c) => c.name === "resolve_session_recovery")
          .map((c) => c.args),
      ),
    )
    .toEqual([
      {
        id: "recovery-2",
        projectId: "one",
        conflictId: "candidate-2",
        expectedRevision: 7,
        choice: "copy",
        singleCandidate: false,
      },
    ]);
});

test("all queued choices leave the outcome visible after the attention list refreshes", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "Keep deleted (3)", exact: true })
    .click();
  await expect(page.getByText("3 choices queued for sync")).toBeVisible();
  await expect(
    page.locator(".workspace-header .sync-status"),
  ).not.toHaveAttribute("aria-label", /notification/, { timeout: 8000 });
  await expect(page.getByText("3 choices queued for sync")).toBeVisible();
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(page.getByText("3 choices queued for sync")).toHaveCount(0);
});
