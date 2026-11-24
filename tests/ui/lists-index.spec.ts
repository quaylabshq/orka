import { test, expect, type Page } from "@playwright/test";
import { listsIndexFixture, type ListsScene } from "./fixtures/lists-index.js";

const rows = (page: Page) => page.locator(".index-table tbody tr");
const pills = (page: Page) => page.locator(".index-status-pill");
const filter = (page: Page) => page.getByRole("button", { name: /^Filter/ });
const pick = async (page: Page, category: string, option: string) => {
  await filter(page).click();
  await page.getByRole("menuitem", { name: category }).click();
  await page
    .getByRole("menuitemcheckbox", { name: option, exact: true })
    .click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
};
const open = async (page: Page, label: string, scene: ListsScene = {}) => {
  await listsIndexFixture(page, scene);
  await page.getByRole("button", { name: new RegExp(`^${label}`) }).click();
  await expect(rows(page).first()).toBeVisible();
};

/** Most urgent first: the order a list row picks its one pill in. */
const priority = [
  "Conflict",
  "Upload failed",
  "Couldn’t read",
  "Upload refused",
  "Needs review",
  "Waiting to sync",
  "Local edits",
];

/** What each page shows for the fixture's sample rows. */
const pages = [
  {
    label: "Plans",
    noun: "Plan",
    person: "Owner",
    headings: ["Plan", "Repository", "Owner", "Updated", "Status"],
    filters: ["Status", "Owner", "Repository", "Location"],
    pills: [
      "Local edits",
      "Needs review",
      "Conflict",
      "Upload failed",
      "Waiting to sync",
      "Upload refused",
      "Couldn’t read",
      "Couldn’t read",
    ],
    find: ["Needs review", "Conflicts panel handoff"],
  },
  {
    label: "Memories",
    noun: "Memory",
    person: "Updated by",
    headings: [
      "Memory",
      "Agent",
      "Repository",
      "Updated by",
      "Updated",
      "Status",
    ],
    filters: [
      "Status",
      "Updated by",
      "Agent",
      "Repository",
      "Location",
      "Kind",
    ],
    pills: [
      "Needs review",
      "Local edits",
      "Conflict",
      "Upload failed",
      "Waiting to sync",
      "Couldn’t read",
      "Upload refused",
    ],
    find: ["Needs review", "AGENTS.md"],
  },
  {
    label: "Sessions",
    noun: "Session",
    person: "Owner",
    headings: ["Session", "Agent", "Repository", "Owner", "Updated", "Status"],
    filters: ["Status", "Owner", "Agent", "Repository", "Location", "Type"],
    pills: [
      "Local edits",
      "Conflict",
      "Upload failed",
      "Waiting to sync",
      "Upload refused",
      "Couldn’t read",
    ],
    find: ["Upload refused", "Token audit for the Skills table"],
  },
];

for (const scene of pages) {
  test(`${scene.label} rows carry one status pill each and the Status filter finds them`, async ({
    page,
  }) => {
    await open(page, scene.label);
    await expect(page.getByRole("columnheader")).toHaveText([
      ...scene.headings,
      "Actions",
    ]);
    await expect(pills(page)).toHaveText(scene.pills);
    await filter(page).click();
    await expect(page.getByRole("menuitem")).toHaveText(scene.filters);
    await page.keyboard.press("Escape");
    await pick(page, "Status", scene.find[0]);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page)).toContainText(scene.find[1]);
  });

  test(`${scene.label} open newest first, and a sort by status puts the most urgent first`, async ({
    page,
  }) => {
    await open(page, scene.label);
    await expect(page.getByRole("button", { name: /^Sort/ })).toContainText(
      "Last updated",
    );
    await expect(
      page.getByRole("columnheader", { name: "Updated", exact: true }),
    ).toHaveAttribute("aria-sort", "descending");
    await page.getByRole("button", { name: /^Sort/ }).click();
    await page
      .getByRole("menuitemradio", { name: "Status", exact: true })
      .click();
    // The order the pill itself is chosen in; rows with no status sink.
    await expect(pills(page)).toHaveText(
      [...scene.pills].sort(
        (a, b) => priority.indexOf(a) - priority.indexOf(b),
      ),
    );
    await expect(rows(page).last().locator(".index-status-pill")).toHaveCount(
      0,
    );
  });

  test(`${scene.label} drop the person column in a solo project and the repository with one`, async ({
    page,
  }) => {
    await open(page, scene.label, { solo: true, oneRepository: true });
    await expect(
      page.getByRole("columnheader", { name: scene.person }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("columnheader", { name: "Repository" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("columnheader", { name: "Status" }),
    ).toBeVisible();
  });

  test(`${scene.label} offer no Repository filter while one repository is left and the column is gone`, async ({
    page,
  }) => {
    await open(page, scene.label, { removedRepository: true });
    await expect(
      page.getByRole("columnheader", { name: "Repository" }),
    ).toHaveCount(0);
    await filter(page).click();
    await expect(page.getByRole("menuitem")).toHaveText(
      scene.filters.filter((label) => label !== "Repository"),
    );
  });

  test(`${scene.label} show people as avatars at 1160 with their names kept for assistive technology`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1160, height: 800 });
    await open(page, scene.label);
    const name = rows(page).first().locator(".index-table-person-name");
    await expect(name).toHaveText("Mira");
    expect(await name.evaluate((element) => element.clientWidth)).toBe(1);
    await expect(
      rows(page).first().locator(".index-table-person"),
    ).toHaveAttribute("title", "Mira");
    await expect(
      page.getByRole("columnheader", { name: scene.person }),
    ).toBeVisible();
    // The sorted Updated heading keeps its whole label beside the arrow.
    const updated = page
      .getByRole("columnheader", { name: "Updated", exact: true })
      .locator(".index-table-heading-label");
    expect(
      await updated.evaluate((label) => label.scrollWidth <= label.clientWidth),
    ).toBe(true);
  });
}

test("the Location filter and each row's leading icon use the same words", async ({
  page,
}) => {
  await open(page, "Plans");
  await pick(page, "Location", "Shared with team");
  await expect(rows(page)).toHaveCount(13);
  await expect(rows(page).getByLabel("Shared with team")).toHaveCount(13);
  await pick(page, "Location", "Shared with team");
  await pick(page, "Location", "On this Mac");
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).getByLabel("On this Mac")).toHaveCount(3);
  await page.getByRole("button", { name: /^Sort/ }).click();
  await expect(page.getByRole("menuitemradio")).toHaveText([
    "Last updated",
    "Name",
    "Status",
    "Repository",
    "Owner",
    "Oldest first",
    "Newest first",
  ]);
});

test("a fork Orka made and has not shared yet reads On this Mac, on its row and in the Location filter", async ({
  page,
}) => {
  await open(page, "Sessions");
  const fork = rows(page).filter({
    hasText: "Unify detail pages on one layout",
  });
  await expect(fork.getByLabel("On this Mac")).toBeVisible();
  await pick(page, "Location", "Shared with team");
  await expect(fork).toHaveCount(0);
  await pick(page, "Location", "Shared with team");
  await pick(page, "Location", "On this Mac");
  await expect(fork).toHaveCount(1);
});

test("Couldn’t read marks the plan whose own file failed, not one a rescan reported on", async ({
  page,
}) => {
  await open(page, "Plans");
  const row = (title: string) => rows(page).filter({ hasText: title });
  await expect(
    row("Library icon gaps").locator(".index-status-pill"),
  ).toHaveText("Couldn’t read");
  await expect(
    row("Docs redesign table component").locator(".index-status-pill"),
  ).toHaveCount(0);
});

test("a pick whose person left stays dropped when they come back", async ({
  page,
}) => {
  await open(page, "Plans");
  await pick(page, "Owner", "Dev");
  await expect(rows(page)).toHaveCount(3);
  const dev = ["plan-6", "plan-11", "plan-14"];
  await page.evaluate((ids) => ((window as any).listsHidden = ids), dev);
  await expect(rows(page)).toHaveCount(13);
  await expect(
    page.getByRole("button", { name: "Remove Owner filter" }),
  ).toHaveCount(0);
  await page.evaluate(() => ((window as any).listsHidden = []));
  await expect(rows(page)).toHaveCount(16);
  await expect(
    page.getByRole("button", { name: "Remove Owner filter" }),
  ).toHaveCount(0);
});

test("a session whose transcript this Mac cannot read says Couldn’t read, and the Status filter finds it", async ({
  page,
}) => {
  await open(page, "Sessions");
  const row = rows(page).filter({
    hasText: "Request access panel failure states",
  });
  await expect(row.locator(".index-status-pill")).toHaveText("Couldn’t read");
  await expect(row.locator(".index-status-pill")).toHaveAttribute(
    "data-tone",
    "red",
  );
  await pick(page, "Status", "Couldn’t read");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText("Request access panel failure states");
});

test("a row in two states shows the more urgent pill, and the Status filter files it there", async ({
  page,
}) => {
  await open(page, "Plans");
  const row = rows(page).filter({ hasText: "Copy pass with Orka guidelines" });
  await expect(row.locator(".index-status-pill")).toHaveText("Couldn’t read");
  await pick(page, "Status", "Couldn’t read");
  await expect(row).toHaveCount(1);
  await pick(page, "Status", "Couldn’t read");
  await pick(page, "Status", "Waiting to sync");
  await expect(rows(page)).toHaveCount(1);
  await expect(row).toHaveCount(0);
});

test("a control-click anywhere on a row shows its menu and never opens the row", async ({
  page,
}) => {
  await open(page, "Plans");
  const row = rows(page).filter({ hasText: "Conflicts panel handoff" });
  const back = page.getByRole("button", { name: "Back to Plans" });
  for (const target of [
    row.getByRole("button", { name: "Conflicts panel handoff", exact: true }),
    row.locator(".index-table-repository"),
    row.locator(".index-table-updated"),
  ]) {
    // macOS turns a control-click into a secondary click, and WebKit still
    // follows it with a click carrying the control key.
    await target.click({ button: "right", modifiers: ["Control"] });
    await target.dispatchEvent("click", { ctrlKey: true });
    await expect(
      page.getByRole("menu", { name: "plan actions" }),
    ).toBeVisible();
    await expect(back).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
  }
  await expect(back).toHaveCount(0);
});

test("clicking another row to dismiss a menu does not open that row, and the next click does", async ({
  page,
}) => {
  await open(page, "Plans");
  await page
    .getByRole("button", { name: "Conflicts panel handoff", exact: true })
    .click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  const other = page.getByRole("button", {
    name: "Docs redesign table component",
    exact: true,
  });
  await other.click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Back to Plans" })).toHaveCount(
    0,
  );
  await other.click();
  await expect(
    page.getByRole("button", { name: "Back to Plans" }),
  ).toBeVisible();
});

test("Memories tell repeated file names apart by agent, and the Kind filter splits instruction files from memories", async ({
  page,
}) => {
  await open(page, "Memories");
  const repeated = rows(page).filter({ hasText: "MEMORY.md" });
  await expect(repeated).toHaveCount(2);
  await expect(repeated.locator(".index-table-agent")).toHaveText([
    "Claude",
    "Codex",
  ]);
  await pick(page, "Kind", "Instruction file");
  await expect(page.locator(".index-table-open")).toHaveText([
    "AGENTS.md",
    "CLAUDE.md",
    "Sharded pull request checks",
  ]);
  await pick(page, "Agent", "Codex");
  await expect(page.locator(".index-table-open")).toHaveText(["AGENTS.md"]);
});

test("at 1160 the agent is a logo whose name stays available on hover and to assistive technology", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1160, height: 800 });
  await open(page, "Memories");
  const agent = rows(page).first().locator(".index-table-agent");
  await expect(agent).toHaveAttribute("title", "Codex");
  const name = agent.locator(".source-label > span");
  await expect(name).toHaveText("Codex");
  expect(await name.evaluate((element) => element.clientWidth)).toBe(1);
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(await name.evaluate((element) => element.clientWidth)).toBeGreaterThan(
    1,
  );
});

test("Sessions list forks flat with a marker after the title, and the Type filter finds them", async ({
  page,
}) => {
  await open(page, "Sessions");
  const forks = [
    "Skills index redesign review, second pass",
    "Governance spec flake on CI, retry",
    "Unify detail pages on one layout",
  ];
  const marked = rows(page).filter({
    has: page.getByRole("img", { name: "Forked session" }),
  });
  await expect(marked.locator(".index-table-open")).toHaveText(forks);
  const marker = marked.first().getByRole("img", { name: "Forked session" });
  const title = marked.first().locator(".index-table-open");
  const [markerBox, titleBox] = [
    (await marker.boundingBox())!,
    (await title.boundingBox())!,
  ];
  expect(markerBox.width).toBe(12);
  expect(markerBox.x).toBeGreaterThan(titleBox.x + titleBox.width);
  expect(markerBox.x - (titleBox.x + titleBox.width)).toBeLessThan(10);
  await pick(page, "Type", "Forks");
  await expect(page.locator(".index-table-open")).toHaveText(forks);
  await pick(page, "Type", "Originals");
  await expect(rows(page)).toHaveCount(16);
});

test("hovering or focusing a session row prefetches its messages", async ({
  page,
}) => {
  await open(page, "Sessions");
  const prefetched = () =>
    page.evaluate(() =>
      (window as any).listsCalls
        .filter(({ name }: { name: string }) => name === "session_messages")
        .map(({ args }: { args: { id: string } }) => args.id),
    );
  await rows(page).nth(4).hover();
  await expect.poll(prefetched).toContain("session-4");
  await page.locator(".index-table-open").nth(6).focus();
  await expect.poll(prefetched).toContain("session-6");
  expect(await prefetched()).not.toContain("session-9");
});

test("several hundred sessions list without a pager and scroll under a fixed toolbar", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1160, height: 800 });
  await open(page, "Sessions", { sessions: 500 });
  await expect(rows(page)).toHaveCount(516);
  await expect(page.getByRole("navigation", { name: /pages$/ })).toHaveCount(0);
  const body = page.locator(".resource-index-body");
  await body.evaluate((element) => element.scrollTo(0, element.scrollHeight));
  await expect(rows(page).last()).toBeInViewport();
  await expect(
    page.getByRole("searchbox", { name: "Search sessions" }),
  ).toBeInViewport();
  await expect(rows(page).first()).not.toBeInViewport();
});

const peekOf = async (page: Page, title: string) => {
  await page.mouse.move(0, 0);
  await page.getByRole("button", { name: title, exact: true }).hover();
  const peek = page.getByRole("tooltip");
  await expect(peek).toBeVisible();
  return peek;
};

test("at 900 × 640 a long title truncates in its row and a long path's peek stays inside the list", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 640 });
  await open(page, "Plans", { longText: true });
  const title = page
    .locator(".index-table-open")
    .filter({ hasText: "Rework the repository picker" });
  await expect(title).toHaveAttribute("title", /hiding the status column$/);
  const layout = await title.evaluate((name) => {
    const box = (element: Element) => element.getBoundingClientRect();
    const row = name.closest("tr")!;
    return {
      height: box(row).height,
      truncated: name.scrollWidth > name.clientWidth,
      contained: box(name).right <= box(name.closest("th")!).right,
      pageOverflow:
        document.documentElement.scrollWidth > window.innerWidth ||
        document.querySelector(".resource-index-body")!.scrollWidth >
          document.querySelector(".resource-index-body")!.clientWidth,
    };
  });
  expect(layout).toEqual({
    height: 44,
    truncated: true,
    contained: true,
    pageOverflow: false,
  });
  // Sorted by name, rows follow it, so it can sit just above the list's end.
  await page.getByRole("button", { name: /^Sort/ }).click();
  await page.getByRole("menuitemradio", { name: "Name", exact: true }).click();
  await page.keyboard.press("Escape");
  for (const [room, side] of [
    [150, "below"],
    [100, "above"],
  ] as const) {
    await page.mouse.move(0, 0);
    await title.evaluate((name, room) => {
      const body = name.closest<HTMLElement>(".resource-index-body")!;
      const row = name.closest("tr")!;
      const view = body.getBoundingClientRect();
      const top = row.getBoundingClientRect().top - view.top + body.scrollTop;
      body.scrollTo({ top: top + row.offsetHeight - (view.height - room) });
    }, room);
    await title.hover();
    const peek = page.getByRole("tooltip");
    await expect(peek).toHaveAttribute("data-side", side);
    const fit = await peek.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const list = element
        .closest(".resource-index-body")!
        .getBoundingClientRect();
      const path = element.querySelector(".index-table-peek-path")!;
      return {
        insideList: box.bottom <= list.bottom && box.top >= list.top,
        insideWindow:
          box.left >= 0 &&
          box.right <= window.innerWidth &&
          box.bottom <= window.innerHeight,
        pathWhole: path.scrollWidth <= path.clientWidth,
      };
    });
    expect(fit).toEqual({
      insideList: true,
      insideWindow: true,
      pathWhole: true,
    });
    await expect(peek).toContainText("plans/rework-the-repository-picker");
    await expect(peek).toContainText("Updated");
  }
});

test("a session peek names the fork's parent or counts its forks, then the repository folder", async ({
  page,
}) => {
  await open(page, "Sessions");
  const fork = await peekOf(page, "Skills index redesign review, second pass");
  await expect(fork.locator(":scope > span:visible")).toHaveText(
    ["Fork of Skills index redesign review", "~/code/orka-public"],
    { useInnerText: true },
  );
  const parent = await peekOf(page, "Skills index redesign review");
  await expect(parent.locator(":scope > span:visible")).toHaveText(
    ["1 fork", "~/code/orka-public"],
    { useInnerText: true },
  );
  // Updated has its own column at this width.
  await expect(parent).not.toContainText("Updated", { useInnerText: true });
});

test("a plan peek says where the plan came from, with its file only when it has one on this Mac", async ({
  page,
}) => {
  await open(page, "Plans");
  const file = await peekOf(page, "Repository filter across collections");
  await expect(file.locator(":scope > span:visible")).toHaveText(
    ["Plan file", "~/.claude/plans/repository-filter-across-collections.md"],
    { useInnerText: true },
  );
  const session = await peekOf(page, "Pending reviews redesign");
  await expect(session.locator(":scope > span:visible")).toHaveText(
    ["From a session"],
    { useInnerText: true },
  );
  // A teammate's plan has no file on this Mac.
  const teammate = await peekOf(page, "Skills index production rollout");
  await expect(teammate.locator(":scope > span:visible")).toHaveText(
    ["Plan file"],
    {
      useInnerText: true,
    },
  );
});

test("a memory peek gives its kind and version, then its file", async ({
  page,
}) => {
  await open(page, "Memories");
  const instructions = await peekOf(page, "CLAUDE.md");
  await expect(instructions.locator(":scope > span:visible")).toHaveText(
    ["Instruction file · Version 11", "~/code/orka-public/CLAUDE.md"],
    { useInnerText: true },
  );
  const local = await peekOf(page, "Searchable notes folder overflow");
  await expect(local.locator(":scope > span:visible")).toHaveText(
    ["Memory", "~/.codex/memory/searchable-notes-folder-overflow.md"],
    { useInnerText: true },
  );
});

test("at the minimum window Updated leaves the table and joins the peek", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 640 });
  await open(page, "Sessions");
  await expect(
    page.getByRole("columnheader", { name: "Updated", exact: true }),
  ).toBeHidden();
  const fork = await peekOf(page, "Skills index redesign review, second pass");
  await expect(fork.locator(":scope > span:visible")).toHaveText(
    [
      "Fork of Skills index redesign review",
      "~/code/orka-public",
      "Updated 1h ago",
    ],
    { useInnerText: true },
  );
  await page.getByRole("button", { name: /^Memories/ }).click();
  const memory = await peekOf(page, "CLAUDE.md");
  await expect(memory.locator(":scope > span:visible").first()).toHaveText(
    "Instruction file · Version 11 · Updated 41m ago",
  );
});

const tools = (page: Page, noun: string) =>
  page.getByRole("group", { name: `${noun} tools` });
const visit = async (page: Page, label: string, scene: ListsScene) => {
  await listsIndexFixture(page, scene);
  await page.getByRole("button", { name: new RegExp(`^${label}`) }).click();
};

test("a project not on this Mac keeps its rows and explains itself in a pill beside the toolbar", async ({
  page,
}) => {
  await open(page, "Sessions", { disconnected: true });
  await expect(
    page.getByRole("region", { name: "Connect this Mac" }),
  ).toHaveCount(0);
  const pill = tools(page, "sessions").getByRole("button", {
    name: "Not on this Mac",
  });
  await pill.click();
  const panel = page.getByRole("dialog", {
    name: "This project isn’t on this Mac",
  });
  await expect(panel).toContainText(
    "You can read the team’s shared sessions. Connect the project folder to continue them on this Mac and share your own.",
  );
  await panel.getByRole("button", { name: "Connect folder" }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).listsCalls.some(
          ({ name }: { name: string }) => name === "plugin:dialog|open",
        ),
      ),
    )
    .toBe(true);
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(pill).toBeFocused();
  await expect(rows(page)).toHaveCount(14);
  await expect(rows(page).getByLabel("On this Mac")).toHaveCount(0);
});

test("an empty list not on this Mac offers Connect folder in place of the toolbar", async ({
  page,
}) => {
  await visit(page, "Memories", { disconnected: true, empty: true });
  await expect(
    page.getByRole("heading", { name: "No memories yet" }),
  ).toBeVisible();
  await expect(page.getByRole("searchbox")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Connect folder" }),
  ).toBeVisible();
});

test("a role that hides shared plans lists the ones on this Mac with a Restricted pill", async ({
  page,
}) => {
  await open(page, "Plans", { access: "hidden" });
  await expect(rows(page)).toHaveCount(3);
  await tools(page, "plans")
    .getByRole("button", { name: "Restricted" })
    .click();
  const panel = page.getByRole("dialog", {
    name: "Shared plans are restricted",
  });
  await expect(panel).toContainText(
    "Your role cannot see plans shared in this project.",
  );
  await panel.getByRole("button", { name: "Request access" }).click();
  const request = page.getByRole("dialog", { name: "Request access" });
  await request.getByRole("button", { name: "Send request" }).click();
  await expect(request).toBeHidden();
  await expect(
    panel.getByRole("button", { name: "Access requested" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as any).listsCalls
        .filter(
          ({ name, args }: { name: string; args: { action: string } }) =>
            name === "governance_command" && args.action === "request-access",
        )
        .map(({ args }: { args: { input: { class: string } } }) => args.input),
    ),
  ).toMatchObject([{ class: "plan", mode: "read" }]);
});

test("with nothing on this Mac either, No access offers Request access without a toolbar", async ({
  page,
}) => {
  await visit(page, "Memories", { access: "hidden", empty: true });
  await expect(
    page.getByRole("heading", { name: "Shared memories are restricted" }),
  ).toBeVisible();
  await expect(
    page.getByText("Your role cannot see memories shared in this project."),
  ).toBeVisible();
  await expect(page.getByRole("searchbox")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Refresh local items" }),
  ).toHaveCount(0);
  await expect(
    page
      .locator(".empty-state")
      .getByRole("button", { name: "Request access" }),
  ).toBeVisible();
});

test("a view-only member asks for editing access from beside the toolbar", async ({
  page,
}) => {
  await open(page, "Sessions", { access: "read" });
  const toolbar = tools(page, "sessions");
  const request = toolbar.getByRole("button", {
    name: "Request editing access",
  });
  await expect(request).toBeVisible();
  // The refresh button comes first, then the request, at the right end.
  const [refresh, ask] = await Promise.all([
    toolbar.getByRole("button", { name: "Refresh local items" }).boundingBox(),
    request.boundingBox(),
  ]);
  expect(ask!.x).toBeGreaterThan(refresh!.x);
  expect(
    Math.abs(ask!.y + ask!.height / 2 - (refresh!.y + refresh!.height / 2)),
  ).toBeLessThan(2);
});

test("loading draws skeleton rows under the toolbar", async ({ page }) => {
  await visit(page, "Plans", { empty: true, discovery: "pending" });
  await expect(
    page.getByRole("status").filter({ hasText: "Loading plans…" }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("searchbox", { name: "Search plans" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Refresh local items" }),
  ).toBeDisabled();
  const [toolbar, skeleton] = await Promise.all([
    tools(page, "plans").boundingBox(),
    page.locator(".collection-skeleton").boundingBox(),
  ]);
  expect(skeleton!.y).toBeGreaterThan(toolbar!.y + toolbar!.height);
});

test("Could not load gives the cause and one action, Try again", async ({
  page,
}) => {
  await visit(page, "Memories", { empty: true, discovery: "failed" });
  const state = page.locator(".empty-state");
  await expect(
    state.getByRole("heading", { name: "Couldn’t load memories" }),
  ).toBeVisible();
  await expect(state.locator(".empty-state-description")).toHaveText(
    "Orka couldn’t check this Mac for memories.",
  );
  // The cause as discovery reported it stays one click away.
  const cause = state.getByText("Permission denied (os error 13)");
  await expect(cause).toBeHidden();
  await state.getByText("Details", { exact: true }).click();
  await expect(cause).toBeVisible();
  await expect(state.getByRole("button")).toHaveText(["Try again"]);
  await expect(page.getByRole("searchbox")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Refresh local items" }),
  ).toHaveCount(0);
  await expect(page.locator(".resource-discovery-status")).toHaveCount(0);
  await page.evaluate(() => ((window as any).listsDiscovery = "ok"));
  await state.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("heading", { name: "No memories yet" }),
  ).toBeVisible();
});

test("an empty list keeps only Refresh from the toolbar and says what will appear", async ({
  page,
}) => {
  await visit(page, "Plans", { empty: true });
  const heading = page.getByRole("heading", { name: "No plans yet" });
  await expect(heading).toBeVisible();
  await expect(
    page.getByText(
      "Plans saved by your coding tools for this project appear here.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("searchbox")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /^(Filter|Sort)/ }),
  ).toHaveCount(0);
  const refresh = page.getByRole("button", { name: "Refresh local items" });
  await expect(refresh).toBeVisible();
  // Alone at the right end of where the toolbar sits, above the message.
  const [button, body, title] = await Promise.all(
    [refresh, page.locator(".resource-index-body"), heading].map(
      async (element) => (await element.boundingBox())!,
    ),
  );
  expect(body.x + body.width - (button.x + button.width)).toBeLessThan(40);
  expect(button.y + button.height).toBeLessThan(title.y);
  const scans = () =>
    page.evaluate(
      () =>
        (window as any).listsCalls.filter(
          ({ name }: { name: string }) => name === "local_resource_catalog",
        ).length,
    );
  const before = await scans();
  await refresh.click();
  await expect.poll(scans).toBeGreaterThan(before);
});

test("narrowing a list announces how many rows are left, without a visible count", async ({
  page,
}) => {
  await open(page, "Sessions");
  const result = page.locator(".resource-index-body .sr-only[role='status']");
  await expect(result).toHaveCount(0);
  await page.getByRole("searchbox", { name: "Search sessions" }).fill("Skills");
  await expect(result).toHaveText("4 sessions");
  // Read out only: no visible copy of the count.
  await expect(page.getByText("4 sessions")).toHaveCount(1);
  await page.getByRole("searchbox", { name: "Search sessions" }).fill("");
  await expect(result).toHaveCount(0);
  await pick(page, "Status", "Upload refused");
  await expect(result).toHaveText("1 session");
});

test("no match uses the Skills wording, with both ways out when filters are on too", async ({
  page,
}) => {
  await open(page, "Sessions");
  const search = page.getByRole("searchbox", { name: "Search sessions" });
  await search.fill("deploy");
  await expect(
    page.getByRole("heading", { name: "No sessions match “deploy”" }),
  ).toBeVisible();
  await expect(
    page.getByText("Try a different search or clear your filters."),
  ).toBeVisible();
  await pick(page, "Agent", "Codex");
  await expect(
    page.getByRole("heading", {
      name: "No sessions match “deploy” with these filters",
    }),
  ).toBeVisible();
  const state = page.locator(".empty-state");
  await expect(state.getByRole("button")).toHaveText([
    "Clear search",
    "Clear filters",
  ]);
  await state.getByRole("button", { name: "Clear search" }).click();
  await expect(rows(page)).toHaveCount(9);
});

for (const label of ["Sessions", "Plans", "Memories"])
  test(`at the minimum window ${label} show the Repository heading and a short repository name in full`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 640 });
    await open(page, label);
    const whole = (locator: ReturnType<Page["locator"]>) =>
      locator.evaluate((element) => element.scrollWidth <= element.clientWidth);
    expect(
      await whole(
        page
          .getByRole("columnheader", { name: "Repository" })
          .locator(".index-table-heading-label"),
      ),
    ).toBe(true);
    const name = page
      .locator(".index-table-repository-label > span")
      .filter({ hasText: /^orka-public$/ })
      .first();
    expect(await whole(name)).toBe(true);
  });
