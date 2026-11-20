import { test, expect, type Page } from "@playwright/test";
import { settingsFixture, settingsCalls } from "./fixtures/settings.js";

async function projectMenu(page: Page, name: string) {
  await page
    .getByRole("combobox", { name: "Select project", exact: true })
    .click();
  await page
    .getByRole("option", { name, exact: true })
    .click({ button: "right" });
  return page.getByRole("menu", { name: `Actions for ${name}`, exact: true });
}

test("project option context menus target the clicked project without selecting it", async ({
  page,
}) => {
  await settingsFixture(page);
  const picker = page.getByRole("combobox", {
    name: "Select project",
    exact: true,
  });
  await picker.click();
  const website = page.getByRole("option", { name: "Website", exact: true });
  await website.click({ button: "right" });
  const menu = page.getByRole("menu", {
    name: "Actions for Website",
    exact: true,
  });
  await expect(menu).toBeVisible();
  await expect(picker).toContainText("Orka");
  await expect(
    menu.getByRole("menuitem", { name: "Rename on this Mac…", exact: true }),
  ).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Rename project…", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(
    page.getByRole("listbox", { name: "Projects", exact: true }),
  ).toBeVisible();
  await expect(website).toBeFocused();
  await website.press("Shift+F10");
  await menu
    .getByRole("menuitem", { name: "Project settings…", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Project name", exact: true }),
  ).toHaveValue("Website");
  await expect(picker).toContainText("Orka");
});

test("Source folders opens at its section from Profile and from General", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 640 });
  const settings = await settingsFixture(page);
  await settings.getByRole("button", { name: "Profile", exact: true }).click();
  for (const project of ["Website", "Orka"]) {
    const menu = await projectMenu(page, project);
    await menu.getByRole("menuitem", { name: "Source folders…" }).click();
    await expect(
      settings.getByRole("textbox", { name: "Project name", exact: true }),
    ).toHaveValue(project);
    await expect(
      settings.getByRole("group", { name: `Project settings for ${project}` }),
    ).toContainText(`Project · ${project}`);
    const target = settings.getByRole("heading", { name: "Source Folder" });
    await expect(target).toBeFocused();
    await expect(target).toBeInViewport();
  }
});

test("the Source folders shortcut preserves drafts through Stay and focuses the target after Discard", async ({
  page,
}) => {
  const settings = await settingsFixture(page);
  const name = settings.getByRole("textbox", {
    name: "Project name",
    exact: true,
  });
  await name.fill("Unsaved Orka name");
  const menu = await projectMenu(page, "Website");
  await menu.getByRole("menuitem", { name: "Source folders…" }).press("Enter");
  const guard = page.getByRole("dialog", { name: "Save your changes?" });
  await guard.getByRole("button", { name: "Stay", exact: true }).press("Enter");
  await expect(name).toHaveValue("Unsaved Orka name");
  await expect(
    page.getByRole("combobox", { name: "Select project", exact: true }),
  ).toBeFocused();

  const retry = await projectMenu(page, "Website");
  await retry.getByRole("menuitem", { name: "Source folders…" }).press("Enter");
  await guard
    .getByRole("button", { name: "Discard", exact: true })
    .press("Enter");
  await expect(name).toHaveValue("Website");
  await expect(
    settings.getByRole("heading", { name: "Source Folder" }),
  ).toBeFocused();
});

test("source context and ellipsis menus share actions and bind native reveal to the chosen source", async ({
  page,
}) => {
  const settings = await settingsFixture(page, {
    sourceRows: [
      {
        id: "desktop",
        name: "desktop",
        path: "/Projects/desktop",
        folderState: "connected",
      },
      {
        id: "api",
        name: "api",
        path: "/Projects/api",
        folderState: "connected",
      },
    ],
  });
  await page.evaluate(() => {
    const host = window as unknown as {
      copiedPaths: string[];
      settingsCalls: { command: string; args: unknown }[];
      __TAURI_INTERNALS__: {
        invoke: (
          command: string,
          args?: Record<string, unknown>,
        ) => Promise<unknown>;
      };
    };
    const original = host.__TAURI_INTERNALS__.invoke;
    host.copiedPaths = [];
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (value: string) => {
          host.copiedPaths.push(value);
        },
      },
    });
    host.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      if (command === "resource_command") {
        host.settingsCalls.push({ command, args });
        return { paths: ["/Projects/api"] };
      }
      return original(command, args);
    };
  });
  const row = settings.locator(".settings-folder-row").filter({
    has: page.locator(".settings-folder-name", { hasText: /^api$/ }),
  });
  const menu = page.getByRole("menu", { name: "Options for api", exact: true });
  await row.click({ button: "right" });
  const contextActions = await menu.getByRole("menuitem").allTextContents();
  await page.keyboard.press("Escape");
  await settings
    .getByRole("button", { name: "Options for api", exact: true })
    .click();
  expect(await menu.getByRole("menuitem").allTextContents()).toEqual(
    contextActions,
  );
  await menu
    .getByRole("menuitem", { name: "Show in Finder", exact: true })
    .click();
  await expect
    .poll(async () =>
      (await settingsCalls(page)).filter(
        (call) => call.command === "resource_command",
      ),
    )
    .toEqual([
      {
        command: "resource_command",
        args: {
          action: "reveal",
          input: {
            accountId: "owner",
            serviceOrigin: "https://test.orka",
            projectId: "one",
            sourceId: "api",
          },
        },
      },
    ]);
  await settings
    .getByRole("button", { name: "Options for api", exact: true })
    .click();
  await menu
    .getByRole("menuitem", { name: "Copy folder path", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { copiedPaths: string[] }).copiedPaths,
      ),
    )
    .toEqual(["/Projects/api"]);
  await expect(
    page.getByText("Folder path copied", { exact: true }),
  ).toBeVisible();
});

test("project context navigation preserves a settings draft until explicitly discarded", async ({
  page,
}) => {
  const settings = await settingsFixture(page);
  const name = settings.getByRole("textbox", {
    name: "Project name",
    exact: true,
  });
  await name.fill("Unsaved Orka name");
  const menu = await projectMenu(page, "Website");
  await menu
    .getByRole("menuitem", { name: "Project settings…", exact: true })
    .click();
  const guard = page.getByRole("dialog", {
    name: "Save your changes?",
    exact: true,
  });
  await expect(guard).toBeVisible();
  await guard.getByRole("button", { name: "Stay", exact: true }).click();
  await expect(name).toHaveValue("Unsaved Orka name");
  await expect(
    page.getByRole("combobox", { name: "Select project", exact: true }),
  ).toContainText("Orka");
  const retryMenu = await projectMenu(page, "Website");
  await retryMenu
    .getByRole("menuitem", { name: "Project settings…", exact: true })
    .click();
  await guard.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(name).toHaveValue("Website");
  expect(
    (await settingsCalls(page)).some((call) => call.args.action === "rename"),
  ).toBe(false);
});

test("saving before project context navigation writes the original project and opens the requested section", async ({
  page,
}) => {
  const settings = await settingsFixture(page);
  await settings
    .getByRole("combobox", { name: "Sessions sharing", exact: true })
    .click();
  await page
    .getByRole("option", { name: "Share automatically", exact: true })
    .click();
  const menu = await projectMenu(page, "Website");
  await menu.getByRole("menuitem", { name: "Members…", exact: true }).click();
  const guard = page.getByRole("dialog", {
    name: "Save your changes?",
    exact: true,
  });
  await guard.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    settings.getByRole("heading", { name: "Members", exact: true }),
  ).toBeVisible();
  expect(
    (await settingsCalls(page)).find((call) => call.args.action === "sharing")
      ?.args.input,
  ).toMatchObject({ projectId: "one", sharing: { session: true } });
  await settings.getByRole("button", { name: "General", exact: true }).click();
  await expect(
    settings.getByRole("textbox", { name: "Project name", exact: true }),
  ).toHaveValue("Website");
  await expect(
    page.getByRole("combobox", { name: "Select project", exact: true }),
  ).toContainText("Orka");
});

test("queued source changes disable disconnect through both menu entry points", async ({
  page,
}) => {
  const settings = await settingsFixture(page, { queued: true });
  const row = settings
    .locator(".settings-folder-row")
    .filter({ hasText: "orka" });
  const menu = page.getByRole("menu", {
    name: "Options for orka",
    exact: true,
  });
  await row.click({ button: "right" });
  await expect(
    menu.getByRole("menuitem", {
      name: "Disconnect folder on this Mac",
      exact: true,
    }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await settings
    .getByRole("button", { name: "Options for orka", exact: true })
    .click();
  await expect(
    menu.getByRole("menuitem", {
      name: "Disconnect folder on this Mac",
      exact: true,
    }),
  ).toBeDisabled();
  expect(
    (await settingsCalls(page)).filter(
      (call) => call.command === "disconnect_project_source",
    ),
  ).toHaveLength(0);
});

test("member context removal opens the existing confirmation without removing the member", async ({
  page,
}) => {
  const settings = await settingsFixture(page);
  await settings.getByRole("button", { name: "Members", exact: true }).click();
  const member = settings
    .locator(".settings-member-row")
    .filter({ hasText: "Jamie Rivera" });
  const menu = page.getByRole("menu", {
    name: "Actions for Jamie Rivera",
    exact: true,
  });
  await member.click({ button: "right" });
  const contextActions = await menu.getByRole("menuitem").allTextContents();
  await page.keyboard.press("Escape");
  await settings
    .getByRole("button", { name: "Actions for Jamie Rivera", exact: true })
    .click();
  expect(await menu.getByRole("menuitem").allTextContents()).toEqual(
    contextActions,
  );
  await menu
    .getByRole("menuitem", { name: "Remove Member", exact: true })
    .click();
  const confirmation = page.getByRole("dialog", {
    name: "Remove member?",
    exact: true,
  });
  await expect(confirmation).toBeVisible();
  expect(
    (await settingsCalls(page)).some(
      (call) => call.args.action === "remove-member",
    ),
  ).toBe(false);
  await confirmation.getByRole("button", { name: "Stay", exact: true }).click();
  await expect(member).toBeVisible();
});

test("member role cannot access owner context actions", async ({ page }) => {
  const settings = await settingsFixture(page, { role: "member" });
  await settings.getByRole("button", { name: "Members", exact: true }).click();
  const member = settings
    .locator(".settings-member-row")
    .filter({ hasText: "Jamie Rivera" });
  await expect(member).toHaveCount(1);
  await member.click({ button: "right" });
  await expect(
    page.getByRole("menuitem", {
      name: /Remove|Transfer ownership|Change role/,
    }),
  ).toHaveCount(0);
  await expect(
    settings.getByRole("button", {
      name: "Actions for Jamie Rivera",
      exact: true,
    }),
  ).toHaveCount(0);
});

test("owners archive and restore the project from the picker without changing the selected project", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 640 });
  await settingsFixture(page, { openSettings: false, websiteRole: "owner" });
  const picker = page.getByRole("combobox", { name: "Select project" });
  const menu = await projectMenu(page, "Website");
  const archive = menu.getByRole("menuitem", {
    name: "Archive project",
    exact: true,
  });
  await expect(archive).toBeInViewport();
  await archive.click();
  await expect(
    page.getByText("Project archived", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();

  await expect(picker).toContainText("Orka");
  await picker.click();
  const archived = page.getByRole("option", {
    name: /Website.*Archived by owner/,
  });
  await archived.press("Shift+F10");
  await expect(
    menu.getByRole("menuitem", { name: "Delete project…" }),
  ).toHaveCount(0);
  await menu
    .getByRole("menuitem", { name: "Restore project", exact: true })
    .click();
  await expect(
    page.getByText("Project restored", { exact: true }),
  ).toBeVisible();
  await expect(picker).toContainText("Orka");
  expect(
    (await settingsCalls(page))
      .filter((call) => ["archive", "restore"].includes(call.args.action))
      .map((call) => call.args),
  ).toEqual([
    {
      action: "archive",
      input: {
        projectId: "two",
        expectedRevision: 1,
        requestId: expect.any(String),
      },
    },
    {
      action: "restore",
      input: {
        projectId: "two",
        expectedRevision: 2,
        requestId: expect.any(String),
      },
    },
  ]);
});

test("delete confirms the clicked owner project by name and returns focus to the picker", async ({
  page,
}) => {
  await settingsFixture(page, { openSettings: false, websiteRole: "owner" });
  const picker = page.getByRole("combobox", { name: "Select project" });
  const openDelete = async () => {
    const menu = await projectMenu(page, "Website");
    const item = menu.getByRole("menuitem", { name: "Delete project…" });
    await expect(item).toBeInViewport();
    await item.click();
  };
  const dialog = page.getByRole("dialog", { name: "Delete project?" });
  const confirm = dialog.getByRole("button", {
    name: "Delete project",
    exact: true,
  });
  const field = dialog.getByRole("textbox", { name: "Project name" });
  await openDelete();
  await expect(dialog).toContainText("Website");
  await expect(dialog).toContainText(
    "This service keeps deleted projects for 7 days.",
  );
  await expect(field).toBeFocused();
  await field.fill("Orka");
  await expect(confirm).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(picker).toBeFocused();
  expect(
    (await settingsCalls(page)).some((call) => call.args.action === "delete"),
  ).toBe(false);

  await openDelete();
  await field.fill("Website");
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  await expect(picker).toBeFocused();
  await expect(picker).toContainText("Orka");
  expect(
    (await settingsCalls(page)).find((call) => call.args.action === "delete")
      ?.args.input,
  ).toMatchObject({
    projectId: "two",
    expectedRevision: 1,
    confirmation: "Website",
  });
});

for (const role of ["admin", "member"] as const) {
  test(`project lifecycle shortcuts are unavailable to an active or archived ${role}`, async ({
    page,
  }) => {
    await settingsFixture(page, {
      openSettings: false,
      role,
      archivedProjects: [
        {
          id: "archived",
          name: "Archived workspace",
          role,
          archivedAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    const picker = page.getByRole("combobox", { name: "Select project" });
    await picker.click({ button: "right" });
    const action = /Archive project|Delete project|Restore project/;
    const active = page.getByRole("menu", { name: "Actions for Orka" });
    await expect(
      active.getByRole("menuitem", { name: "Open project" }),
    ).toBeVisible();
    await expect(active.getByRole("menuitem", { name: action })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await picker.click();
    await page
      .getByRole("option", { name: /Archived workspace.*Archived by owner/ })
      .click({ button: "right" });
    const archived = page.getByRole("menu", {
      name: "Actions for Archived workspace",
    });
    await expect(
      archived.getByRole("menuitem", { name: "Open project" }),
    ).toBeVisible();
    await expect(archived.getByRole("menuitem", { name: action })).toHaveCount(
      0,
    );
  });
}

test("project deletion from the selected picker respects service compatibility", async ({
  page,
}) => {
  await settingsFixture(page, { openSettings: false, olderService: true });
  const picker = page.getByRole("combobox", { name: "Select project" });
  await picker.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete project…" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete project?" });
  await expect(dialog).toContainText(
    "Update this service to use recoverable project deletion.",
  );
  await dialog.getByRole("textbox", { name: "Project name" }).fill("Orka");
  await expect(
    dialog.getByRole("button", { name: "Delete project", exact: true }),
  ).toBeDisabled();
});

test("archiving from the picker respects the unsaved settings guard", async ({
  page,
}) => {
  const settings = await settingsFixture(page);
  const name = settings.getByRole("textbox", {
    name: "Project name",
    exact: true,
  });
  await name.fill("Unsaved project name");
  const menu = await projectMenu(page, "Orka");
  await menu
    .getByRole("menuitem", { name: "Archive project", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Save your changes?" })
    .getByRole("button", { name: "Stay" })
    .click();
  await expect(name).toHaveValue("Unsaved project name");
  expect(
    (await settingsCalls(page)).some((call) => call.args.action === "archive"),
  ).toBe(false);

  await (
    await projectMenu(page, "Orka")
  )
    .getByRole("menuitem", { name: "Archive project", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Save your changes?" })
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(
    page.getByText("Project archived", { exact: true }),
  ).toBeVisible();
  const calls = await settingsCalls(page);
  expect(
    calls
      .filter((call) => ["rename", "archive"].includes(call.args.action))
      .map((call) => call.args),
  ).toMatchObject([
    { action: "rename", input: { projectId: "one", expectedRevision: 1 } },
    { action: "archive", input: { projectId: "one", expectedRevision: 2 } },
  ]);
});

test("keyboard focus follows the choice made in the settings guard for delete", async ({
  page,
}) => {
  const settings = await settingsFixture(page, { websiteRole: "owner" });
  const picker = page.getByRole("combobox", { name: "Select project" });
  const name = settings.getByRole("textbox", {
    name: "Project name",
    exact: true,
  });
  await name.fill("Unsaved project name");
  const guard = page.getByRole("dialog", { name: "Save your changes?" });

  const openGuard = async (fromRow: boolean) => {
    if (fromRow) await picker.press("End");
    const target = fromRow
      ? page.getByRole("option", { name: "Website", exact: true })
      : picker;
    await target.press("Shift+F10");
    await page
      .getByRole("menuitem", { name: "Delete project…" })
      .press("Enter");
  };
  for (const fromRow of [false, true]) {
    await openGuard(fromRow);
    await guard
      .getByRole("button", { name: "Stay", exact: true })
      .press("Enter");
    await expect(guard).toHaveCount(0);
    await expect(picker).toBeFocused();
    await expect(name).toHaveValue("Unsaved project name");
  }

  await openGuard(true);
  await guard.getByRole("button", { name: "Save", exact: true }).press("Enter");
  const dialog = page.getByRole("dialog", { name: "Delete project?" });
  const confirmation = dialog.getByRole("textbox", { name: "Project name" });
  await expect(confirmation).toBeFocused();
  await page.keyboard.type("Website", { delay: 35 });
  await expect(confirmation).toHaveValue("Website");
  await expect(confirmation).toBeFocused();
  expect(
    (await settingsCalls(page)).some((call) => call.args.action === "delete"),
  ).toBe(false);
});
