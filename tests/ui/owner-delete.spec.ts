import { mkdir } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { settingsFixture, settingsCalls } from "./fixtures/settings.js";

test("Settings lists active and disabled projects and can add a project back to this Mac", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 640 });
  const settings = await settingsFixture(page, {
    disabledProjects: [
      {
        id: "hidden",
        name: "Field notes",
        localName: "Notes",
        role: "member",
      },
    ],
  });
  const projects = settings.getByRole("button", {
    name: "Projects",
    exact: true,
  });
  await projects.click();
  const active = settings.getByRole("region", { name: "Active projects" });
  const disabled = settings.getByRole("region", {
    name: "Disabled on this Mac",
  });
  await expect(active.getByRole("listitem")).toHaveCount(2);
  await expect(disabled.getByText("Notes", { exact: true })).toBeVisible();
  const picker = page.getByRole("combobox", {
    name: "Select project",
    exact: true,
  });
  await picker.click();
  await expect(
    page.getByRole("option", { name: "Notes", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(picker).toBeFocused();

  await disabled
    .getByRole("button", { name: "Add to this Mac", exact: true })
    .press("Enter");
  await expect(disabled).toHaveCount(0);
  await expect(active.getByText("Notes", { exact: true })).toBeVisible();
  await expect(
    settings.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeFocused();
  await picker.click();
  await expect(
    page.getByRole("option", { name: "Notes", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await active
    .getByRole("listitem")
    .filter({ hasText: "Notes" })
    .getByRole("button", { name: "Manage", exact: true })
    .click();
  await expect(
    settings.getByRole("group", { name: "Project settings for Notes" }),
  ).toBeVisible();
  await expect(
    settings.getByRole("button", { name: "Leave project", exact: true }),
  ).toBeVisible();
  await expect(picker).toContainText("Orka");
  expect(
    (await settingsCalls(page)).find((call) => call.args.action === "show")
      ?.args,
  ).toEqual({ action: "show", input: { projectId: "hidden" } });
});

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
  const picker = page.getByRole("combobox", {
    name: "Select project",
    exact: true,
  });
  await expect(picker).toBeDisabled();
  await projects.click();
  const recent = settings.getByRole("region", { name: "Recently deleted" });
  await expect(recent).toContainText("Owned project");
  await recent.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(recent).toHaveCount(0);
  await expect(picker).toBeEnabled();
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
  const details = recent.getByRole("button", { name: "Details", exact: true });
  const restore = recent.getByRole("button", { name: "Restore", exact: true });
  const purge = recent.getByRole("button", { name: "Delete now", exact: true });
  await recent.scrollIntoViewIfNeeded();
  await expect(details).toBeInViewport();
  await expect(restore).toBeInViewport();
  await expect(purge).toBeInViewport();
  const bounds = await recent.boundingBox();
  for (const button of [details, restore, purge]) {
    const box = await button.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
  }
  const deadline = await recent.getByText(/Restorable until/).boundingBox();
  expect(deadline!.y + deadline!.height).toBeLessThanOrEqual(
    (await restore.boundingBox())!.y,
  );
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

for (const kind of ["archived", "deleted"] as const) {
  test(`a failed restore stays visible beside its ${kind} project in a long list`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 640 });
    const projects = Array.from({ length: 20 }, (_, index) => ({
      id: `recover-${index}`,
      name: `Recovery project ${String(index).padStart(2, "0")}`,
      role: "owner" as const,
      lifecycleRevision: 2,
    }));
    const message =
      "The service is unavailable. Try restoring this project again when connected.";
    const recovery =
      kind === "archived"
        ? {
            archivedProjects: projects.map((project) => ({
              ...project,
              archivedAt: "2026-11-19T00:00:00Z",
            })),
          }
        : {
            deletedProjects: projects.map((project) => ({
              ...project,
              deletedAt: "2026-11-19T00:00:00Z",
              purgeAfter: "2026-11-26T00:00:00Z",
            })),
          };
    const settings = await settingsFixture(page, {
      noProjects: true,
      restoreError: message,
      ...recovery,
    });
    await settings
      .getByRole("button", { name: "Projects", exact: true })
      .click();
    const recoveryList = settings.getByRole("region", {
      name: kind === "deleted" ? "Recently deleted" : "Archived projects",
    });
    const row = recoveryList.getByRole("listitem").filter({
      hasText:
        kind === "deleted" ? "Recovery project 03" : "Recovery project 00",
    });
    await row.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(row.getByRole("alert")).toHaveText(message);
    await expect(row.getByRole("alert")).toBeInViewport({ ratio: 1 });
    await page.evaluate(() => {
      (window as any).settingsControls.restoreError = "";
    });
    await row.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(row).toHaveCount(0);
    await expect(
      settings.getByRole("region", { name: "Active projects" }),
    ).toContainText(
      kind === "deleted" ? "Recovery project 03" : "Recovery project 00",
    );
  });
}

test("deletion support retry remains visible in project settings", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 640 });
  const settings = await settingsFixture(page, {
    failDeletionCapabilities: true,
  });
  const feedback = settings
    .getByRole("alert")
    .filter({ hasText: "Could not check project deletion support." });
  await expect(feedback).toHaveCSS("background-color", "rgb(18, 18, 18)");
  const retry = feedback.getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toHaveCSS("background-color", "rgb(28, 28, 28)");
  await page.evaluate(() => {
    (window as any).settingsControls.failDeletionCapabilities = false;
  });
  await retry.press("Enter");
  await expect(feedback).toHaveCount(0);
});

test("deletion support failure and retry remain visible above a long recovery list", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 640 });
  const settings = await settingsFixture(page, {
    noProjects: true,
    failDeletionCapabilities: true,
    deletedProjects: Array.from({ length: 20 }, (_, index) => ({
      id: `deleted-${index}`,
      name: `Recovery project ${index}`,
      role: "owner",
      deletedAt: "2026-11-19T00:00:00Z",
      purgeAfter: "2026-11-26T00:00:00Z",
    })),
  });
  await settings.getByRole("button", { name: "Projects", exact: true }).click();
  const retry = settings.getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toBeInViewport();
  const deleting = settings
    .getByRole("button", { name: "Delete now", exact: true })
    .first();
  await expect(deleting).toBeDisabled();
  await page.evaluate(() => {
    (window as any).settingsControls.failDeletionCapabilities = false;
  });
  await retry.click();
  await expect(deleting).toBeEnabled();
  await expect(retry).toHaveCount(0);
});
