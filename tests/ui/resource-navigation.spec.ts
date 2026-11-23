import { test, expect } from "@playwright/test";

async function resourceFixture(
  page: import("@playwright/test").Page,
  skillNames = false,
) {
  await page.addInitScript((skillNames) => {
    const resources = [
      {
        resourceId: "memory-a",
        projectId: "one",
        kind: "memory",
        title: "Design decisions",
        deleted: false,
      },
      {
        resourceId: "memory-b",
        projectId: "one",
        kind: "memory",
        title: "Architecture notes",
        deleted: false,
        source: "claude",
        updatedBy: "mira",
        updatedAt: "2026-10-01T09:00:00Z",
      },
      {
        resourceId: "skill-b",
        projectId: "two",
        kind: "skill",
        title: "Writing guide",
        deleted: false,
      },
      {
        resourceId: "skill-d",
        projectId: "one",
        kind: "skill",
        title: "Writing guide",
        deleted: false,
      },
      {
        resourceId: "skill-e",
        projectId: "one",
        kind: "skill",
        title: "Review checklist",
        deleted: false,
        files: ["SKILL.md", "references/tokens.md"],
      },
      {
        resourceId: "session-c",
        projectId: "one",
        kind: "session",
        title: "Imported session",
        deleted: false,
      },
      {
        resourceId: "deleted",
        projectId: "one",
        kind: "memory",
        title: "Removed item",
        deleted: true,
      },
    ].map((r) => ({
      source: "codex",
      updatedBy: "user",
      updatedAt: "2026-10-04T10:00:00Z",
      ...r,
      logicalPath: `codex/${r.resourceId}`,
      files: (
        (r as { files?: string[] }).files ?? [
          r.kind === "skill"
            ? "SKILL.md"
            : r.kind === "session"
              ? "session.jsonl"
              : "content.md",
        ]
      ).map((path) => ({ path, hash: "hash", size: 10 })),
      revision: 1,
      owner: "user",
    }));
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        transformCallback: (callback: unknown) => {
          (window as any).reviewDeepLink = callback;
          return 1;
        },
        unregisterCallback: () => {},
        invoke: async (name: string, args?: Record<string, unknown>) => {
          if (name === "snapshot")
            return {
              user: "user",
              config: { apiUrl: "https://test.local", syncMinutes: 15 },
              projects: [
                { id: "one", name: "Orka", path: "/test/orka", role: "owner" },
                {
                  id: "two",
                  name: "Studio",
                  path: "/test/studio",
                  role: "owner",
                },
              ],
              resources,
              bindings: [],
              conflicts: [],
              activity: [],
              outbox: [],
              errors: [],
              sync: { online: true },
              daemon: { running: true },
              devices: [],
              deviceId: "device",
              background: true,
            };
          if (name === "session_display_title") return "Polish navigation";
          if (name === "session_messages") {
            const calls = ((window as any).sessionMessageCalls ??= []);
            calls.push(args);
            const total = 90;
            const offset = Number(args?.offset ?? 0);
            const limit = Number(args?.limit ?? 40);
            const messages = Array.from(
              { length: Math.max(0, Math.min(limit, total - offset)) },
              (_, i) => ({
                index: offset + i,
                role: (offset + i) % 2 ? "assistant" : "user",
                text:
                  offset + i === 0
                    ? "Session conversation"
                    : `Turn ${offset + i} of the **conversation**`,
              }),
            );
            return { messages, total, offset };
          }
          if (name === "inspect_resource")
            return {
              content:
                args?.file === "SKILL.md"
                  ? `---\nname: ${skillNames ? (args?.id === "skill-e" ? "Zebra review" : "Alpha writing") : resources.find((r) => r.resourceId === args?.id)?.title}\ndescription: How we write.\n---\n# Preview\nSome content`
                  : args?.file === "references/tokens.md"
                    ? "# Tokens\nToken reference content"
                    : "# Preview\nSome content",
              previous: "Old content",
              conversation: "Session conversation",
              paths: ["SKILL.md"],
            };
          if (name.startsWith("plugin:")) return null;
          return {};
        },
      },
    });
  }, skillNames);
  await page.goto("/");
  await expect(
    page.getByRole("combobox", { name: "Select project", exact: true }),
  ).toBeVisible();
}

const heading = (page: import("@playwright/test").Page) =>
  page.locator(".workspace-header h1");
const backButton = (
  page: import("@playwright/test").Page,
  collection: string,
) => page.getByRole("button", { name: `Back to ${collection}`, exact: true });

for (const outcome of ["success", "failure"] as const)
  test(`an older snapshot ${outcome} cannot overwrite an action refresh`, async ({
    page,
  }) => {
    await page.clock.install();
    await resourceFixture(page);
    await page.evaluate((outcome) => {
      const w = window as any;
      const original = w.__TAURI_INTERNALS__.invoke;
      w.snapshotReads = 0;
      w.__TAURI_INTERNALS__.invoke = async (name: string, args: any) => {
        const result = await original(name, args);
        if (name !== "snapshot") return result;
        w.snapshotReads += 1;
        if (w.snapshotReads === 1)
          return new Promise((resolve, reject) => {
            w.finishSnapshot = () =>
              outcome === "failure"
                ? reject(new Error("Outdated snapshot failed"))
                : resolve({
                    ...result,
                    projects: result.projects.map((project: any) => ({
                      ...project,
                      name: "Old project",
                    })),
                  });
          });
        return {
          ...result,
          projects: result.projects.map((project: any) => ({
            ...project,
            name: "Latest project",
          })),
        };
      };
    }, outcome);
    await page.clock.runFor(3100);
    await expect
      .poll(() => page.evaluate(() => typeof (window as any).finishSnapshot))
      .toBe("function");
    await page.clock.runFor(9000);
    expect(await page.evaluate(() => (window as any).snapshotReads)).toBe(1);
    await page.getByRole("button", { name: "Connected", exact: true }).click();
    await page.getByRole("button", { name: "Sync now", exact: true }).click();
    await expect(page.locator(".project-selector")).toContainText(
      "Latest project",
    );
    await page.evaluate(() => (window as any).finishSnapshot());
    await page.clock.runFor(100);
    await expect(page.locator(".project-selector")).toContainText(
      "Latest project",
    );
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).snapshotReads)).toBe(2);
  });

test("session deep links reset memory diff mode and keep the segmented modes", async ({
  page,
}) => {
  await resourceFixture(page);
  await page.getByRole("button", { name: /^Memories/ }).click();
  await page
    .getByRole("button", { name: "Design decisions", exact: true })
    .click();
  await page
    .getByRole("button", { name: "More resource actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", {
      name: "Compare with previous revision",
      exact: true,
    })
    .click();
  await expect(page.locator(".diff-card")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Show content", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page
    .getByRole("button", { name: "More resource actions", exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Show content", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.evaluate(() =>
    (window as any).reviewDeepLink({
      payload: ["orka://project/one/session-c"],
    }),
  );
  await expect(heading(page)).toHaveText("Sessions");
  await expect(backButton(page, "Sessions")).toBeVisible();
  await expect(page.locator(".diff-card")).toHaveCount(0);
  const conversation = page.getByLabel("Conversation", { exact: true });
  await expect(conversation).toContainText("Session conversation");
  await expect(conversation.locator(".session-turn")).not.toHaveCount(90);
  // The segmented control switches between the reader and the transcript.
  const modes = page.getByRole("group", { name: "Session view" });
  await modes.getByRole("button", { name: "Transcript", exact: true }).click();
  await expect(
    modes.getByRole("button", { name: "Transcript", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".session-view pre.content")).toHaveText([
    /Some content/,
  ]);
  await modes
    .getByRole("button", { name: "Conversation", exact: true })
    .click();
  await expect(conversation).toContainText("Session conversation");
  // The raw toggle now lives in the ⋯ menu.
  await page
    .getByRole("button", { name: "More resource actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Show Markdown", exact: true })
    .click();
  await expect(conversation.locator("pre.content").first()).toBeVisible();
});

test("memories list in a table and open the full-width reading view", async ({
  page,
}) => {
  await resourceFixture(page);
  await page.getByRole("button", { name: /^Memories/ }).click();
  const table = page.getByRole("table");
  await expect(table.getByRole("row")).toHaveCount(3);
  await expect(
    table
      .getByRole("row", { name: /Design decisions/ })
      .locator("td")
      .first(),
  ).toHaveText("Codex");
  await expect(page.locator(".inspector")).toHaveCount(0);
  await table
    .getByRole("button", { name: "Design decisions", exact: true })
    .click();
  const view = page.locator(".resource-detail--memory");
  await expect(view.locator("h2").first()).toHaveText("Design decisions");
  const info = view.getByRole("complementary", { name: "Memory information" });
  await expect(info.locator(".detail-facts")).toContainText("Version1");
  // A single-file memory has no file switcher.
  await expect(info.locator(".detail-files")).toHaveCount(0);
  await expect(view).not.toContainText("Stored as");
  await expect(view).toContainText("Some content");
  await expect(view.locator(".resource-summary")).toHaveCount(0);
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(heading(page)).toHaveText("Memories");
  await backButton(page, "Memories").click();
  await expect(page.getByRole("table")).toContainText("Design decisions");
  await expect(page.locator(".resource-detail")).toHaveCount(0);
});

test("sessions list in a table, open a reading view, and page turns on demand", async ({
  page,
}) => {
  await resourceFixture(page);
  await page.getByRole("button", { name: /^Sessions/ }).click();
  const table = page.getByRole("table");
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table).toContainText("Polish navigation");
  await expect(
    table.getByRole("img", { name: "Codex · You", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".inspector")).toHaveCount(0);
  await table
    .getByRole("button", { name: "Polish navigation", exact: true })
    .click();
  const view = page.locator(".session-view");
  await expect(view.locator("h2").first()).toHaveText("Polish navigation");
  await expect(page.getByLabel("Conversation", { exact: true })).toContainText(
    "Session conversation",
  );
  // Only the first page crossed the bridge; the transcript was not read.
  const firstCalls = await page.evaluate(
    () => (window as any).sessionMessageCalls.length,
  );
  expect(firstCalls).toBe(1);
  await expect(
    view.getByRole("complementary", { name: "Session information" }),
  ).not.toContainText("90 messages");
  await expect(view.locator(".session-turn--user").first()).toContainText(
    "You",
  );
  await expect(view.locator(".session-turn--assistant").first()).toContainText(
    "Codex",
  );
  await view
    .locator(".detail-reader")
    .evaluate((element) => element.scrollTo(0, element.scrollHeight));
  await expect
    .poll(() => page.evaluate(() => (window as any).sessionMessageCalls.length))
    .toBeGreaterThan(1);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).sessionMessageCalls.map((call: any) => call.offset),
      ),
    )
    .toContain(40);
  await expect(heading(page)).toHaveText("Sessions");
  await backButton(page, "Sessions").click();
  await expect(page.getByRole("table")).toContainText("Polish navigation");
  await expect(page.locator(".session-view")).toHaveCount(0);
});

test("skills switch files from the rail or the compact selector", async ({
  page,
}) => {
  await resourceFixture(page);
  await page.getByRole("button", { name: /^Skills/ }).click();
  const grid = page.locator(".skill-table");
  await expect(grid.locator("tbody tr")).toHaveCount(2);
  // Rows carry the name only; the description waits in the hover peek.
  await expect(grid).not.toContainText("How we write.");
  await expect(grid).not.toContainText("1 file");
  await expect(grid).not.toContainText("2 files");
  await expect(page.locator(".inspector")).toHaveCount(0);
  await page
    .locator(".skill-table tbody tr")
    .filter({ hasText: "Review checklist" })
    .click();
  const view = page.locator(".resource-detail--skill");
  await expect(view.locator("h2").first()).toHaveText("Review checklist");
  await expect(view.locator(".skill-description")).toHaveText("How we write.");
  await expect(view).toContainText("Some content");
  await expect(page.locator(".skill-table")).toHaveCount(0);
  await expect(view).toHaveAttribute("data-layout", "wide");
  // The Files card switches the inspected file; the title card stays put.
  const rail = view.getByRole("complementary", { name: "Skill information" });
  await rail
    .getByRole("button", { name: "references/tokens.md", exact: true })
    .click();
  await expect(view).toContainText("Token reference content");
  await expect(view.locator(".skill-description")).toHaveText("How we write.");
  await rail.getByRole("button", { name: "SKILL.md", exact: true }).click();
  await expect(view).toContainText("Some content");
  // At the minimum window the rail folds away and a Files popover switches.
  await page.setViewportSize({ width: 900, height: 640 });
  await expect(view).toHaveAttribute("data-layout", "compact");
  await expect(rail).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Files, 2" })).toBeVisible();
  await expect(heading(page)).toHaveText("Skills");
  await backButton(page, "Skills").click();
  await expect(grid.locator("tbody tr")).toHaveCount(2);
});

test("a failed file read clears old content and retries only on request", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install();
  await resourceFixture(page);
  await page.getByRole("button", { name: /^Skills/ }).click();
  await page
    .locator(".skill-table tbody tr")
    .filter({ hasText: "Review checklist" })
    .click();
  const view = page.locator(".resource-detail--skill");
  await expect(view).toContainText("Some content");
  await page.evaluate(() => {
    const w = window as any;
    const original = w.__TAURI_INTERNALS__.invoke;
    w.fileReads = 0;
    w.__TAURI_INTERNALS__.invoke = (name: string, args: any) => {
      if (
        name === "inspect_resource" &&
        args?.file === "references/tokens.md"
      ) {
        w.fileReads += 1;
        if (w.fileReads === 1)
          return new Promise((_, reject) => {
            w.rejectFileRead = () =>
              reject(new Error("File temporarily unavailable"));
          });
      }
      return original(name, args);
    };
  });
  await page
    .getByRole("complementary", { name: "Skill information" })
    .getByRole("button", { name: "references/tokens.md", exact: true })
    .click();
  await expect(view.getByRole("status")).toHaveText("Loading content…");
  await expect(view.locator(".loading-region")).toHaveAttribute(
    "aria-busy",
    "true",
  );
  // Skullet keeps an inert, aria-hidden copy to measure the previous layout.
  // It must not expose that copy as the current document.
  await expect(
    view.getByRole("article", { name: "Rendered Markdown" }),
  ).toHaveCount(0);
  await page.evaluate(() => (window as any).rejectFileRead());
  await expect(view.getByRole("alert")).toContainText(
    "Couldn’t load references/tokens.md",
  );
  await expect(
    view.getByRole("article", { name: "Rendered Markdown" }),
  ).toHaveCount(0);
  await page.clock.runFor(3100);
  expect(await page.evaluate(() => (window as any).fileReads)).toBe(1);
  await view.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(view).toContainText("Token reference content");
  await expect(view.getByRole("alert")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).fileReads)).toBe(2);
});

for (const outcome of ["success", "failure"] as const)
  test(`a late file ${outcome} cannot replace the current selection`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await resourceFixture(page);
    await page.getByRole("button", { name: /^Skills/ }).click();
    await page
      .locator(".skill-table tbody tr")
      .filter({ hasText: "Review checklist" })
      .click();
    const view = page.locator(".resource-detail--skill");
    await expect(view).toContainText("Some content");
    await page.evaluate((outcome) => {
      const w = window as any;
      const original = w.__TAURI_INTERNALS__.invoke;
      w.__TAURI_INTERNALS__.invoke = (name: string, args: any) => {
        if (
          name === "inspect_resource" &&
          args?.file === "references/tokens.md"
        )
          return new Promise((resolve, reject) => {
            w.finishFileRead = () =>
              outcome === "failure"
                ? reject(new Error("Old selection failed"))
                : resolve({
                    content: "Old selection content",
                    previous: null,
                    conversation: null,
                    paths: [],
                  });
          });
        return original(name, args);
      };
    }, outcome);
    await page
      .getByRole("complementary", { name: "Skill information" })
      .getByRole("button", { name: "references/tokens.md", exact: true })
      .click();
    await expect(view.getByRole("status")).toHaveText("Loading content…");
    await expect(view.locator(".loading-region")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await page
      .getByRole("complementary", { name: "Skill information" })
      .getByRole("button", { name: "SKILL.md", exact: true })
      .click();
    await expect(view).toContainText("Some content");
    await page.evaluate(() => (window as any).finishFileRead());
    await expect(view).toContainText("Some content");
    await expect(view).not.toContainText("Old selection content");
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

const pickFilter = async (
  page: import("@playwright/test").Page,
  category: string,
  option: string,
) => {
  await page.getByRole("button", { name: /^Filter/ }).click();
  await page.getByRole("menuitem", { name: category }).click();
  await page
    .getByRole("menuitemcheckbox", { name: option, exact: true })
    .click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
};

test("index toolbar searches title, path, and agent, filters by agent, sorts, and clears", async ({
  page,
}) => {
  await resourceFixture(page);
  await page.getByRole("button", { name: /^Memories/ }).click();
  const titles = () => page.locator(".skill-table-open").allTextContents();
  await expect.poll(titles).toEqual(["Design decisions", "Architecture notes"]);
  // The toolbar never counts items.
  await expect(page.getByText(/^\d+ memor(y|ies)$/)).toHaveCount(0);
  const search = page.getByRole("searchbox", { name: "Search memories" });
  await search.fill("archi");
  await expect.poll(titles).toEqual(["Architecture notes"]);
  await search.fill("claude");
  await expect.poll(titles).toEqual(["Architecture notes"]);
  await search.fill("nothing here");
  await expect(
    page.getByRole("heading", { name: "No memories match “nothing here”" }),
  ).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  await page
    .locator(".empty-state")
    .getByRole("button", { name: "Clear search", exact: true })
    .click();
  await expect(search).toHaveValue("");
  await pickFilter(page, "Agent", "Claude");
  await expect.poll(titles).toEqual(["Architecture notes"]);
  await page
    .getByRole("group", { name: "Active filters" })
    .getByRole("button", { name: "Remove Agent filter" })
    .click();
  await expect.poll(titles).toEqual(["Design decisions", "Architecture notes"]);
  await page.getByRole("button", { name: /^Sort/ }).click();
  await page.getByRole("menuitemradio", { name: "Name", exact: true }).click();
  await expect.poll(titles).toEqual(["Architecture notes", "Design decisions"]);
  await expect(page.getByRole("button", { name: /^Sort/ })).toContainText(
    "Name",
  );
  // Clearing the search keeps focus in the field.
  await search.fill("design");
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(search).toBeFocused();
  await page.getByRole("button", { name: /^Skills/ }).click();
  await expect(
    page.getByRole("searchbox", { name: "Search skills" }),
  ).toBeVisible();
});

test("skill title sorting follows frontmatter names instead of folder titles", async ({
  page,
}) => {
  await resourceFixture(page, true);
  await page.getByRole("button", { name: /^Skills/ }).click();
  const titles = page.locator(".skill-table-open");
  // Name A to Z is the default order.
  await expect(titles).toHaveText(["Alpha writing", "Zebra review"]);
  await page.getByRole("button", { name: "Sort Name", exact: true }).click();
  await page
    .getByRole("menuitemradio", { name: "Z to A", exact: true })
    .click();
  await expect(titles).toHaveText(["Zebra review", "Alpha writing"]);
});

test("empty collections omit tools, and an agent filter stops filtering once its option disappears", async ({
  page,
}) => {
  await page.clock.install();
  await resourceFixture(page);
  await page.getByRole("button", { name: /^Memories/ }).click();
  const selector = page.getByRole("combobox", { name: "Select project" });
  await selector.click();
  await page.getByRole("option", { name: "Studio", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "No memories yet", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("searchbox", { name: "Search memories" }),
  ).toHaveCount(0);
  await selector.click();
  await page.getByRole("option", { name: "Orka", exact: true }).click();
  await pickFilter(page, "Agent", "Claude");
  const chips = page.getByRole("group", { name: "Active filters" });
  await expect(chips).toContainText("Claude");
  await expect(
    page.getByRole("button", { name: "Design decisions", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    const w = window as any;
    const original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      const result = await original(command, args);
      return command === "snapshot"
        ? {
            ...result,
            resources: result.resources.filter(
              (item: any) => item.source !== "claude",
            ),
          }
        : result;
    };
  });
  await page.clock.runFor(3100);
  // With one agent left there is nothing to choose, so the pick lapses
  // instead of hiding every row from out of sight.
  await expect(
    page.getByRole("button", { name: "Design decisions", exact: true }),
  ).toBeVisible();
  await expect(chips).toHaveCount(0);
  await page.getByRole("button", { name: /^Filter/ }).click();
  await expect(page.getByRole("menuitem", { name: "Agent" })).toHaveCount(0);
});

for (const width of [1160, 900])
  test(`Home has one project context and recent navigation at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 640 });
    await resourceFixture(page);
    await expect(
      page.getByRole("region", { name: "Project totals" }).getByRole("button"),
    ).toHaveCount(4);
    await expect(
      page.getByRole("heading", { name: "Orka", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Recent Updates", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`home-${width}.png`) });
    await page
      .getByRole("button", { name: "Collapse sidebar", exact: true })
      .click();
    await page.getByRole("button", { name: "Memories", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Design decisions", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      ),
    ).toBe(false);
  });
