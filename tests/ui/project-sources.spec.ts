import { ENV_ENABLED } from "../../apps/mac/src/lib/features.js";
import { test, expect, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

async function fixture(page: Page, names = ["desktop", "backend"]) {
  await page.addInitScript((names) => {
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    const repositories = [
      { id: "desktop", name: names[0], path: "/local/desktop" },
      { id: "backend", name: names[1], path: "/different/backend" },
    ];
    const resources = repositories.flatMap((source) =>
      ["memory", "skill", "session", "plan"].map((kind) => ({
        resourceId: `${kind}-${source.id}`,
        sourceId: source.id,
        projectId: "project",
        kind,
        source: "shared",
        logicalPath: "instructions/AGENTS.md",
        title: `${source.id} ${kind === "memory" ? "instructions" : kind}`,
        global: kind === "skill",
        files: [
          {
            path: kind === "skill" ? "SKILL.md" : "content.md",
            hash: "h",
            size: 5,
            executable: false,
          },
        ],
        deleted: false,
        revision: 1,
        owner: "user",
        updatedBy: "user",
        updatedAt: "2026-10-21T10:00:00Z",
      })),
    );
    Object.assign(window, {
      sourceCalls: calls,
      isTauri: true,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          if (command === "snapshot")
            return {
              user: "user",
              config: { apiUrl: "https://test.orka", syncMinutes: 15 },
              projects: [
                {
                  id: "project",
                  name: "Product",
                  role: "owner",
                  sources: repositories,
                },
                {
                  id: "other",
                  name: "Another project",
                  role: "owner",
                  sources: [
                    { id: "other-source", name: "other", path: "/local/other" },
                  ],
                },
              ],
              resources,
              bindings: [],
              conflicts: [],
              activity: [],
              outbox: [{ id: "queued", project: "project", error: null }],
              errors: [],
              sync: { online: true },
              daemon: { running: true },
              devices: [],
              deviceId: "mac",
              background: true,
            };
          if (command === "sync_progress")
            return { user: "user", progress: null };
          calls.push({ command, args });
          if (command === "plugin:dialog|open")
            return (args.options as { multiple?: boolean })?.multiple
              ? ["/new/desktop", "/new/backend"]
              : "/new";
          if (command === "scan_project_folders")
            return [
              { name: "desktop", path: "/new/desktop" },
              { name: "backend", path: "/new/backend" },
            ];
          if (command === "cloud_action") return { id: "created" };
          if (command === "inspect_resource")
            return { content: "Skill description", previous: null, paths: [] };
          if (command === "session_display_title") return null;
          if (command === "session_messages")
            return { messages: [], total: 0, offset: 0 };
          if (command === "project_skill_usage") return { counts: {} };
          if (command === "env_command") {
            if (args.action === "capabilities")
              return { supported: true, enabled: true };
            if (args.action === "list")
              return {
                sets: repositories.map((source) => ({
                  setId: `env-${source.id}`,
                  projectId: "project",
                  sourceId: source.id,
                  name: `${source.id} environment`,
                  creator: "user",
                  approved: true,
                  revision: 1,
                  accessRevision: 1,
                  grants: ["user"],
                  updatedAt: "2026-10-21T10:00:00Z",
                })),
                pending: [],
                members: [],
                device: { id: "mac" },
              };
            if (args.action === "import")
              return {
                draftId: "draft",
                projectId: "project",
                sourceId: (args.input as { sourceId: string }).sourceId,
                setId: "new",
                keys: ["API_URL"],
                revision: null,
                manifest: null,
              };
          }
          if (command.startsWith("plugin:")) return null;
          return {};
        },
      },
    });
  }, names);
  await page.goto("/");
  await expect(
    page.getByRole("combobox", { name: "Select project", exact: true }),
  ).toBeVisible();
}

const pickRepository = async (page: Page, name: string) => {
  await page.getByRole("button", { name: /^Filter/ }).click();
  await page.getByRole("menuitem", { name: "Repository" }).click();
  await page.getByRole("menuitemcheckbox", { name, exact: true }).click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
};

for (const viewport of [
  { width: 1160, height: 800 },
  { width: 900, height: 640 },
]) {
  test(`parent scan is reviewed before connecting folders at ${viewport.width}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await fixture(page);
    await page
      .getByRole("button", { name: "Add project", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("textbox", { name: "Project name" })
      .fill("Product workspace");
    await dialog.getByRole("button", { name: "Scan parent folder" }).click();
    const desktop = dialog.getByRole("checkbox", {
      name: /desktop.*\/new\/desktop/,
    });
    const backend = dialog.getByRole("checkbox", {
      name: /backend.*\/new\/backend/,
    });
    await expect(desktop).not.toBeChecked();
    await expect(backend).not.toBeChecked();
    await desktop.check();
    await backend.check();
    expect(
      (await new AxeBuilder({ page }).include('[role="dialog"]').analyze())
        .violations,
    ).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`source-scan-${viewport.width}.png`),
    });
    await dialog
      .getByRole("button", { name: "Create project", exact: true })
      .click();
    await expect(dialog).toBeHidden();
    const calls = await page.evaluate(
      () =>
        (
          window as unknown as {
            sourceCalls: { command: string; args: unknown }[];
          }
        ).sourceCalls,
    );
    expect(
      calls.find((call) => call.command === "connect_project_sources")?.args,
    ).toEqual({ id: "created", paths: ["/new/desktop", "/new/backend"] });
  });
}

test("repository filters distinguish same-path resources and remain clearable", async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole("button", { name: /^Memories/ }).click();
  const desktop = page.getByRole("row", { name: /desktop instructions/ });
  const backend = page.getByRole("row", { name: /backend instructions/ });
  await expect(desktop).toContainText("desktop");
  await expect(backend).toContainText("backend");
  await pickRepository(page, "backend");
  await expect(desktop).toHaveCount(0);
  await expect(backend).toBeVisible();
  const search = page.getByRole("searchbox", { name: "Search memories" });
  await search.fill("missing");
  await page.getByRole("button", { name: "Clear filters" }).click();
  await search.clear();
  await expect(page.getByRole("group", { name: "Active filters" })).toHaveCount(
    0,
  );
  await expect(desktop).toBeVisible();
  await expect(backend).toBeVisible();
});

for (const viewport of [
  { width: 1160, height: 800 },
  { width: 900, height: 640 },
]) {
  test(`repository context fits every collection at ${viewport.width}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const longName = "orka-desktop-with-a-very-long-repository-name";
    await fixture(page, [longName, "orka-api"]);
    const header = page.locator(".workspace-header");
    const filter = header.getByRole("combobox", {
      name: "Filter by repository",
    });
    await expect(filter).toHaveCount(0);
    for (const [tab, kind] of [
      ["Memories", "memory"],
      ["Skills", "skill"],
      ["Plans", "plan"],
      ["Sessions", "session"],
      ...(ENV_ENABLED ? [["ENVs", "env"]] : []),
    ]) {
      await page.getByRole("button", { name: new RegExp(`^${tab}`) }).click();
      // Collections filter by repository inside their own Filter menu.
      await expect(
        page.getByRole("combobox", { name: /Filter.*repository/ }),
      ).toHaveCount(kind === "env" ? 1 : 0);
      if (kind === "env") {
        await expect(page.locator(".env-list-item")).toHaveCount(2);
      } else {
        const row = page.locator(".skill-table tbody tr", {
          has: page.locator(`[data-resource-id="${kind}-desktop"]`),
        });
        await expect(
          row.locator(".skill-table-repository-label"),
        ).toHaveAttribute("title", longName);
        await page.getByRole("button", { name: "Filter", exact: true }).click();
        await page.getByRole("menuitem", { name: "Repository" }).click();
        await expect(
          page.getByRole("menuitemcheckbox", { name: longName, exact: true }),
        ).toBeVisible();
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");
        if (kind === "skill") {
          await row.hover();
          await expect(row.getByRole("tooltip")).toContainText(
            "From your global skills",
          );
        }
      }
      await page.screenshot({
        path: testInfo.outputPath(`${kind}-${viewport.width}.png`),
      });
      // The index tables check the label and its title above.
      if (kind === "env") {
        const overflowing = await page
          .locator(".resource-repository")
          .filter({ hasText: longName })
          .first()
          .evaluate((el) => ({
            text: el.lastElementChild!.scrollWidth,
            width: el.lastElementChild!.clientWidth,
          }));
        expect(overflowing.text).toBeGreaterThan(overflowing.width);
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
      ).toBe(false);
      expect(
        (await new AxeBuilder({ page }).include("main").analyze()).violations,
      ).toEqual([]);
    }
    // Only ENVs keep the header repository picker.
    if (!ENV_ENABLED) return;
    const geometry = await header.evaluate((el) => {
      const filter = el.querySelector(".workspace-repository-filter")!,
        status = el.querySelector(".sync-status")!;
      return {
        filterHeight: filter.getBoundingClientRect().height,
        filterWidth: filter.getBoundingClientRect().width,
        filterChevron: filter.lastElementChild!.getBoundingClientRect().right,
        statusHeight: status.getBoundingClientRect().height,
        filterRadius: getComputedStyle(filter).borderRadius,
        statusRadius: getComputedStyle(status).borderRadius,
        filterRight: filter.getBoundingClientRect().right,
        statusLeft: status.getBoundingClientRect().left,
      };
    });
    expect(geometry.filterHeight).toBe(32);
    expect(geometry.statusHeight).toBe(32);
    expect(geometry.filterRadius).toBe(geometry.statusRadius);
    expect(geometry.filterRight).toBeLessThan(geometry.statusLeft);
    await expect(header.locator(".sync-status-label")).toHaveText("Pending");
    await expect(header.locator(".sync-status")).toHaveAttribute(
      "aria-label",
      "Changes pending",
    );
    await filter.click();
    await expect(
      page.getByRole("option", { name: longName, exact: true }),
    ).toHaveAttribute("title", longName);
    await page.screenshot({
      path: testInfo.outputPath(`repository-menu-${viewport.width}.png`),
    });
    expect(
      (await new AxeBuilder({ page }).include('[role="listbox"]').analyze())
        .violations,
    ).toEqual([]);
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await expect(filter).toHaveText("orka-api");
    const after = await filter.evaluate((control) => ({
      right: control.getBoundingClientRect().right,
      width: control.getBoundingClientRect().width,
      chevron: control.lastElementChild!.getBoundingClientRect().right,
    }));
    expect(after).toEqual({
      right: geometry.filterRight,
      width: geometry.filterWidth,
      chevron: geometry.filterChevron,
    });
    if (viewport.width === 900) {
      await header
        .getByRole("button", { name: "Collapse sidebar" })
        .press("Enter");
      await filter.click();
      await page.getByRole("option", { name: longName, exact: true }).click();
      await expect(filter).toHaveAttribute("title", longName);
      expect((await filter.boundingBox())?.width).toBe(geometry.filterWidth);
    }
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(filter).toHaveCount(0);
  });
}

test("each collection keeps its own repository pick until the project changes", async ({
  page,
}) => {
  await fixture(page);
  const rows = page.locator("tbody tr");
  await page.getByRole("button", { name: /^Memories/ }).click();
  await pickRepository(page, "backend");
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("backend");
  for (const tab of ["Skills", "Sessions", "Plans"]) {
    await page.getByRole("button", { name: new RegExp(`^${tab}`) }).click();
    await expect(rows).toHaveCount(2);
  }
  await page.getByRole("button", { name: /^Memories/ }).click();
  await expect(rows).toHaveCount(1);
  await page
    .getByRole("combobox", { name: "Select project", exact: true })
    .click();
  await page
    .getByRole("option", { name: "Another project", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Select project", exact: true })
    .click();
  await page.getByRole("option", { name: "Product", exact: true }).click();
  await page.getByRole("button", { name: /^Memories/ }).click();
  await expect(rows).toHaveCount(2);
  await expect(page.getByRole("group", { name: "Active filters" })).toHaveCount(
    0,
  );
});

test("duplicate repository names stay distinguishable in the custom picker", async ({
  page,
}) => {
  await fixture(page, ["orka", "orka"]);
  await page.getByRole("button", { name: /^Memories/ }).click();
  await page.getByRole("button", { name: /^Filter/ }).click();
  await page.getByRole("menuitem", { name: "Repository" }).click();
  await expect(
    page.getByRole("menuitemcheckbox", { name: "orka · deskto", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await pickRepository(page, "orka · backen");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr")).toContainText("backend instructions");
});

test("Home can open a resource outside the previous repository selection", async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole("button", { name: /^Memories/ }).click();
  await pickRepository(page, "backend");
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page.locator('[data-resource-id="memory-desktop"]').click();
  await expect(page.locator(".resource-detail h2").first()).toHaveText(
    "desktop instructions",
  );
  await page.getByRole("button", { name: "Back to Memories" }).click();
  // The page keeps its own filter; the item opened from Home is outside it.
  await expect(
    page.getByRole("group", { name: "Active filters" }),
  ).toContainText("backend");
  await expect(
    page.getByRole("searchbox", { name: "Search memories" }),
  ).toBeFocused();
});

test("ENV repository filtering keeps an unpublished draft and hides other set details", async ({
  page,
}) => {
  test.skip(!ENV_ENABLED, "ENV support is temporarily disabled");
  await fixture(page);
  await page.getByRole("button", { name: "ENVs", exact: true }).click();
  await page.getByRole("button", { name: /desktop environment/ }).click();
  await expect(page.locator(".env-detail h2")).toHaveText(
    "desktop environment",
  );
  const filter = page.getByRole("combobox", { name: "Filter by repository" });
  await filter.click();
  await page.getByRole("option", { name: "backend", exact: true }).click();
  await expect(page.locator(".env-detail h2")).toHaveText("Choose an ENV set");
  await page.getByRole("button", { name: "New ENV set", exact: true }).click();
  await expect(page.getByRole("dialog").getByLabel("Repository")).toHaveValue(
    "backend",
  );
  await page
    .getByLabel("ENV assignments", { exact: true })
    .fill("API_URL=https://example.test");
  await page.getByRole("button", { name: "Review keys", exact: true }).click();
  await expect(page.locator(".env-draft-item")).toContainText("backend");
  await filter.click();
  await page.getByRole("option", { name: "desktop", exact: true }).click();
  await expect(page.locator(".env-draft-item")).toContainText("backend");
  await expect(page.locator(".env-detail")).toContainText("API_URL");
  const commands = await page.evaluate(
    () =>
      (
        window as unknown as {
          sourceCalls: { command: string; args: { action?: string } }[];
        }
      ).sourceCalls,
  );
  expect(
    commands.filter(
      (c) => c.command === "env_command" && c.args.action === "discard",
    ),
  ).toHaveLength(0);
});
