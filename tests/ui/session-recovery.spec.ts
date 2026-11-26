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

  // The next snapshot removes the successful choice from the episode.
  await expect(
    page.getByText("2 deleted sessions have incoming copies"),
  ).toBeVisible({ timeout: 8000 });
  await expect(
    page.getByRole("checkbox", { name: "Design walkthrough" }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Desktop sync notes" }),
  ).toBeChecked();
  await page.evaluate(() => {
    delete window.attentionFixture.failRecoveryId;
  });
  await page.getByRole("button", { name: "Restore (1)", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.attentionFixture.calls
          .filter((c) => c.name === "resolve_session_recovery")
          .map((c) => c.args?.id),
      ),
    )
    .toEqual(["recovery-0", "recovery-2", "recovery-2"]);
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

test("an open recovery group pins selected candidates across refresh and keeps new groups independent", async ({
  page,
}) => {
  await page.getByRole("checkbox", { name: "Design walkthrough" }).uncheck();
  await page.evaluate(() => {
    const { resources, conflicts, errors } = window.attentionFixture.state;
    // Change one selected version, add one row to its open episode and form
    // a separate, later episode from two new sessions on the same device.
    resources[2].revision++;
    conflicts[2].revision++;
    conflicts[2].candidate.revision++;
    for (const [i, minute] of [
      [3, 3],
      [4, 6],
      [5, 7],
    ]) {
      const resourceId = "recovery-" + i;
      const title = "New session " + i;
      resources.push({ ...resources[0], resourceId, title });
      conflicts.push({
        ...conflicts[0],
        id: "candidate-" + i,
        resourceId,
        candidate: {
          ...conflicts[0].candidate,
          resourceId,
          title,
          updatedAt: new Date(Date.UTC(2026, 10, 13, 11, minute)).toISOString(),
        },
      });
      errors.push({ ...errors[0], source: resourceId });
    }
  });
  const opened = page.getByRole("group", {
    name: "4 deleted sessions have incoming copies",
  });
  await expect(
    opened.getByRole("checkbox", { name: "Release checklist" }),
  ).toBeChecked({ timeout: 8000 });
  for (const title of [
    "Design walkthrough",
    "Desktop sync notes",
    "New session 3",
  ])
    await expect(
      opened.getByRole("checkbox", { name: title }),
    ).not.toBeChecked();

  const later = page.getByRole("group", {
    name: "2 deleted sessions have incoming copies",
  });
  await later.getByText("Review sessions", { exact: true }).press("Enter");
  await expect(
    later.getByRole("button", { name: "Restore (2)", exact: true }),
  ).toBeEnabled();
  await later.getByText("Review sessions", { exact: true }).press("Enter");

  await opened.getByRole("checkbox", { name: "New session 3" }).check();
  await opened
    .getByRole("button", { name: "Restore (2)", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.attentionFixture.calls
          .filter((c) => c.name === "resolve_session_recovery")
          .map((c) => c.args?.id),
      ),
    )
    .toEqual(["recovery-0", "recovery-3"]);
  // Removing the successful choices shifts the five-minute window. A row
  // previously reviewed in the other group now needs consent for this one.
  const regrouped = page.getByRole("group", {
    name: "3 deleted sessions have incoming copies",
  });
  await expect(
    regrouped.getByRole("checkbox", { name: "New session 4" }),
  ).toBeVisible({ timeout: 8000 });
  await expect(
    regrouped.getByRole("checkbox", { name: "New session 4" }),
  ).not.toBeChecked();
  await expect(
    regrouped.getByRole("button", { name: "Restore (0)", exact: true }),
  ).toBeDisabled();
});

test("manual session sharing keeps the incoming copy readable and disables recovery writes", async ({
  page,
}) => {
  await page.evaluate(() => {
    window.attentionFixture.state.projects[0].sharing = {
      memory: true,
      skill: true,
      plan: true,
      env: false,
      session: false,
    };
  });
  const hint = page.getByText(
    "Recovery choices require “Share automatically” for Sessions on this Mac. You can change this in Settings → General → Sharing.",
    { exact: true },
  );
  await expect(hint).toBeVisible({ timeout: 8000 });
  await expect(
    page.getByRole("button", { name: "Keep deleted (3)", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Restore (3)", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Review Desktop sync notes", exact: true })
    .click();
  await expect(hint).toBeVisible();
  await expect(
    page.getByRole("button", { name: "View incoming version", exact: true }),
  ).toBeEnabled();
  for (const name of ["Keep deleted", "Restore session", "Create copy"])
    await expect(
      page.getByRole("button", { name, exact: true }),
    ).toBeDisabled();
  await page.evaluate(() => {
    window.attentionFixture.state.projects[0].sharing!.session = true;
  });
  await expect(
    page.getByRole("button", { name: "Restore session", exact: true }),
  ).toBeEnabled({ timeout: 8000 });
  await expect(hint).toHaveCount(0);
});
