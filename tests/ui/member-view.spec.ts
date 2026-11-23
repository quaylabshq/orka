import { expect, test, type Page } from "@playwright/test";
import { memberViewCalls, memberViewFixture } from "./fixtures/member-view.js";

test.use({ locale: "en-US", timezoneId: "UTC" });

async function openPicker(page: Page) {
  await page
    .getByRole("combobox", { name: "Select project", exact: true })
    .click();
  return page.getByRole("listbox", { name: "Projects", exact: true });
}

async function openProjectsSettings(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  return page.getByRole("region", { name: "Settings", exact: true });
}

async function openInactiveProject(page: Page, name: string) {
  const settings = await openProjectsSettings(page);
  await settings
    .getByRole("listitem")
    .filter({ hasText: name })
    .getByRole("button", { name: "Details", exact: true })
    .click();
}

test("inactive projects appear in Settings and stay out of the picker", async ({
  page,
}) => {
  await memberViewFixture(page);
  const picker = await openPicker(page);
  await expect(picker.getByRole("option")).toHaveText(["Product"]);
  await page.keyboard.press("Escape");
  const settings = await openProjectsSettings(page);
  await expect(
    settings.getByRole("region", { name: "Archived projects" }),
  ).toContainText("Archived notes");
  const deleted = settings.getByRole("region", { name: "Recently deleted" });
  await expect(deleted).toContainText("Deleted notes");
  await expect(deleted.getByRole("button")).toHaveText(["Details"]);
  const unavailable = settings.getByRole("region", {
    name: "Unavailable projects",
  });
  await expect(
    unavailable.getByRole("listitem").filter({ hasText: "Purged notes" }),
  ).toContainText("Permanently deleted");
  await expect(
    unavailable.getByRole("listitem").filter({ hasText: "Removed notes" }),
  ).toContainText("Access removed");
});

test("an inactive project explains the pause and offers export and removal", async ({
  page,
}) => {
  await memberViewFixture(page);
  await openInactiveProject(page, "Deleted notes");
  await expect(
    page.getByRole("heading", { name: "Deleted notes", exact: true }),
  ).toBeVisible();
  const banner = page.locator(".inactive-project-banner");
  await expect(
    banner.getByRole("heading", { name: "Sync paused" }),
  ).toBeVisible();
  await expect(banner).toContainText(
    "3 changes are queued to sync if restored by Jan 31, 2026.",
  );
  await page.screenshot({
    animations: "disabled",
    path: "/tmp/orka-briefs/member-view-2.png",
  });
  await banner.getByRole("button", { name: "Export", exact: true }).click();
  await expect
    .poll(async () =>
      (await memberViewCalls(page)).filter(
        (call) => call.name === "export_project",
      ),
    )
    .toEqual([
      {
        name: "export_project",
        args: { projectId: "deleted", destination: "/tmp/orka-export.zip" },
      },
    ]);
  await banner
    .getByRole("button", { name: "Remove from this Mac", exact: true })
    .click();
  const confirm = page.getByRole("dialog");
  await expect(confirm.locator("h2:not(.sr-only)")).toBeVisible();
  await expect(confirm.locator("h2:not(.sr-only)")).toHaveText(
    "Remove from this Mac?",
  );
  await expect(confirm).toContainText("local drafts");
  await expect(confirm).toContainText("4 pending changes on this Mac.");
  await expect(confirm).toContainText(
    "The export excludes 1 encrypted ENV publication.",
  );

  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect
    .poll(async () =>
      (await memberViewCalls(page)).filter(
        (call) => call.name === "project_command",
      ),
    )
    .toEqual([
      {
        name: "project_command",
        args: { action: "remove", input: { projectId: "deleted" } },
      },
    ]);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // After local removal, the remaining active project is shown.
  await expect(
    page.getByRole("heading", { name: "Home", exact: true }),
  ).toBeVisible();
});

test("cancelling local removal returns focus at the minimum viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 640 });
  await memberViewFixture(page);
  await openInactiveProject(page, "Deleted notes");
  const banner = page.locator(".inactive-project-banner");
  const remove = banner.getByRole("button", {
    name: "Remove from this Mac",
    exact: true,
  });
  await expect(
    banner.getByRole("button", { name: "Export", exact: true }),
  ).toBeInViewport();
  await expect(remove).toBeInViewport();
  await remove.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", {
    name: "Remove from this Mac?",
    exact: true,
  });
  await expect(
    dialog.getByRole("button", { name: "Keep it", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(remove).toBeFocused();
  await page
    .getByRole("button", { name: "Collapse sidebar", exact: true })
    .click();
  await expect(remove).toBeInViewport();
  await expect(
    banner.getByRole("button", { name: "Export", exact: true }),
  ).toBeInViewport();
});

test("inactive details keep the project out of the collapsed picker and link back to Projects", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 640 });
  await memberViewFixture(page);
  await openInactiveProject(page, "Deleted notes");
  await page
    .getByRole("button", { name: "Collapse sidebar", exact: true })
    .click();
  await page.getByRole("combobox", { name: /^Select project/ }).press("Enter");
  const picker = page.getByRole("listbox", { name: "Projects", exact: true });
  await expect(picker.getByRole("option")).toHaveText(["Product"]);
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Back to Projects", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Recently deleted" }),
  ).toContainText("Deleted notes");
});

test("a failed local removal keeps its confirmation open for retry", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 640 });
  const message =
    "Could not remove the cached files. Check folder permissions and try again.";
  await memberViewFixture(page, { removeError: message });
  await openInactiveProject(page, "Deleted notes");
  await page
    .getByRole("button", { name: "Remove from this Mac", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Remove from this Mac?",
    exact: true,
  });
  await dialog.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveText(message);
  await expect(dialog.getByRole("alert")).toBeInViewport();
  await page.evaluate(() => {
    window.memberViewFixture.controls.removeError = "";
  });
  await dialog.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Home", exact: true }),
  ).toBeVisible();
});

test("local removal shows progress and blocks dismissal until it finishes", async ({
  page,
}) => {
  await memberViewFixture(page, { holdRemoval: true });
  await openInactiveProject(page, "Deleted notes");
  await page
    .getByRole("button", { name: "Remove from this Mac", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Remove from this Mac?",
    exact: true,
  });
  const remove = dialog.getByRole("button", { name: "Remove", exact: true });
  await remove.click();
  await expect(remove).toHaveAttribute("aria-busy", "true");
  await expect(remove.locator(".activity-indicator")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Keep it", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await page.evaluate(() => window.memberViewFixture.releaseRemoval?.());
  await expect(dialog).toHaveCount(0);
});

test("a deleted project with nothing held hides the count", async ({
  page,
}) => {
  await memberViewFixture(page, { heldChanges: 0 });
  await openInactiveProject(page, "Deleted notes");
  const banner = page.locator(".inactive-project-banner");
  await expect(banner).toContainText(
    "Sync can resume if the project is restored by Jan 31, 2026.",
  );
  await expect(banner).not.toContainText("queued to sync");
});

test("an archived project keeps its own banner and warning", async ({
  page,
}) => {
  await memberViewFixture(page);
  await openInactiveProject(page, "Archived notes");
  const banner = page.locator(".inactive-project-banner");
  await expect(banner).toContainText(
    "This project is archived by its owner. Sync will resume when it’s restored.",
  );
  await expect(banner).not.toContainText("Orka keeps capturing");
  await banner
    .getByRole("button", { name: "Remove from this Mac", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Remove from this Mac?",
    exact: true,
  });
  await expect(dialog).toContainText("2 pending changes on this Mac.");
  await expect(dialog).toContainText("local drafts");
});

test("the removal warning uses a singular change count", async ({ page }) => {
  await memberViewFixture(page, { heldChanges: 1, pendingChanges: 1 });
  await openInactiveProject(page, "Deleted notes");
  const banner = page.locator(".inactive-project-banner");
  await expect(banner).toContainText(
    "1 change is queued to sync if restored by Jan 31, 2026",
  );
  await banner
    .getByRole("button", { name: "Remove from this Mac", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Remove from this Mac?",
    exact: true,
  });
  await expect(dialog).toContainText("1 pending change on this Mac.");
});
