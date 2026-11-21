import { test, expect, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

async function fixture(page: Page, mode = "normal") {
  await page.addInitScript((mode) => {
    const calls: { name: string; args?: Record<string, unknown> }[] = [];
    let scanCount = 0;
    let addCount = 0;
    let removedDestination = false;
    let usageCount = 0;
    let projectUsageCount = 0;
    let added = false;
    let published = false;
    const imported = {
      resourceId: "codex",
      projectId: "one",
      kind: "skill",
      source: "shared",
      title: "review",
      logicalPath: "review",
      revision: 0,
      global: true,
      deleted: false,
      owner: "user",
      updatedBy: "user",
      updatedAt: "2026-10-21T00:00:00Z",
      files: [
        { path: "SKILL.md", hash: "codex", size: 100, executable: false },
      ],
    };
    const skills = [
      {
        id: "codex",
        name: "review",
        sources: ["codex"],
        markdown:
          "---\nname: Code review\ndescription: Review changes with supporting scripts and references.\n---\n# Review",
        fileCount: 3,
      },
      {
        id: "claude",
        name: "writing",
        sources: ["claude"],
        markdown:
          "---\nname: Writing guide\ndescription: Write clear product copy.\n---\n# Writing",
        fileCount: 1,
      },
      {
        id: "duplicate",
        name: "existing",
        sources: ["codex", "claude"],
        markdown: "# Existing skill",
        fileCount: 1,
        exists: true,
      },
      {
        id: "unsafe",
        name: "unsafe",
        sources: ["claude"],
        markdown: "",
        fileCount: 0,
        error: "Package contains symlink",
      },
      ...Array.from({ length: 20 }, (_, i) => ({
        id: `extra-${i}`,
        name: `extra-${i}`,
        sources: ["codex"],
        markdown: `---\nname: Extra skill ${i}\n---\n# Extra`,
        fileCount: 1,
      })),
    ].map((skill) => ({
      exists: false,
      error: null,
      ...skill,
      path: `/Users/test/.${skill.sources[0]}/skills/${skill.name}`,
    }));
    Object.assign(window, {
      invokeCalls: calls,
      isTauri: true,
      removeSkillDestination: () => {
        removedDestination = true;
      },
      publishSkill: () => {
        published = true;
      },
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: async (name: string, args?: Record<string, unknown>) => {
          calls.push({ name, args });
          if (name === "snapshot")
            return {
              user: "user",
              config: { apiUrl: "https://test.local", syncMinutes: 15 },
              projects: [
                {
                  id: "one",
                  name: "Orka",
                  path: mode === "disconnected" ? null : "/test/orka",
                  role: "owner",
                  governed: mode === "governed" || mode === "approval",
                  ...(mode === "repositories"
                    ? {
                        sources: [
                          {
                            id: "desktop",
                            name: "orka-platform-infrastructure",
                            path: "/test/desktop",
                          },
                          {
                            id: "backend",
                            name: "orka-platform-infrastructure",
                            path: "/test/backend",
                            removedAt: removedDestination
                              ? "2026-11-20T00:00:00Z"
                              : undefined,
                          },
                          { id: "other", name: "Disconnected repository" },
                          {
                            id: "removed",
                            name: "Removed repository",
                            path: "/test/removed",
                            removedAt: "2026-10-21T00:00:00Z",
                          },
                        ],
                      }
                    : {}),
                },
                ...(mode === "project-scope"
                  ? [
                      {
                        id: "two",
                        name: "Studio",
                        path: "/test/studio",
                        role: "owner",
                      },
                    ]
                  : []),
              ],
              resources:
                mode === "populated" || mode.startsWith("project-")
                  ? skills
                      .map((skill) => ({
                        resourceId: skill.id,
                        projectId: "one",
                        kind: "skill",
                        source: skill.sources[0],
                        title: skill.name,
                        logicalPath: skill.name,
                        revision: 1,
                        deleted: false,
                        owner: "user",
                        updatedBy: "user",
                        updatedAt: "2026-10-21T00:00:00Z",
                        files: [
                          {
                            path: "SKILL.md",
                            hash: skill.id,
                            size: 100,
                            executable: false,
                          },
                        ],
                      }))
                      .flatMap((skill) =>
                        mode === "project-scope"
                          ? [
                              skill,
                              {
                                ...skill,
                                projectId: "two",
                                resourceId: `two-${skill.resourceId}`,
                              },
                            ]
                          : [skill],
                      )
                  : mode === "local-deleted"
                    ? [{ ...imported, revision: 10, deleted: true, files: [] }]
                    : published
                      ? [{ ...imported, revision: 1 }]
                      : [],
              localSkills:
                ((mode === "governed" || mode === "bulk-partial") && added) ||
                mode === "local" ||
                mode === "local-deleted" ||
                ["approval", "paused", "blocked"].includes(mode)
                  ? [
                      {
                        ...imported,
                        local: true,
                        sharing:
                          mode === "governed"
                            ? "queued"
                            : ["approval", "paused", "blocked"].includes(mode)
                              ? mode
                              : undefined,
                      },
                    ]
                  : [],
              drafts:
                mode === "governed" && added
                  ? [
                      {
                        id: "automatic-draft",
                        projectId: "one",
                        resource: imported,
                        status: "local",
                        automaticSharing: true,
                        createdAt: imported.updatedAt,
                      },
                    ]
                  : [],
              bindings: [],
              conflicts: [],
              activity: [],
              outbox: [],
              errors: [],
              sync: { online: false },
              daemon: { running: false },
              devices: [],
              deviceId: "device",
              background: false,
            };
          if (name === "scan_global_skills") {
            scanCount += 1;
            if (mode === "retry" && scanCount === 1)
              throw "Folder access failed";
            if (mode === "loading" && scanCount === 1)
              await new Promise<void>((resolve) => {
                (window as any).finishSkillScan = resolve;
              });
            if (mode === "held-scan")
              await new Promise<void>((resolve) => {
                (window as any).finishSkillScan = resolve;
              });
            return {
              skills:
                mode === "empty"
                  ? []
                  : skills
                      // Its folder was removed after the first scan.
                      .filter(
                        (skill) =>
                          !(
                            mode === "bulk-gone" &&
                            addCount > 0 &&
                            skill.id === "claude"
                          ),
                      )
                      .map((skill) => ({
                        ...skill,
                        exists: skill.exists || (added && skill.id === "codex"),
                        error:
                          mode === "bulk-invalid" &&
                          addCount &&
                          skill.id === "claude"
                            ? "Package contains symlink"
                            : skill.error,
                      })),
              errors:
                mode === "partial"
                  ? [
                      "Cannot scan /Users/test/.claude/skills: permission denied",
                    ]
                  : [],
              usage: mode.startsWith("usage-")
                ? {
                    counts:
                      mode === "usage-empty-cache" && usageCount === 0
                        ? {}
                        : { claude: 12, codex: 8 },
                    partial: false,
                  }
                : undefined,
            };
          }
          if (name === "global_skill_usage") {
            usageCount += 1;
            const usage = {
              counts: mode.startsWith("usage-")
                ? { "extra-0": 15, claude: 12, codex: 8 }
                : {},
              partial: false,
            };
            if (mode === "usage-error" && usageCount === 1)
              throw "History unreadable";
            if (mode === "usage-loading" || mode === "usage-empty-cache")
              return new Promise((resolve) => {
                (window as any).resolveSkillUsage = () => resolve(usage);
              });
            return usage;
          }
          if (name === "project_skill_usage") {
            projectUsageCount += 1;
            const second = args?.projectId === "two";
            const usage = {
              counts: Object.fromEntries(
                skills.map((skill) => [
                  `${second ? "two-" : ""}${skill.id}`,
                  second
                    ? 2
                    : skill.id === "claude"
                      ? 12
                      : skill.id === "codex"
                        ? 8
                        : 0,
                ]),
              ),
              partial: mode === "project-partial",
            };
            if (mode === "project-error" && projectUsageCount === 1)
              throw "History unreadable";
            if (
              (mode === "project-loading" || mode === "project-scope") &&
              !second
            )
              return new Promise((resolve) => {
                (window as any).resolveProjectUsage = () => resolve(usage);
              });
            return usage;
          }
          if (name === "add_global_skill") {
            if (mode === "add-error") throw "Project folder is unavailable";
            if (mode === "add-wait")
              await new Promise<void>((resolve) => {
                (window as any).finishSkillImport = resolve;
              });
            await new Promise((resolve) => setTimeout(resolve, 100));
            added = true;
            return {
              resourceId: "imported",
              status: "queued",
            };
          }
          if (name === "add_global_skills") {
            if (mode === "add-error") throw "Project folder is unavailable";
            if (mode === "add-wait")
              await new Promise<void>((resolve) => {
                (window as any).finishSkillImport = resolve;
              });
            addCount += 1;
            const results = (args?.skillIds as string[]).map((skillId) =>
              ["bulk-partial", "bulk-gone", "bulk-invalid"].includes(mode) &&
              addCount === 1 &&
              skillId === "claude"
                ? { skillId, error: "Global skill unavailable. Scan again." }
                : mode === "bulk-dead" && skillId === "claude"
                  ? {
                      skillId,
                      error:
                        "A skill with this folder name is already in the project. Existing files were preserved.",
                    }
                  : { skillId, result: { status: "queued" } },
            );
            added ||= results.some(
              (result) => result.skillId === "codex" && result.result,
            );
            return { results };
          }
          if (name === "inspect_resource")
            return {
              content:
                skills.find((skill) => skill.id === args?.id)?.markdown ??
                "# Skill",
              previous: null,
              paths: [],
            };
          if (name === "governance_command")
            return {
              owner: true,
              governed: true,
              policyRevision: 1,
              policy: {},
              access: {},
              members: [],
              memberRules: [],
              resourceCount: 0,
              requests: [],
            };
          if (name.startsWith("plugin:")) return null;
          return {};
        },
      },
    });
  }, mode);
  await page.goto("/");
  await page.getByRole("button", { name: /^Skills/ }).click();
}

const trigger = (page: Page) =>
  page.getByRole("button", { name: /^Add (global )?skills$/i });
const popover = (page: Page) =>
  page.getByRole("dialog", { name: "Add global skills", exact: true });
const pick = (page: Page, name: string) =>
  popover(page).getByRole("checkbox", {
    name: `Select skill: ${name}`,
    exact: true,
  });
const rows = (page: Page) => page.locator(".skill-table tbody tr");
const calls = (page: Page, name: string) =>
  page.evaluate(
    (name) =>
      (window as any).invokeCalls.filter((call: any) => call.name === name),
    name,
  );

for (const viewport of [
  { width: 1160, height: 800 },
  { width: 900, height: 640 },
]) {
  test(`the Add skills popover lists only what can be added at ${viewport.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await fixture(page, "populated");
    await trigger(page).click();
    const dialog = popover(page);
    await expect(pick(page, "Code review")).toBeVisible();
    await expect(pick(page, "Writing guide")).toBeVisible();
    // Skills already in the project, or that cannot be read, stay hidden.
    await expect(pick(page, "existing")).toHaveCount(0);
    await expect(pick(page, "unsafe")).toHaveCount(0);
    await expect(dialog.getByText("22 global skills")).toBeVisible();
    const add = dialog.getByRole("button", { name: "Add skills", exact: true });
    await expect(add).toBeDisabled();
    await pick(page, "Code review").check();
    await expect(
      dialog.getByRole("button", { name: "Add 1 skill", exact: true }),
    ).toBeEnabled();
    const box = (await dialog.boundingBox())!;
    expect(box.width).toBe(380);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({
      path: `artifacts/add-skills-${viewport.width}.png`,
    });
  });
}

test("search matches names and reveals skills that cannot be added", async ({
  page,
}) => {
  await fixture(page);
  await trigger(page).click();
  const dialog = popover(page);
  const search = dialog.getByRole("searchbox", {
    name: "Search global skills",
  });
  await expect(search).toBeFocused();
  // Descriptions are not searched.
  await search.fill("supporting scripts");
  await expect(dialog.getByText("No global skills match")).toBeVisible();
  await dialog.getByRole("button", { name: "Clear search" }).last().click();
  await search.fill("exist");
  const hidden = pick(page, "existing");
  await expect(hidden).toBeDisabled();
  await expect(dialog.getByText("Already in project")).toBeVisible();
  await search.fill("unsafe");
  await expect(pick(page, "unsafe")).toBeDisabled();
  await expect(dialog.getByText("Can’t be added")).toBeVisible();
  await search.fill("guide");
  await expect(dialog.getByText("1 of 22 match")).toBeVisible();
});

test("the picker ranks cached usage first and applies a fresh ranking", async ({
  page,
}) => {
  await fixture(page, "usage-loading");
  await trigger(page).click();
  const dialog = popover(page);
  const names = dialog.locator(".add-skills-name");
  await expect(names.nth(0)).toHaveText("Writing guide");
  await expect(names.nth(1)).toHaveText("Code review");
  await expect(names.nth(2)).toHaveText("Extra skill 0");
  await expect.poll(() => calls(page, "global_skill_usage")).toHaveLength(1);
  await page.evaluate(() => (window as any).resolveSkillUsage());
  await expect(names.nth(0)).toHaveText("Extra skill 0");
  await expect(names.nth(1)).toHaveText("Writing guide");
  await pick(page, "Writing guide").focus();
  await expect(dialog.getByRole("tooltip")).toContainText(
    "Detected in 12 chats",
  );
});

test("the picker keeps keyboard focus and selection when history finishes loading", async ({
  page,
}) => {
  await fixture(page, "usage-empty-cache");
  await trigger(page).click();
  const dialog = popover(page);
  const names = dialog.locator(".add-skills-name");
  await expect(names.nth(0)).toHaveText("Code review");
  const skill = pick(page, "Code review");
  await skill.focus();
  await page.keyboard.press("Space");
  await expect.poll(() => calls(page, "global_skill_usage")).toHaveLength(1);
  await page.evaluate(async () => {
    (window as any).resolveSkillUsage();
    await new Promise(requestAnimationFrame);
  });
  await expect(names.nth(0)).toHaveText("Code review");
  await expect(skill).toBeFocused();
  await expect(skill).toBeChecked();
});

test("a history refresh failure leaves the saved ranking usable", async ({
  page,
}) => {
  await fixture(page, "usage-error");
  await trigger(page).click();
  const dialog = popover(page);
  await expect(dialog.locator(".add-skills-name").first()).toHaveText(
    "Writing guide",
  );
  await expect.poll(() => calls(page, "global_skill_usage")).toHaveLength(1);
  await pick(page, "Writing guide").check();
  await expect(
    dialog.getByRole("button", { name: "Add 1 skill" }),
  ).toBeEnabled();
});

test("hover and focus open a skill's details beside the popover", async ({
  page,
}) => {
  await fixture(page);
  await trigger(page).click();
  const dialog = popover(page);
  await dialog.locator(".add-skills-row", { hasText: "Code review" }).hover();
  const peek = dialog.getByRole("tooltip");
  await expect(peek).toContainText("Code review");
  await expect(peek).toContainText(
    "Review changes with supporting scripts and references.",
  );
  await expect(peek).toContainText("3 files");
  const [peekBox, dialogBox] = [
    (await peek.boundingBox())!,
    (await dialog.boundingBox())!,
  ];
  expect(peekBox.x + peekBox.width).toBeLessThan(dialogBox.x);
  await page.mouse.move(0, 0);
  await expect(peek).toHaveCount(0);
});

test("scan errors can be retried and partial results keep healthy skills usable", async ({
  page,
}) => {
  await fixture(page, "retry");
  await trigger(page).click();
  const dialog = popover(page);
  await expect(
    dialog.getByRole("heading", { name: "Couldn’t read your global skills" }),
  ).toBeVisible();
  await expect(dialog.getByText("Folder access failed")).toBeVisible();
  await dialog.getByRole("button", { name: "Try again" }).click();
  await expect(pick(page, "Code review")).toBeVisible();
  await fixture(page, "partial");
  await trigger(page).click();
  await expect(
    popover(page).getByText(/Cannot scan.*permission denied/),
  ).toBeVisible();
  await expect(pick(page, "Code review")).toBeEnabled();
});

for (const viewport of [
  { width: 1160, height: 800 },
  { width: 900, height: 640 },
]) {
  test(`added skills appear in the table and open before sharing at ${viewport.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await fixture(page, "governed");
    await trigger(page).click();
    await pick(page, "Code review").check();
    await popover(page)
      .getByRole("button", { name: "Add 1 skill", exact: true })
      .click();
    // The popover closes and a toast says where the skill went.
    await expect(popover(page)).toBeHidden();
    await expect(page.getByText("Code review added to Orka")).toBeVisible();
    await expect(rows(page)).toHaveCount(1);
    const row = rows(page).first();
    await expect(row).toContainText("Code review");
    await expect(row).toContainText("Sharing queued");
    await expect(row.getByLabel("On this Mac")).toBeVisible();
    // Everything here is yours, so there is nobody to credit.
    await expect(
      page.getByRole("columnheader", { name: "Shared by" }),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Skills/ })).toContainText(
      "1",
    );
    expect(
      (await new AxeBuilder({ page }).include(".resource-index").analyze())
        .violations,
    ).toEqual([]);
    await page.screenshot({
      path: `artifacts/local-skills-${viewport.width}.png`,
    });
    await row.getByRole("button", { name: "Code review", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Code review", exact: true }),
    ).toBeVisible();
    await expect(
      page.locator(".detail-title-card .skill-origin-badge"),
    ).toHaveText("Global");
    await expect(
      page.getByText(
        "This skill will share automatically when permissions allow. Sync retries while offline.",
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("article", { name: "Rendered Markdown" }),
    ).toContainText("Review");
    await expect(
      page.getByRole("button", { name: "Open in editor", exact: true }),
    ).toBeEnabled();
    await page.evaluate(() => (window as any).publishSkill());
    await page
      .getByRole("button", { name: "Back to Skills", exact: true })
      .click();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).not.toContainText("Sharing queued");
    expect(
      (await calls(page, "governance_command")).filter((call: any) =>
        ["submit-draft", "decide"].includes(call.args?.action),
      ),
    ).toHaveLength(0);
  });
}

test("a skill's description opens on hover and marks global imports", async ({
  page,
}) => {
  await fixture(page, "local");
  const row = rows(page).first();
  await row.hover();
  const peek = row.getByRole("tooltip");
  await expect(peek).toContainText("Imported from your global skills");
});

test("local-only skills stay visible and a shared revision replaces the local row", async ({
  page,
}) => {
  await fixture(page, "local");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).getByLabel("On this Mac")).toBeVisible();
  await rows(page)
    .getByRole("button", { name: "Code review", exact: true })
    .click();
  await expect(
    page.getByText("This skill is on this Mac and hasn’t been shared."),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Back to Skills", exact: true })
    .click();
  await page.evaluate(() => (window as any).publishSkill());
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).getByLabel("On this Mac")).toHaveCount(0);
  await expect(rows(page).getByLabel("Shared with the project")).toBeVisible();
});

test("a new local import remains visible over an older shared deletion", async ({
  page,
}) => {
  await fixture(page, "local-deleted");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText("Code review");
  await expect(rows(page).getByLabel("On this Mac")).toBeVisible();
  await rows(page)
    .getByRole("button", { name: "Code review", exact: true })
    .click();
  await expect(
    page.getByRole("article", { name: "Rendered Markdown" }),
  ).toContainText("Review");
});

test("without a folder the popover offers to connect one; an empty scan says so", async ({
  page,
}) => {
  await fixture(page, "disconnected");
  await trigger(page).click();
  await expect(
    popover(page).getByRole("heading", { name: "Connect a folder first" }),
  ).toBeVisible();
  await expect(
    popover(page).getByRole("button", { name: "Connect folder" }),
  ).toBeEnabled();
  expect(await calls(page, "scan_global_skills")).toHaveLength(0);
  // The button opens the macOS folder picker; cancelling it changes nothing.
  await popover(page).getByRole("button", { name: "Connect folder" }).click();
  await expect
    .poll(async () => (await calls(page, "plugin:dialog|open")).length)
    .toBe(1);
  await expect(
    popover(page).getByRole("heading", { name: "Connect a folder first" }),
  ).toBeVisible();
  await fixture(page, "empty");
  await trigger(page).click();
  await expect(
    popover(page).getByRole("heading", { name: "Nothing to add" }),
  ).toBeVisible();
  await expect(
    popover(page).getByText(
      "No global skills were found in Codex or Claude on this Mac.",
    ),
  ).toBeVisible();
});

test("a failed add keeps the selection and offers Try again", async ({
  page,
}) => {
  await fixture(page, "add-error");
  await trigger(page).click();
  const dialog = popover(page);
  await pick(page, "Code review").check();
  await dialog
    .getByRole("button", { name: "Add 1 skill", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Couldn’t add 1 skill.",
  );
  await expect(dialog.getByRole("alert")).toContainText(
    "Project folder is unavailable",
  );
  await expect(pick(page, "Code review")).toBeChecked();
  await expect(
    dialog.getByRole("button", { name: "Try again", exact: true }),
  ).toBeEnabled();
});

test("adding locks the popover until the one request finishes", async ({
  page,
}) => {
  await fixture(page, "add-wait");
  const plans = page.getByRole("button", { name: /^Plans/ });
  const plansBounds = (await plans.boundingBox())!;
  await trigger(page).click();
  const dialog = popover(page);
  await pick(page, "Code review").check();
  await pick(page, "Writing guide").check();
  await dialog
    .getByRole("button", { name: "Add 2 skills", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Adding…", exact: true }),
  ).toBeDisabled();
  await expect(pick(page, "Code review")).toBeDisabled();
  await expect(
    dialog.getByRole("searchbox", { name: "Search global skills" }),
  ).toBeDisabled();
  // Keyboard and pointer interaction keep the user in the picker mid-add.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Tab");
  await expect(dialog).toBeFocused();
  await page.mouse.click(
    plansBounds.x + plansBounds.width / 2,
    plansBounds.y + plansBounds.height / 2,
  );
  await expect(dialog).toBeVisible();
  await page.evaluate(() => (window as any).finishSkillImport());
  await expect(dialog).toBeHidden();
  await expect(page.getByText("2 skills added to Orka")).toBeVisible();
  expect(await calls(page, "add_global_skills")).toHaveLength(1);
  expect(await calls(page, "add_global_skill")).toHaveLength(0);
  await plans.click();
  await expect(
    page.getByRole("heading", { name: "Plans", exact: true }),
  ).toBeVisible();
});

test("Add skills stays in the toolbar while the Skills list scrolls", async ({
  page,
}) => {
  await fixture(page, "populated");
  await expect(rows(page)).toHaveCount(24);
  const before = await trigger(page).boundingBox();
  const list = page.locator(".resource-index-body");
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  expect(await list.evaluate((element) => element.scrollTop)).toBeGreaterThan(
    0,
  );
  expect(await trigger(page).boundingBox()).toEqual(before);
  await trigger(page).click();
  await expect(pick(page, "Code review")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^Memories/ }).click();
  await expect(trigger(page)).toHaveCount(0);
});

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`a held scan shows placeholders, can be closed, and every open scans again with ${reducedMotion} motion`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion });
    await page.setViewportSize({ width: 900, height: 640 });
    await fixture(page, "loading");
    await trigger(page).click();
    const dialog = popover(page);
    await expect(
      dialog.getByText("Reading your global skills…"),
    ).toBeAttached();
    await expect(
      dialog.getByRole("list", { name: "Global skills" }),
    ).toHaveCount(0);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger(page)).toBeFocused();
    await trigger(page).click();
    await expect(pick(page, "Code review")).toBeVisible();
    await page.evaluate(() => (window as any).finishSkillScan());
    expect(await calls(page, "scan_global_skills")).toHaveLength(2);
    expect(await calls(page, "add_global_skills")).toHaveLength(0);
  });
}

test("first approval keeps one status pill and the local editor action", async ({
  page,
}) => {
  await fixture(page, "approval");
  await expect(rows(page).locator(".skill-status-pill")).toHaveText([
    "Awaiting approval",
  ]);
  await rows(page)
    .getByRole("button", { name: "Code review", exact: true })
    .click();
  const detail = page.getByRole("region", { name: "Skill details" });
  const info = detail.getByRole("region", { name: "Skill info", exact: true });
  await expect(detail.locator(".detail-status")).toHaveText([
    "Awaiting approval",
  ]);
  await expect(info.locator(".detail-actions").getByRole("button")).toHaveText([
    "Open in editor",
  ]);
  await info
    .getByRole("button", { name: "Open in editor", exact: true })
    .click();
  expect(
    (await calls(page, "open_editor")).map((call: any) => call.args),
  ).toEqual([{ id: "codex", file: "SKILL.md" }]);
});

for (const mode of ["paused", "blocked"]) {
  test(`import sharing ${mode} has clear status`, async ({ page }) => {
    await fixture(page, mode);
    await expect(rows(page).locator(".skill-status-pill")).toHaveText([
      mode === "paused" ? "Sharing paused" : "Sharing blocked",
    ]);
    await rows(page)
      .getByRole("button", { name: "Code review", exact: true })
      .click();
    await expect(
      page.getByText(
        mode === "paused"
          ? "Skills sharing is off on this Mac. The import will resume when sharing is enabled."
          : "This skill is on this Mac. Check the sync issue before retrying sharing.",
      ),
    ).toBeVisible();
  });
}

test("Select all follows the search and only ticked skills are added", async ({
  page,
}) => {
  await fixture(page);
  await trigger(page).click();
  const dialog = popover(page);
  const all = dialog.getByRole("checkbox", { name: "Select all" });
  await pick(page, "Writing guide").check();
  await expect(all).toHaveJSProperty("indeterminate", true);
  await dialog
    .getByRole("searchbox", { name: "Search global skills" })
    .fill("review");
  await all.check();
  await dialog
    .getByRole("searchbox", { name: "Search global skills" })
    .fill("");
  // The earlier pick survived the search, and nothing hidden was ticked.
  await expect(pick(page, "Writing guide")).toBeChecked();
  await expect(pick(page, "Code review")).toBeChecked();
  await expect(pick(page, "Extra skill 0")).not.toBeChecked();
  await dialog
    .getByRole("button", { name: "Add 2 skills", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  expect((await calls(page, "add_global_skills"))[0].args).toEqual({
    projectId: "one",
    sourceId: undefined,
    skillIds: ["codex", "claude"],
  });
});

test("the keyboard moves through rows, ticks with Space, and adds with Return", async ({
  page,
}) => {
  await fixture(page);
  await trigger(page).click();
  const dialog = popover(page);
  await pick(page, "Code review").focus();
  await page.keyboard.press("Space");
  await expect(pick(page, "Code review")).toBeChecked();
  await page.keyboard.press("ArrowDown");
  await expect(
    dialog
      .getByRole("list", { name: "Global skills" })
      .getByRole("checkbox")
      .nth(1),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  expect((await calls(page, "add_global_skills"))[0].args.skillIds).toEqual([
    "codex",
  ]);
});

test("a stale skill stays ticked for another try while the rest are added", async ({
  page,
}) => {
  await fixture(page, "bulk-partial");
  await expect(rows(page)).toHaveCount(0);
  await trigger(page).click();
  const dialog = popover(page);
  await pick(page, "Code review").check();
  await pick(page, "Writing guide").check();
  await dialog
    .getByRole("button", { name: "Add 2 skills", exact: true })
    .click();
  await expect(rows(page)).toHaveCount(1);
  await expect(trigger(page)).toHaveText("Add skills");
  await expect(dialog.getByRole("alert")).toContainText(
    "1 added. 1 couldn’t be added.",
  );
  await expect(pick(page, "Writing guide")).toBeChecked();
  await expect(
    dialog
      .locator(".add-skills-row", { hasText: "Writing guide" })
      .getByLabel("Couldn’t be added"),
  ).toBeVisible();
  // The one that went in has left the list.
  await expect(pick(page, "Code review")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(
    (await calls(page, "add_global_skills")).map(
      (call: any) => call.args.skillIds,
    ),
  ).toEqual([["codex", "claude"], ["claude"]]);
});

test("a stale skill that has since disappeared is explained instead of offered for retry", async ({
  page,
}) => {
  await fixture(page, "bulk-gone");
  await trigger(page).click();
  const dialog = popover(page);
  await pick(page, "Writing guide").check();
  await dialog
    .getByRole("button", { name: "Add 1 skill", exact: true })
    .click();
  await expect(
    page.getByText(
      "Writing guide wasn’t added. It is no longer in your global skills.",
    ),
  ).toBeVisible();
  await expect(pick(page, "Writing guide")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Try again", exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Add skills", exact: true }),
  ).toBeDisabled();
});

test("choosing a repository with the keyboard changes the destination without adding", async ({
  page,
}) => {
  await fixture(page, "repositories");
  await trigger(page).click();
  const dialog = popover(page);
  await pick(page, "Code review").check();
  const destination = dialog.getByRole("button", {
    name: "Add to repository",
    exact: true,
  });
  await destination.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitemradio").nth(1)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(destination).toContainText("backen");
  // Enter chose the repository; it did not submit the earlier selection.
  expect(await calls(page, "add_global_skills")).toHaveLength(0);
  await expect(pick(page, "Code review")).not.toBeChecked();
  await expect(dialog).toBeVisible();
});

test("a failure that a retry cannot fix unticks the skill and explains in a toast", async ({
  page,
}) => {
  await fixture(page, "bulk-dead");
  await trigger(page).click();
  const dialog = popover(page);
  await pick(page, "Writing guide").check();
  await dialog
    .getByRole("button", { name: "Add 1 skill", exact: true })
    .click();
  await expect(
    page.getByText(
      /Writing guide wasn’t added\. A skill with this folder name/,
    ),
  ).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(pick(page, "Writing guide")).not.toBeChecked();
  await expect(
    dialog.getByRole("button", { name: "Try again", exact: true }),
  ).toHaveCount(0);
});

test("changing repositories clears the selection and scopes the add to the chosen repository", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 640 });
  await fixture(page, "repositories");
  await trigger(page).click();
  const dialog = popover(page);
  await pick(page, "Code review").check();
  const destination = dialog.getByRole("button", {
    name: "Add to repository",
    exact: true,
  });
  await expect(destination).toContainText("orka-platform-infrastructure");
  await destination.click();
  const options = page.getByRole("menuitemradio");
  // Only repositories with a folder on this Mac are offered.
  await expect(options).toHaveText([
    "orka-platform-infrastructure · deskto",
    "orka-platform-infrastructure · backen",
  ]);
  await options.nth(1).click();
  await expect(pick(page, "Code review")).not.toBeChecked();
  expect(
    (await calls(page, "scan_global_skills")).map(
      (call: any) => call.args.sourceId,
    ),
  ).toEqual(["desktop", "backend"]);
  for (const name of ["Code review", "Writing guide"])
    await pick(page, name).check();
  await dialog
    .getByRole("button", { name: "Add 2 skills", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  const added = await calls(page, "add_global_skills");
  expect(added).toHaveLength(1);
  expect(added[0].args).toEqual({
    projectId: "one",
    sourceId: "backend",
    skillIds: ["codex", "claude"],
  });
});

test("a stale skill that has become unreadable is cleared with its error", async ({
  page,
}) => {
  await fixture(page, "bulk-invalid");
  await trigger(page).click();
  const dialog = popover(page);
  await pick(page, "Writing guide").check();
  await dialog
    .getByRole("button", { name: "Add 1 skill", exact: true })
    .click();
  await expect(
    page.getByText("Writing guide wasn’t added. Package contains symlink"),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Try again", exact: true }),
  ).toHaveCount(0);

  await dialog
    .getByRole("searchbox", { name: "Search global skills" })
    .fill("Writing guide");
  const invalid = pick(page, "Writing guide");
  await expect(invalid).toBeDisabled();
  await expect(invalid).not.toBeChecked();
});

test("removing the chosen repository clears selection and requires choosing a replacement", async ({
  page,
}) => {
  await fixture(page, "repositories");
  await trigger(page).click();
  const dialog = popover(page);
  const destination = dialog.getByRole("button", {
    name: "Add to repository",
    exact: true,
  });
  await destination.click();
  await page.getByRole("menuitemradio", { name: /backen$/ }).click();
  await pick(page, "Code review").check();
  await page.evaluate(() => (window as any).removeSkillDestination());
  await expect(
    dialog.getByRole("heading", { name: "Repository unavailable" }),
  ).toBeVisible();
  await expect(destination).toHaveText("Choose repository");
  await expect(pick(page, "Code review")).toHaveCount(0);
  await page.keyboard.press("Enter");
  expect(await calls(page, "add_global_skills")).toHaveLength(0);
  expect(
    (await calls(page, "scan_global_skills")).map(
      (call: any) => call.args.sourceId,
    ),
  ).toEqual(["desktop", "backend"]);

  await destination.click();
  await page.getByRole("menuitemradio", { name: /deskto$/ }).click();
  await expect(pick(page, "Code review")).not.toBeChecked();
  await expect(
    dialog.getByRole("button", { name: "Add skills", exact: true }),
  ).toBeDisabled();
  await pick(page, "Code review").check();
  await dialog
    .getByRole("button", { name: "Add 1 skill", exact: true })
    .click();
  expect(await calls(page, "add_global_skills")).toEqual([
    {
      name: "add_global_skills",
      args: { projectId: "one", sourceId: "desktop", skillIds: ["codex"] },
    },
  ]);
});
