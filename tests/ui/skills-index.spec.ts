import { test, expect, type Page } from "@playwright/test";
import {
  skillsIndexFixture,
  type SkillsScene,
} from "./fixtures/skills-index.js";

const regular = { width: 1160, height: 800 };
const compact = { width: 900, height: 640 };
const busy: SkillsScene = {
  repositories: "many",
  locals: true,
  conflict: true,
  review: true,
  governed: true,
  extremes: true,
};
const rows = (page: Page) => page.locator(".skill-table tbody tr");
const names = (page: Page) => page.locator(".skill-table-open");
const filter = (page: Page) => page.getByRole("button", { name: /^Filter/ });
const sort = (page: Page) => page.getByRole("button", { name: /^Sort/ });
const pills = (page: Page) => page.locator(".skill-status-pill");
const pick = async (page: Page, category: string, option: string) => {
  await filter(page).click();
  await page.getByRole("menuitem", { name: category }).click();
  await page
    .getByRole("menuitemcheckbox", { name: option, exact: true })
    .click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
};

for (const viewport of [regular, compact]) {
  test(`long and missing text never breaks a row or the toolbar at ${viewport.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await skillsIndexFixture(page, busy);
    await expect(rows(page).first()).toBeVisible();
    // Sorting by name can move the long skill; find it by its title.
    const long = names(page).filter({ hasText: "issue-investigate-followup" });
    await expect(long).toHaveAttribute(
      "title",
      /issue-investigate-followup-for-community-pull-requests/,
    );
    const layout = await page.evaluate(() => {
      const box = (element: Element) => element.getBoundingClientRect();
      const table = document.querySelector(".skill-table")!;
      const toolbar = Array.from(
        document.querySelectorAll(
          ".skill-toolbar > *, .index-toolbar-actions > *",
        ),
      ).filter(
        (element) => !element.classList.contains("index-toolbar-actions"),
      );
      const rowIssues: string[] = [];
      for (const row of Array.from(table.querySelectorAll("tbody tr"))) {
        const name = row.querySelector(".skill-table-open")!;
        const more = row.querySelector(".skill-table-actions button");
        if (box(row).height !== 44) rowIssues.push(`height ${box(row).height}`);
        if (more && box(name).right > box(more).left)
          rowIssues.push(`name under more: ${name.textContent}`);
        for (const cell of Array.from(row.children)) {
          const inner = cell.firstElementChild;
          if (inner && box(inner).right > box(cell).right + 0.5)
            rowIssues.push(`overflow in ${name.textContent}`);
        }
        const pill = row.querySelector(".skill-status-pill");
        if (pill && pill.scrollWidth > pill.clientWidth)
          rowIssues.push(`status cut: ${pill.textContent}`);
      }
      const overlaps = toolbar.some((element, index) =>
        toolbar.some(
          (other, otherIndex) =>
            otherIndex > index &&
            box(element).right > box(other).left + 0.5 &&
            box(other).right > box(element).left + 0.5 &&
            box(element).bottom > box(other).top + 0.5 &&
            box(other).bottom > box(element).top + 0.5,
        ),
      );
      return {
        pageOverflow: document.documentElement.scrollWidth > innerWidth,
        tableRight: box(table).right,
        rowIssues,
        overlaps,
        longTruncated:
          Array.from(
            table.querySelectorAll<HTMLElement>(".skill-table-open"),
          ).find((element) => element.textContent!.includes("followup"))!
            .scrollWidth >
          Array.from(
            table.querySelectorAll<HTMLElement>(".skill-table-open"),
          ).find((element) => element.textContent!.includes("followup"))!
            .clientWidth,
        toolbarRight: Math.max(...toolbar.map((element) => box(element).right)),
      };
    });
    expect(layout.pageOverflow).toBe(false);
    expect(layout.rowIssues).toEqual([]);
    expect(layout.overlaps).toBe(false);
    expect(layout.longTruncated).toBe(true);
    // A long repository name is cut inside its cell and kept whole in its title.
    const repository = page
      .locator(".skill-table-repository-label")
      .filter({ hasText: "infrastructure-and-deployment" })
      .first();
    await expect(repository).toHaveAttribute(
      "title",
      "infrastructure-and-deployment-scripts",
    );
    if (viewport.width === compact.width)
      expect(
        await repository
          .locator("span")
          .evaluate((element) => element.scrollWidth > element.clientWidth),
      ).toBe(true);
    expect(layout.tableRight).toBeLessThanOrEqual(viewport.width);
    expect(layout.toolbarRight).toBeLessThanOrEqual(viewport.width);
    // The full name and description stay reachable in the peek.
    await long.hover();
    const peek = page.locator(".skill-table").getByRole("tooltip");
    await expect(peek).toContainText("Act on an issue-investigate report");
    const peekBox = (await peek.boundingBox())!;
    expect(peekBox.x).toBeGreaterThanOrEqual(0);
    expect(peekBox.x + peekBox.width).toBeLessThanOrEqual(viewport.width);
    await page.mouse.move(0, 0);
    await expect(peek).toHaveCount(0);
  });
}

test("a skill with an empty or unreadable description says so in the peek", async ({
  page,
}) => {
  await skillsIndexFixture(page, { extremes: true });
  // With extremes, the second and third skills have no description.
  for (const title of ["pr-polish", "issue-investigate"]) {
    const row = rows(page).filter({
      has: page.getByRole("button", { name: title, exact: true }),
    });
    await row.hover();
    await expect(row.getByRole("tooltip")).toHaveText("No description");
    await page.mouse.move(0, 0);
  }
  await expect(page.locator(".skill-table").getByRole("tooltip")).toHaveCount(
    0,
  );
});

test("only one description peek is open, and scrolling closes it", async ({
  page,
}) => {
  await skillsIndexFixture(page, { count: 60 });
  await rows(page).nth(1).hover();
  const peek = page.locator(".skill-table").getByRole("tooltip");
  await expect(peek).toHaveCount(1);
  await rows(page).nth(4).hover();
  await expect(peek).toHaveCount(1);
  await expect(rows(page).nth(4).getByRole("tooltip")).toBeVisible();
  await page.locator(".resource-index-body").evaluate((element) => {
    element.scrollTop = 200;
  });
  await expect(peek).toHaveCount(0);
});

test("filters narrow the list, show as chips, and clear one at a time or all at once", async ({
  page,
}) => {
  await skillsIndexFixture(page, busy);
  const total = await rows(page).count();
  await pick(page, "Status", "Sharing blocked");
  await expect(pills(page)).toHaveText(["Sharing blocked"]);
  await expect(filter(page)).toContainText("1");
  const chips = page.getByRole("group", { name: "Active filters" });
  await expect(chips).toContainText("Sharing blocked");
  // One chip has nothing else to clear.
  await expect(chips.getByRole("button", { name: "Clear all" })).toHaveCount(0);
  await pick(page, "Status", "Conflict");
  await expect(pills(page)).toHaveText(["Conflict", "Sharing blocked"]);
  await pick(page, "Location", "On this Mac");
  await expect(pills(page)).toHaveText(["Sharing blocked"]);
  await expect(filter(page)).toContainText("3");
  await chips.getByRole("button", { name: "Remove Location filter" }).click();
  await expect(rows(page)).toHaveCount(2);
  // The removed chip's button is gone, so focus moves to Filter.
  await expect(filter(page)).toBeFocused();
  await pick(page, "Location", "On this Mac");
  await chips.getByRole("button", { name: "Clear all" }).click();
  await expect(rows(page)).toHaveCount(total);
  await expect(chips).toHaveCount(0);
  await expect(filter(page)).toBeFocused();
});

test("a search with filters and no results offers both ways out", async ({
  page,
}) => {
  await skillsIndexFixture(page, busy);
  const total = await rows(page).count();
  const search = page.getByRole("searchbox", { name: "Search skills" });
  await search.fill("no such skill");
  await expect(
    page.getByRole("heading", { name: "No skills match “no such skill”" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Clear search", exact: true })
    .last()
    .click();
  await expect(rows(page)).toHaveCount(total);
  await pick(page, "Status", "Conflict");
  await search.fill("no such skill");
  await expect(
    page.getByRole("heading", {
      name: "No skills match “no such skill” with these filters",
    }),
  ).toBeVisible();
  // The toolbar and chips stay, so the filters can still be changed.
  await expect(filter(page)).toBeVisible();
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "No skills match “no such skill”" }),
  ).toBeVisible();
  await page
    .locator(".empty-state")
    .getByRole("button", { name: "Clear search", exact: true })
    .click();
  await expect(rows(page)).toHaveCount(total);
});

test("sorting by status puts the most urgent first and the direction reverses it", async ({
  page,
}) => {
  await skillsIndexFixture(page, busy);
  await expect(
    page.getByRole("columnheader", { name: "Skill" }),
  ).toHaveAttribute("aria-sort", "ascending");
  await sort(page).click();
  await page
    .getByRole("menuitemradio", { name: "Status", exact: true })
    .click();
  await expect(sort(page)).toContainText("Status");
  await expect(
    page.getByRole("columnheader", { name: "Status" }),
  ).toHaveAttribute("aria-sort", "ascending");
  await expect(pills(page).first()).toHaveText("Conflict");
  // Skills with no status sink to the bottom.
  await expect(rows(page).last().locator(".skill-status-pill")).toHaveCount(0);
  await sort(page).click();
  await page
    .getByRole("menuitemradio", { name: "Least urgent first", exact: true })
    .click();
  await expect(rows(page).first().locator(".skill-status-pill")).toHaveCount(0);
  await expect(pills(page).last()).toHaveText("Conflict");
  // Picking the current sort again keeps its direction.
  await sort(page).click();
  await page
    .getByRole("menuitemradio", { name: "Status", exact: true })
    .click();
  await expect(pills(page).last()).toHaveText("Conflict");
  // A new sort starts in its natural direction again.
  await sort(page).click();
  await page.getByRole("menuitemradio", { name: "Name", exact: true }).click();
  const titles = await names(page).allTextContents();
  expect(titles).toEqual(
    [...titles].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    ),
  );
});

test("search, filters and sort survive opening a skill, and focus returns to its row", async ({
  page,
}) => {
  await skillsIndexFixture(page, busy);
  await pick(page, "Location", "Shared with the project");
  await sort(page).click();
  await page
    .getByRole("menuitemradio", { name: "Z to A", exact: true })
    .click();
  await page.getByRole("searchbox", { name: "Search skills" }).fill("re");
  const before = await names(page).allTextContents();
  expect(before.length).toBeGreaterThan(1);
  const target = names(page).nth(1);
  const title = (await target.textContent())!;
  await target.click();
  await page
    .getByRole("button", { name: "Back to Skills", exact: true })
    .click();
  await expect(names(page)).toHaveText(before);
  await expect(
    page.getByRole("searchbox", { name: "Search skills" }),
  ).toHaveValue("re");
  await expect(filter(page)).toContainText("1");
  await expect(
    page.getByRole("button", { name: title, exact: true }),
  ).toBeFocused();
});

test("the filter menu works from the keyboard and returns focus to its button", async ({
  page,
}) => {
  await skillsIndexFixture(page, busy);
  await filter(page).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Status" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("menuitemcheckbox", { name: "Conflict", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Space");
  // The submenu stays open so more options can be ticked.
  await expect(
    page.getByRole("menuitemcheckbox", { name: "Conflict", exact: true }),
  ).toBeChecked();
  await expect(pills(page)).toHaveText(["Conflict"]);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(filter(page)).toBeFocused();
});

test("a row menu is one flat list, and after dismissing it Enter still opens the skill", async ({
  page,
}) => {
  await skillsIndexFixture(page, busy);
  const row = rows(page).nth(3);
  const name = row.locator(".skill-table-open");
  const title = (await name.textContent())!;
  await row.click({ button: "right", position: { x: 40, y: 20 } });
  const menu = page.getByRole("menu", { name: "skill actions", exact: true });
  await expect(menu).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "More actions", exact: true }),
  ).toHaveCount(0);
  await expect(
    menu.getByRole("menuitem", { name: "Copy link", exact: true }),
  ).toBeVisible();
  // The right-click did not open the skill.
  await expect(rows(page).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  const actions = row.getByRole("button", { name: `Actions for ${title}` });
  await actions.click();
  await expect(page.getByRole("menu")).toBeVisible();
  // An open menu keeps the description out of its way.
  await expect(page.locator(".skill-table").getByRole("tooltip")).toHaveCount(
    0,
  );
  await page.keyboard.press("Escape");
  await expect(actions).toBeFocused();
  await name.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "Back to Skills", exact: true }),
  ).toBeVisible();
});

test("two hundred skills scroll under a fixed toolbar, and the last row's menu stays on screen", async ({
  page,
}) => {
  await page.setViewportSize(compact);
  await skillsIndexFixture(page, { count: 200 });
  await expect(rows(page)).toHaveCount(200);
  const add = page.getByRole("button", { name: "Add skills", exact: true });
  const before = await add.boundingBox();
  const list = page.locator(".resource-index-body");
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  expect(await add.boundingBox()).toEqual(before);
  await expect(filter(page)).toBeVisible();
  // Rows pass under the toolbar, not over it.
  const covered = await page.evaluate(() => {
    const button = document.querySelector(
      ".skill-toolbar .index-menu-trigger",
    )!;
    const box = button.getBoundingClientRect();
    const top = document.elementFromPoint(
      box.left + box.width / 2,
      box.top + box.height / 2,
    );
    return !button.contains(top);
  });
  expect(covered).toBe(false);
  const last = rows(page).last();
  await last.getByRole("button", { name: /^Actions for/ }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  const box = (await menu.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(compact.height);
  expect(box.x + box.width).toBeLessThanOrEqual(compact.width);
});

test("the Skills toolbar has no refresh button", async ({ page }) => {
  await skillsIndexFixture(page);
  await expect(filter(page)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Refresh local items" }),
  ).toHaveCount(0);
});

test("skills with no repository leave the cell empty and are not offered as a filter", async ({
  page,
}) => {
  await skillsIndexFixture(page, { repositories: "removed" });
  await expect(rows(page).first()).toBeVisible();
  const cells = page.locator(".skill-table-repository");
  const labelled = page.locator(".skill-table-repository-label");
  expect(await labelled.count()).toBeLessThan(await cells.count());
  await filter(page).click();
  await page.getByRole("menuitem", { name: "Repository" }).click();
  const options = await page.getByRole("menuitemcheckbox").allTextContents();
  expect(options.length).toBeGreaterThan(1);
  expect(options.every((option) => option.trim().length > 0)).toBe(true);
});

test("an empty project keeps its own Add button, which opens the same popover", async ({
  page,
}) => {
  await skillsIndexFixture(page, { count: 0 });
  await expect(page.locator(".skill-table")).toHaveCount(0);
  await expect(
    page.getByRole("searchbox", { name: "Search skills" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Add skills", exact: true }).click();
  const popover = page.getByRole("dialog", { name: "Add global skills" });
  await expect(popover.getByRole("checkbox").first()).toBeVisible();
  const box = (await popover.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(regular.width);
  expect(box.y + box.height).toBeLessThanOrEqual(regular.height);
});

test("a member whose role hides shared skills sees the restriction, not an empty table", async ({
  page,
}) => {
  await skillsIndexFixture(page, {
    role: "member",
    governed: true,
    access: "hidden",
    count: 0,
  });
  await expect(
    page.getByRole("heading", {
      name: "Access to shared skills is restricted.",
    }),
  ).toBeVisible();
  await expect(page.locator(".skill-table")).toHaveCount(0);
});

test("the Add skills popover and its details fit the minimum window", async ({
  page,
}) => {
  await page.setViewportSize(compact);
  await skillsIndexFixture(page, { repositories: "many" });
  await page.getByRole("button", { name: "Add skills", exact: true }).click();
  const popover = page.getByRole("dialog", { name: "Add global skills" });
  await expect(popover.getByRole("checkbox").nth(1)).toBeVisible();
  const box = (await popover.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(compact.height);
  expect(box.x + box.width).toBeLessThanOrEqual(compact.width);
  // The Add button is on screen without scrolling the popover.
  const submit = popover.getByRole("button", {
    name: "Add skills",
    exact: true,
  });
  const submitBox = (await submit.boundingBox())!;
  expect(submitBox.y + submitBox.height).toBeLessThanOrEqual(compact.height);
  await popover.locator(".add-skills-row").nth(2).hover();
  const peek = popover.getByRole("tooltip");
  await expect(peek).toBeVisible();
  const peekBox = (await peek.boundingBox())!;
  expect(peekBox.x).toBeGreaterThanOrEqual(0);
  expect(peekBox.y).toBeGreaterThanOrEqual(0);
  expect(peekBox.y + peekBox.height).toBeLessThanOrEqual(compact.height);
  expect(peekBox.x + peekBox.width).toBeLessThanOrEqual(box.x);
  // A long repository name is cut inside its control, not across the row.
  const control = popover.getByRole("button", { name: "Add to repository" });
  const controlBox = (await control.boundingBox())!;
  expect(controlBox.x + controlBox.width).toBeLessThanOrEqual(
    box.x + box.width,
  );
  expect(controlBox.width).toBeLessThanOrEqual(190);
});

test("columns follow the whole collection, so filtering never adds or removes one", async ({
  page,
}) => {
  await skillsIndexFixture(page, busy);
  const headers = page.getByRole("columnheader");
  const before = await headers.allTextContents();
  expect(before).toContain("Shared by");
  // Every skill on this Mac is yours, but the Shared by column stays.
  await pick(page, "Location", "On this Mac");
  await expect(rows(page).first()).toBeVisible();
  expect(await headers.allTextContents()).toEqual(before);
});

test("at the minimum window the Shared by column keeps its name for assistive technology", async ({
  page,
}) => {
  await page.setViewportSize(compact);
  await skillsIndexFixture(page, busy);
  await expect(
    page.getByRole("columnheader", { name: "Shared by" }),
  ).toBeVisible();
  const person = rows(page).first().locator(".skill-table-person");
  await expect(person.locator(".skill-table-person-name")).not.toBeEmpty();
  // The name is visually hidden, not removed.
  expect(
    await person
      .locator(".skill-table-person-name")
      .evaluate((element) => getComputedStyle(element).display),
  ).not.toBe("none");
  expect((await person.boundingBox())!.width).toBeLessThanOrEqual(24);
});

test("a description near the bottom of the window opens upward and names its row", async ({
  page,
}) => {
  await page.setViewportSize(compact);
  await skillsIndexFixture(page, { count: 60 });
  const view = (await page.locator(".resource-index-body").boundingBox())!;
  // The last row fully on screen, wherever the list is scrolled.
  const index = await rows(page).evaluateAll((elements, bottom) => {
    let last = 0;
    elements.forEach((element, position) => {
      if (element.getBoundingClientRect().bottom <= bottom) last = position;
    });
    return last;
  }, view.y + view.height);
  const row = rows(page).nth(index);
  await row.hover();
  const peek = row.getByRole("tooltip");
  await expect(peek).toBeVisible();
  const box = (await peek.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(view.y + view.height);
  await expect(row.locator(".skill-table-open")).toHaveAttribute(
    "aria-describedby",
    (await peek.getAttribute("id"))!,
  );
});

test("clearing Skills search and filters preserves the Plans repository", async ({
  page,
}) => {
  await skillsIndexFixture(page, { repositories: true, plans: true });
  const plans = page.getByRole("button", { name: /^Plans/ });
  const skills = page.getByRole("button", { name: /^Skills/ });
  const repository = page
    .getByRole("group", { name: "Active filters" })
    .filter({ hasText: "Repository" });
  await plans.click();
  await pick(page, "Repository", "desktop");
  await skills.click();
  const empty = page.locator(".empty-state");
  await page
    .getByRole("searchbox", { name: "Search skills" })
    .fill("no such skill");
  await empty
    .getByRole("button", { name: "Clear search", exact: true })
    .click();
  await plans.click();
  await expect(repository).toContainText("desktop");
  await expect(rows(page)).toHaveCount(1);

  await skills.click();
  await pick(page, "Status", "Upload failed");
  await empty
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await plans.click();
  await expect(repository).toContainText("desktop");
  await expect(rows(page)).toHaveCount(1);
});

test("navigation to Skills and its readers preserves the Plans repository", async ({
  page,
}) => {
  await skillsIndexFixture(page, { repositories: true, count: 3, plans: true });
  const plans = page.getByRole("button", { name: /^Plans/ });
  const repository = page
    .getByRole("group", { name: "Active filters" })
    .filter({ hasText: "Repository" });
  await plans.click();
  await pick(page, "Repository", "desktop");
  await page.getByRole("button", { name: /^Skills/ }).click();
  await page.getByRole("button", { name: "pr-polish", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Back to Skills" }),
  ).toBeVisible();
  await plans.click();
  await expect(repository).toContainText("desktop");
  await expect(rows(page)).toHaveCount(1);
});

test("a long description preview and its origin fit the minimum window", async ({
  page,
}) => {
  await page.setViewportSize(compact);
  await skillsIndexFixture(page, { count: 8, longDescription: true });
  const name = page.getByRole("button", { name: "code-review", exact: true });
  await name.hover();
  const peek = page.getByRole("tooltip");
  await expect(peek).toContainText("Review changes with supporting scripts");
  await expect(peek).toContainText("From your global skills");
  const view = (await page.locator(".resource-index-body").boundingBox())!;
  const box = (await peek.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(view.y);
  expect(box.y + box.height).toBeLessThanOrEqual(view.y + view.height);
  expect(box.height).toBeLessThan(144);
  await name.click();
  await expect(page.locator(".skill-description")).toContainText(
    "Review changes with supporting scripts",
  );
});

test("a read failure outranks an available update and appears in the status filter", async ({
  page,
}) => {
  await skillsIndexFixture(page, {
    count: 8,
    repositories: true,
    governed: true,
    review: true,
    skillReadFailure: true,
  });
  const row = rows(page).filter({
    has: page.getByRole("button", { name: "code-review", exact: true }),
  });
  await expect(row.locator(".skill-status-pill")).toHaveText("Could not read");
  await pick(page, "Status", "Could not read");
  await expect(rows(page)).toHaveCount(1);
  await expect(row).toBeVisible();
});
