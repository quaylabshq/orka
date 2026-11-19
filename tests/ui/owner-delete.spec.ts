import { mkdir } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { settingsFixture, settingsCalls } from "./fixtures/settings.js";

test("owner sees the danger zone and confirms project deletion by name", async ({
  page,
}) => {
  const settings = await settingsFixture(page, {
    deletedProjects: [
      {
        id: "deleted",
        name: "Old project",
        role: "owner",
        deletedAt: "2026-01-01T00:00:00Z",
        purgeAfter: "2026-02-14T12:00:00Z",
        lifecycleRevision: 2,
      },
    ],
  });
  const danger = settings.getByRole("region", {
    name: "Danger zone",
    exact: true,
  });
  await settings.getByRole("button", { name: "Projects", exact: true }).click();
  const recent = settings.getByRole("region", {
    name: "Recently deleted",
    exact: true,
  });

  await expect(recent.getByText("Old project", { exact: true })).toBeVisible();
  await expect(recent).toContainText("Restorable until");
  await recent.scrollIntoViewIfNeeded();
  await mkdir("/tmp/orka-briefs", { recursive: true });
  await page.screenshot({
    path: "/tmp/orka-briefs/owner-delete-1.png",
    animations: "disabled",
  });

  await settings.getByRole("button", { name: "General", exact: true }).click();
  await expect(
    danger.getByRole("button", { name: "Archive project", exact: true }),
  ).toBeVisible();
  await danger
    .getByRole("button", { name: "Delete project", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Delete project?",
    exact: true,
  });
  await expect(dialog).toContainText("The 3 members of this project");
  await expect(dialog).toContainText(
    "This service keeps deleted projects for 7 days.",
  );
  const field = dialog.getByRole("textbox", {
    name: "Project name",
    exact: true,
  });
  const confirm = dialog.getByRole("button", {
    name: "Delete project",
    exact: true,
  });
  await expect(confirm).toBeDisabled();
  await field.fill("Orka");
  await expect(confirm).toBeEnabled();
  await page.screenshot({
    path: "/tmp/orka-briefs/owner-delete-2.png",
    animations: "disabled",
  });
  await confirm.click();
  await expect
    .poll(async () =>
      (await settingsCalls(page)).find(
        (call) =>
          call.command === "project_command" && call.args.action === "delete",
      ),
    )
    .toMatchObject({ args: { input: { confirmation: "Orka" } } });
  await expect(
    settings.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeFocused();
});

test("a refused delete keeps its message in the open dialog", async ({
  page,
}) => {
  const settings = await settingsFixture(page, { queued: true });
  const danger = settings.getByRole("region", {
    name: "Danger zone",
    exact: true,
  });
  await danger
    .getByRole("button", { name: "Delete project", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Delete project?",
    exact: true,
  });
  await dialog
    .getByRole("textbox", { name: "Project name", exact: true })
    .fill("Orka");
  await dialog
    .getByRole("button", { name: "Delete project", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Sync queued changes and finish pending ENV publications before deleting this project",
  );
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("owner can archive and restore through the account Projects section", async ({
  page,
}) => {
  const settings = await settingsFixture(page);
  await settings
    .getByRole("button", { name: "Archive project", exact: true })
    .click();
  await expect(
    settings.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeFocused();
  const archived = settings.getByRole("region", { name: "Archived projects" });
  await expect(archived).toContainText("Orka");
  await archived.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(archived).toHaveCount(0);
  await expect(
    settings.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeFocused();
  await settings.getByRole("button", { name: "General", exact: true }).click();
  await expect(
    settings.getByRole("button", { name: "Archive project", exact: true }),
  ).toBeVisible();
});

test("account recovery remains reachable without active projects", async ({
  page,
}) => {
  const settings = await settingsFixture(page, {
    noProjects: true,
    deletedProjects: [
      {
        id: "owned",
        name: "Owned project",
        role: "owner",
        deletedAt: "2026-01-01T00:00:00Z",
        purgeAfter: "2026-12-31T00:00:00Z",
        lifecycleRevision: 2,
      },
    ],
  });
  const projects = settings.getByRole("button", {
    name: "Projects",
    exact: true,
  });
  await expect(projects).toBeEnabled();
  await projects.click();
  const recent = settings.getByRole("region", { name: "Recently deleted" });
  await expect(recent).toContainText("Owned project");
  await recent.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(recent).toHaveCount(0);
});

test("account recovery is independent of selected project role and fits long names", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 640 });
  const settings = await settingsFixture(page, {
    role: "member",
    deletedProjects: [
      {
        id: "owned",
        name: "A".repeat(100),
        role: "owner",
        deletedAt: "2026-01-01T00:00:00Z",
        purgeAfter: "2026-12-31T00:00:00Z",
        lifecycleRevision: 2,
      },
    ],
  });
  await settings.getByRole("button", { name: "Projects", exact: true }).click();
  const recent = settings.getByRole("region", { name: "Recently deleted" });
  const restore = recent.getByRole("button", { name: "Restore", exact: true });
  const purge = recent.getByRole("button", { name: "Delete now", exact: true });
  await expect(restore).toBeInViewport();
  await expect(purge).toBeInViewport();
  const bounds = await recent.boundingBox();
  for (const button of [restore, purge]) {
    const box = await button.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
  }
});

test("delete uses configured restore policy and old services cannot delete", async ({
  page,
}) => {
  let settings = await settingsFixture(page, { projectRestoreWindowDays: 1 });
  await settings
    .getByRole("button", { name: "Delete project", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "This service keeps deleted projects for 1 day.",
  );
  await page.keyboard.press("Escape");
  settings = await settingsFixture(page, { olderService: true });
  await expect(
    settings.getByRole("button", { name: "Delete project", exact: true }),
  ).toBeDisabled();
  await expect(settings).toContainText(
    "Update this service to use recoverable project deletion.",
  );
});

test("permanent deletion wraps the maximum-length name and returns focus to Projects", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 640 });
  const name = "A".repeat(100);
  const settings = await settingsFixture(page, {
    noProjects: true,
    deletedProjects: [
      {
        id: "owned",
        name,
        role: "owner",
        deletedAt: "2026-01-01T00:00:00Z",
        purgeAfter: "2026-12-31T00:00:00Z",
        lifecycleRevision: 2,
      },
    ],
  });
  await settings.getByRole("button", { name: "Projects", exact: true }).click();
  const recent = settings.getByRole("region", { name: "Recently deleted" });
  await recent.getByRole("button", { name: "Delete now", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Delete project permanently?",
    exact: true,
  });
  await expect(dialog).toBeInViewport();
  const geometry = await dialog.evaluate((element) => ({
    width: element.clientWidth,
    scrollWidth: element.scrollWidth,
    paragraphs: Array.from(
      element.querySelectorAll("p, .project-lifecycle-target"),
    ).map((paragraph) => ({
      width: paragraph.clientWidth,
      scrollWidth: paragraph.scrollWidth,
    })),
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
  for (const paragraph of geometry.paragraphs)
    expect(paragraph.scrollWidth).toBeLessThanOrEqual(paragraph.width);
  await expect(
    dialog.getByRole("textbox", { name: "Project name", exact: true }),
  ).toBeFocused();
  await dialog
    .getByRole("textbox", { name: "Project name", exact: true })
    .fill(name);
  await dialog.getByRole("button", { name: "Delete now", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(recent).toHaveCount(0);
  await expect(
    settings.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeFocused();
});
