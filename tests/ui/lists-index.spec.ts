import { test, expect, type Page } from "@playwright/test";
import { listsIndexFixture, type ListsScene } from "./fixtures/lists-index.js";

const rows = (page: Page) => page.locator(".skill-table tbody tr");
const pills = (page: Page) => page.locator(".skill-status-pill");
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
    filters: ["Status", "Owner", "Agent", "Repository", "Location", "Forks"],
    pills: [
      "Local edits",
      "Conflict",
      "Upload failed",
      "Waiting to sync",
      "Upload refused",
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
    // Red first, then amber, then neutral; rows with no status sink.
    await expect(pills(page).first()).toHaveAttribute("data-tone", "red");
    await expect(rows(page).last().locator(".skill-status-pill")).toHaveCount(
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

  test(`${scene.label} show people as avatars at 1160 with their names kept for assistive technology`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1160, height: 800 });
    await open(page, scene.label);
    const name = rows(page).first().locator(".skill-table-person-name");
    await expect(name).toHaveText("Mira");
    expect(await name.evaluate((element) => element.clientWidth)).toBe(1);
    await expect(
      rows(page).first().locator(".skill-table-person"),
    ).toHaveAttribute("title", "Mira");
    await expect(
      page.getByRole("columnheader", { name: scene.person }),
    ).toBeVisible();
  });
}

test("Memories tell repeated file names apart by agent, and the Kind filter splits instruction files from memories", async ({
  page,
}) => {
  await open(page, "Memories");
  const repeated = rows(page).filter({ hasText: "MEMORY.md" });
  await expect(repeated).toHaveCount(2);
  await expect(repeated.locator(".skill-table-agent")).toHaveText([
    "Claude",
    "Codex",
  ]);
  await pick(page, "Kind", "Instruction file");
  await expect(page.locator(".skill-table-open")).toHaveText([
    "AGENTS.md",
    "CLAUDE.md",
    "Sharded pull request checks",
  ]);
  await pick(page, "Agent", "Codex");
  await expect(page.locator(".skill-table-open")).toHaveText(["AGENTS.md"]);
});

test("at 1160 the agent is a logo whose name stays available on hover and to assistive technology", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1160, height: 800 });
  await open(page, "Memories");
  const agent = rows(page).first().locator(".skill-table-agent");
  await expect(agent).toHaveAttribute("title", "Codex");
  const name = agent.locator(".source-label > span");
  await expect(name).toHaveText("Codex");
  expect(await name.evaluate((element) => element.clientWidth)).toBe(1);
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(await name.evaluate((element) => element.clientWidth)).toBeGreaterThan(
    1,
  );
});

test("Sessions list forks flat with a marker after the title, and the Forks filter finds them", async ({
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
  await expect(marked.locator(".skill-table-open")).toHaveText(forks);
  const marker = marked.first().getByRole("img", { name: "Forked session" });
  const title = marked.first().locator(".skill-table-open");
  const [markerBox, titleBox] = [
    (await marker.boundingBox())!,
    (await title.boundingBox())!,
  ];
  expect(markerBox.width).toBe(12);
  expect(markerBox.x).toBeGreaterThan(titleBox.x + titleBox.width);
  expect(markerBox.x - (titleBox.x + titleBox.width)).toBeLessThan(10);
  await pick(page, "Forks", "Forks");
  await expect(page.locator(".skill-table-open")).toHaveText(forks);
  await pick(page, "Forks", "Originals");
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
  await page.locator(".skill-table-open").nth(6).focus();
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
