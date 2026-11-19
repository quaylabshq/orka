import { expect, test, type Page } from "@playwright/test";
import { memberViewCalls, memberViewFixture } from "./fixtures/member-view.js";

const badges = [
  ["Archived notes", "Archived by owner"],
  ["Deleted notes", "Deleted by owner, restorable until Jan 31, 2026"],
  ["Purged notes", "Deleted"],
  ["Removed notes", "Access removed"],
];

async function openPicker(page: Page) {
  await page
    .getByRole("combobox", { name: "Select project", exact: true })
    .click();
  return page.getByRole("listbox", { name: "Projects", exact: true });
}

test("inactive projects stay in the sidebar, greyed out with a badge", async ({
  page,
}) => {
  await memberViewFixture(page);
  const projects = await openPicker(page);
  for (const [name, badge] of badges) {
    const option = projects.getByRole("option").filter({ hasText: name });
    await expect(option).toBeVisible();
    await expect(option).toContainText(badge);
    await expect(option).toHaveClass(/project-menu-item-inactive/);
  }
  await page.screenshot({
    animations: "disabled",
    path: "/tmp/orka-briefs/member-view-1.png",
  });
});

test("an inactive project explains the pause and offers export and removal", async ({
  page,
}) => {
  await memberViewFixture(page);
  const projects = await openPicker(page);
  await projects
    .getByRole("option")
    .filter({ hasText: "Deleted notes" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Deleted notes", exact: true }),
  ).toBeVisible();
  const banner = page.locator(".inactive-project-banner");
  await expect(
    banner.getByRole("heading", { name: "Sync paused" }),
  ).toBeVisible();
  await expect(banner).toContainText(
    "Orka keeps capturing your changes on this Mac. 3 held, uploaded if restored by Jan 31, 2026, kept as local drafts if not.",
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
  await expect(confirm).toContainText(
    "4 changes held on this Mac will be lost.",
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
  // The removed project leaves the sidebar; the remaining active one is shown.
  await expect(
    page.getByRole("heading", { name: "Home", exact: true }),
  ).toBeVisible();
});

test("cancelling local removal returns focus at the minimum viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 640 });
  await memberViewFixture(page);
  const projects = await openPicker(page);
  await projects
    .getByRole("option")
    .filter({ hasText: "Deleted notes" })
    .click();
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

test("a selected inactive project keeps its checkmark aligned with its name", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 640 });
  await memberViewFixture(page);
  let projects = await openPicker(page);
  await projects
    .getByRole("option")
    .filter({ hasText: "Deleted notes" })
    .click();
  projects = await openPicker(page);
  const selected = projects.getByRole("option", { selected: true });
  await expect(selected).toContainText("Deleted notes");
  const centers = await selected.evaluate((element) => {
    const icons = element.querySelectorAll(":scope > svg");
    const center = (item: Element) => {
      const box = item.getBoundingClientRect();
      return box.y + box.height / 2;
    };
    return {
      folder: center(icons[0]),
      check: center(icons[icons.length - 1]),
      name: center(element.querySelector(":scope > span")!),
    };
  });
  expect(Math.abs(centers.check - centers.folder)).toBeLessThanOrEqual(1);
  expect(Math.abs(centers.check - centers.name)).toBeLessThanOrEqual(1);
});

test("a failed local removal keeps its confirmation open for retry", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 640 });
  const message =
    "Could not remove the cached files. Check folder permissions and try again.";
  await memberViewFixture(page, { removeError: message });
  const projects = await openPicker(page);
  await projects
    .getByRole("option")
    .filter({ hasText: "Deleted notes" })
    .click();
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
  const projects = await openPicker(page);
  await projects
    .getByRole("option")
    .filter({ hasText: "Deleted notes" })
    .click();
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
  const projects = await openPicker(page);
  await projects
    .getByRole("option")
    .filter({ hasText: "Deleted notes" })
    .click();
  const banner = page.locator(".inactive-project-banner");
  await expect(banner).toContainText(
    "This project is deleted by its owner. Orka keeps capturing your changes on this Mac. Changes are uploaded if restored by Jan 31, 2026, kept as local drafts if not.",
  );
  await expect(banner).not.toContainText(" held,");
});

test("an archived project keeps its own banner and warning", async ({
  page,
}) => {
  await memberViewFixture(page);
  const projects = await openPicker(page);
  await projects
    .getByRole("option")
    .filter({ hasText: "Archived notes" })
    .click();
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
  await expect(dialog).toContainText(
    "2 changes held on this Mac will be lost.",
  );
  await expect(dialog).toContainText("local drafts");
});

test("the removal warning uses a singular change count", async ({ page }) => {
  await memberViewFixture(page, { heldChanges: 1, pendingChanges: 1 });
  const projects = await openPicker(page);
  await projects
    .getByRole("option")
    .filter({ hasText: "Deleted notes" })
    .click();
  const banner = page.locator(".inactive-project-banner");
  await expect(banner).toContainText(
    "1 held, uploaded if restored by Jan 31, 2026",
  );
  await banner
    .getByRole("button", { name: "Remove from this Mac", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Remove from this Mac?",
    exact: true,
  });
  await expect(dialog).toContainText("1 change held on this Mac will be lost.");
});
