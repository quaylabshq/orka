import { test, expect, type Page } from "@playwright/test";
import { listsIndexFixture, type ListsScene } from "./fixtures/lists-index.js";

const peek = (page: Page) => page.locator(".index-table").getByRole("tooltip");
const title = (page: Page, name: string) =>
  page.locator(".index-table").getByRole("button", { name, exact: true });
const actions = (page: Page, name: string) =>
  page.getByRole("button", { name: `Actions for ${name}`, exact: true });

const open = async (page: Page, label: string, scene: ListsScene = {}) => {
  await listsIndexFixture(page, scene);
  await page.getByRole("button", { name: new RegExp(`^${label}`) }).click();
  await expect(page.locator(".index-table tbody th").first()).toBeVisible();
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
