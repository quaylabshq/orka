import { test, expect, type Locator, type Page } from "@playwright/test";
import { listsIndexFixture, type ListsScene } from "./fixtures/lists-index.js";

const peek = (page: Page) => page.locator(".index-table").getByRole("tooltip");
const title = (page: Page, name: string) =>
  page.locator(".index-table").getByRole("button", { name, exact: true });
const actions = (page: Page, name: string) =>
  page.getByRole("button", { name: `Actions for ${name}`, exact: true });
const body = (page: Page) => page.locator(".resource-index-body");
const scrollTop = (page: Page) =>
  body(page).evaluate((element) => element.scrollTop);
/** Scrolls the list down, as a person would, until `row` is drawn and in view. */
const reveal = async (page: Page, row: Locator) => {
  while (!(await row.count()))
    await body(page).evaluate((element) => {
      element.scrollTop += element.clientHeight / 2;
    });
  await row.scrollIntoViewIfNeeded();
};

const open = async (page: Page, label: string, scene: ListsScene = {}) => {
  await listsIndexFixture(page, scene);
  await page.getByRole("button", { name: new RegExp(`^${label}`) }).click();
  await expect(page.locator(".index-table tbody th").first()).toBeVisible();
};

/**
 * Later snapshots report the session in `window.listsBumped` as updated just
 * now, so it sorts to the top of Last updated.
 */
const bumpable = (page: Page) =>
  page.addInitScript(() => {
    let inner: any;
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      get: () => inner,
      set(value) {
        const invoke = value.invoke;
        value.invoke = async (name: string, args: unknown) => {
          const result = await invoke(name, args);
          const bumped = (window as any).listsBumped;
          if (name === "snapshot")
            for (const resource of result.resources)
              if (resource.resourceId === bumped)
                resource.updatedAt = new Date().toISOString();
          return result;
        };
        inner = value;
      },
    });
  });

/** Resolves once the app has applied one more snapshot from the fixture. */
const nextSnapshot = async (page: Page) => {
  const calls = () =>
    page.evaluate(
      () =>
        (window as any).listsCalls.filter(
          (call: { name: string }) => call.name === "snapshot",
        ).length,
    );
  const seen = await calls();
  await expect.poll(calls, { timeout: 10_000 }).toBeGreaterThan(seen);
  // Let React apply it and the browser draw it.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
};

/** WebKit on macOS moves focus to buttons with Option-Tab, as Safari does. */
const tab = (page: Page, browserName: string) =>
  page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");

/** Long enough for a peek that was going to open to have opened. */
const peekWait = 600;

test("a row's peek opens when Tab reaches it, but not when focus comes back to it", async ({
  page,
  browserName,
}) => {
  await open(page, "Sessions");
  const first = "Fix packaged launcher identity on reinstall";
  const second = "Skills index redesign review";
  // Keyboard navigation onto a row opens its peek.
  await actions(page, first).focus();
  await tab(page, browserName);
  await expect(title(page, second)).toBeFocused();
  await expect(peek(page)).toBeVisible();
  // Escape from its menu hands focus back without opening the peek.
  await tab(page, browserName);
  await expect(actions(page, second)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(actions(page, second)).toBeFocused();
  await page.waitForTimeout(peekWait);
  await expect(peek(page)).toHaveCount(0);
  // Back from the item hands focus back without opening the peek.
  await title(page, second).focus();
  await page.keyboard.press("Enter");
  const back = page.getByRole("button", {
    name: "Back to Sessions",
    exact: true,
  });
  await back.focus();
  await page.keyboard.press("Enter");
  await expect(title(page, second)).toBeFocused();
  await page.waitForTimeout(peekWait);
  await expect(peek(page)).toHaveCount(0);
});

test("after a row leaves under its open menu, other rows still open their peek", async ({
  page,
}) => {
  await open(page, "Plans");
  const leaving = page.locator('.index-table [data-resource-id="plan-6"]');
  const name = (await leaving.textContent())!;
  await actions(page, name).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.evaluate(() => ((window as any).listsHidden = ["plan-6"]));
  await expect(leaving).toHaveCount(0);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.mouse.move(0, 0);
  await title(page, "Repository filter across collections").hover();
  await expect(peek(page)).toBeVisible();
});

test("a refresh never scrolls the list back to the focused row", async ({
  page,
}) => {
  await bumpable(page);
  await open(page, "Sessions", { sessions: 60 });
  const name = "Archived session 1";
  await title(page, name).click();
  await page
    .getByRole("button", { name: "Back to Sessions", exact: true })
    .click();
  await expect(title(page, name)).toBeFocused();
  await body(page).evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const left = await scrollTop(page);
  expect(left).toBeGreaterThan(1000);
  await nextSnapshot(page);
  expect(await scrollTop(page)).toBe(left);
  // Nor when the refresh moves that row somewhere else.
  await page.evaluate(() => ((window as any).listsBumped = "session-16"));
  await nextSnapshot(page);
  expect(await scrollTop(page)).toBe(left);
  await expect(title(page, name)).toBeFocused();
});

test("a focused row in view that a refresh moves stays in view", async ({
  page,
}) => {
  await bumpable(page);
  await open(page, "Sessions", { sessions: 60 });
  const name = "Archived session 40";
  const row = title(page, name);
  await reveal(page, row);
  await row.focus();
  await page.evaluate(() => ((window as any).listsBumped = "session-55"));
  await nextSnapshot(page);
  await expect(page.locator(".index-table-open").first()).toHaveText(name);
  await expect(row).toBeInViewport();
  await expect(row).toBeFocused();
});

test("two thousand sessions draw only the rows near view and reach the last one", async ({
  page,
}) => {
  await open(page, "Sessions", { sessions: 2000 });
  const table = page.getByRole("table");
  await expect(table).toHaveAttribute("aria-rowcount", "2017");
  const drawn = page.locator(".index-table tbody tr[aria-rowindex]");
  expect(await drawn.count()).toBeLessThan(80);
  await body(page).evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const last = page.locator('.index-table tr[aria-rowindex="2017"]');
  await expect(last).toBeInViewport();
  expect(await drawn.count()).toBeLessThan(80);
  // Headers and the rows drawn are what a screen reader is told about.
  await expect(table.getByRole("columnheader").first()).toHaveText("Session");
  await expect(last.getByRole("rowheader")).toHaveCount(1);
});

test("Back focuses a row far down the list that was not drawn", async ({
  page,
}) => {
  await open(page, "Sessions", { sessions: 300 });
  const name = "Archived session 270";
  const row = title(page, name);
  await expect(row).toHaveCount(0);
  await reveal(page, row);
  await row.click();
  await page
    .getByRole("button", { name: "Back to Sessions", exact: true })
    .click();
  await expect(row).toBeFocused();
  await expect(row).toBeInViewport();
  await expect(peek(page)).toHaveCount(0);
});

test("focus survives scrolling its row out of view, and a menu returns focus there", async ({
  page,
}) => {
  await open(page, "Sessions", { sessions: 300 });
  const name = "Fix packaged launcher identity on reinstall";
  await actions(page, name).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await body(page).evaluate((element) => {
    element.scrollTop = element.scrollHeight / 2;
  });
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(actions(page, name)).toBeFocused();
  await body(page).evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(actions(page, name)).toBeFocused();
  await expect(actions(page, name)).not.toBeInViewport();
});

test("Tab walks the rows in order past the ones first drawn", async ({
  page,
  browserName,
}) => {
  await open(page, "Sessions", { sessions: 300 });
  const names = page.locator(".index-table-open");
  await names.first().focus();
  for (let step = 0; step < 2 * 60; step++) await tab(page, browserName);
  const focused = page.locator(".index-table-open:focus");
  await expect(focused).toBeInViewport();
  await expect(focused.locator("xpath=ancestor::tr")).toHaveAttribute(
    "aria-rowindex",
    "62",
  );
});

test("a peek with a long path stays inside the list at the minimum window", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 640 });
  // Every repository folder is about 350 characters long.
  await page.addInitScript(() => {
    let inner: any;
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      get: () => inner,
      set(value) {
        const invoke = value.invoke;
        value.invoke = async (name: string, args: unknown) => {
          const result = await invoke(name, args);
          if (name === "snapshot")
            for (const project of result.projects)
              for (const source of project.sources)
                source.path &&= source.path.replace(
                  "/code/",
                  `/code/${"a-long-folder-name-for-the-peek/".repeat(10)}`,
                );
          return result;
        };
        inner = value;
      },
    });
  });
  await open(page, "Sessions", { sessions: 60 });
  const view = (await body(page).boundingBox())!;
  const rows = page.locator(".index-table tbody tr[aria-rowindex]");
  // The lowest row with the old 144 px of room under it.
  const index = await rows.evaluateAll((elements, bottom) => {
    let last = 0;
    elements.forEach((element, position) => {
      if (element.getBoundingClientRect().bottom + 144 <= bottom)
        last = position;
    });
    return last;
  }, view.y + view.height);
  const row = rows.nth(index);
  await page.mouse.move(0, 0);
  await row.locator(".index-table-open").hover();
  const tip = row.getByRole("tooltip");
  await expect(tip).toContainText("a-long-folder-name-for-the-peek");
  const box = (await tip.boundingBox())!;
  expect(box.height).toBeGreaterThan(188);
  expect(box.y).toBeGreaterThanOrEqual(view.y);
  expect(box.y + box.height).toBeLessThanOrEqual(view.y + view.height);
});
