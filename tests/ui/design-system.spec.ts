import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

test("a primary button has distinct press feedback with reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?design-system");
  const gallery = page.getByRole("dialog", { name: "Design system" });
  await gallery.getByRole("button", { name: "Buttons", exact: true }).click();
  const button = gallery
    .getByRole("button", { name: "primary", exact: true })
    .first();
  await button.hover();
  await expect(button).toHaveCSS("filter", "none");
  await page.mouse.down();
  await expect(button).toHaveCSS("filter", /brightness\(0\.\d+\)/);
  await expect(button).toHaveCSS("transform", "none");
  await page.mouse.up();
  await expect(button).toHaveCSS("filter", "none");
});

test("the pinned input hover matches a live field", async ({ page }) => {
  await page.goto("/?design-system");
  const gallery = page.getByRole("dialog", { name: "Design system" });
  const live = gallery.locator(".ds-demo .ui-field__control").first();
  const pinned = gallery.locator(".ds-hover .ui-field__control");
  const restingFill = await live.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  const pinnedShadow = await pinned.evaluate(
    (element) => getComputedStyle(element).boxShadow,
  );
  expect(pinnedShadow).not.toBe("none");
  await live.hover();
  await expect(live).toHaveCSS("box-shadow", pinnedShadow);
  await expect(live).toHaveCSS("background-color", restingFill);
  await expect(pinned).toHaveCSS("background-color", restingFill);
});

test("the checked-in component preview shows the current variants and states", async ({
  page,
}) => {
  const preview = new URL(
    "../../docs/design-system/components.html",
    import.meta.url,
  );
  await page.setContent(readFileSync(preview, "utf8"));
  const table = page.locator(".states-table");
  await expect(table.getByRole("columnheader")).toHaveText([
    "State",
    "primary",
    "secondary",
    "tertiary",
  ]);
  const section = page.locator(".component-sheet section").first();
  await expect(section).toHaveCSS("border-bottom-width", "1px");
  await expect(table.locator("tbody tr").first()).toHaveCSS(
    "border-top-width",
    "1px",
  );
  await expect(
    table.locator(".ui-button--primary.preview-state-pressed").first(),
  ).toHaveCSS("filter", /brightness\(0\.\d+\)/);
});

test("the Modal sample opens at each of the three widths with one title row", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?design-system");
  const gallery = page.getByRole("dialog", { name: "Design system" });
  await gallery.getByRole("button", { name: "Modals", exact: true }).click();
  for (const [size, width] of [
    ["compact", 340],
    ["default", 390],
    ["wide", 640],
  ] as const) {
    await gallery
      .getByRole("button", { name: `${size} / ${width}px`, exact: true })
      .click();
    const sample = page.getByRole("dialog", { name: "Delete shared plan" });
    await expect(sample).toBeVisible();
    expect((await sample.boundingBox())!.width).toBeCloseTo(width, 0);
    await expect(sample.locator("h2")).toHaveCount(1);
    await expect(sample.getByRole("button", { name: "Close" })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`modal-${size}.png`),
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await expect(sample).toHaveCount(0);
    await expect(gallery).toBeVisible();
  }
});
