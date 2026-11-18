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
  const recent = settings.getByRole("region", {
    name: "Recently deleted",
    exact: true,
  });
  await expect(danger).toContainText("Danger zone");
  await expect(
    danger.getByRole("button", { name: "Archive project", exact: true }),
  ).toBeVisible();
  await expect(
    danger.getByRole("button", { name: "Delete project", exact: true }),
  ).toBeVisible();
  await expect(recent.getByText("Old project", { exact: true })).toBeVisible();
  await expect(recent).toContainText("Restorable until");
  await recent.scrollIntoViewIfNeeded();
  await mkdir("/tmp/orka-briefs", { recursive: true });
  await page.screenshot({
    path: "/tmp/orka-briefs/owner-delete-1.png",
    animations: "disabled",
  });

  await danger
    .getByRole("button", { name: "Delete project", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Delete project?",
    exact: true,
  });
  await expect(dialog).toContainText("The 3 members of this project");
  await expect(dialog).toContainText("It can be restored until");
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
  await dialog.getByRole("button", { name: "Stay", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});
