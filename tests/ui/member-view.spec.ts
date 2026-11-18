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
  await expect(banner).toContainText("sync is paused");
  await expect(banner).toContainText(
    "Deleted by owner, restorable until Jan 31, 2026",
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
  await expect(confirm).toContainText("Remove this project?");
  await expect(confirm).toContainText("local drafts");
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
