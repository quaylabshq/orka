import { test, expect, type Locator } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import {
  metadataLoadingFixture,
  type MetadataWindow,
} from "./fixtures/metadata-loading.js";

async function expectFadingPlaceholder(placeholder: Locator) {
  await expect(placeholder).toHaveCSS("mask-image", /linear-gradient.*35%/);
  await expect(placeholder).toHaveCSS("filter", "blur(0.75px)");
  await expect(placeholder).toHaveCSS("animation-name", "none");
}

for (const width of [1160, 900]) {
  test(`Home fades pending titles while totals and ready rows remain usable at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 900 ? 640 : 800 });
    await metadataLoadingFixture(page);
    const home = page.locator(".project-home-overview");
    const list = page.getByRole("list", { name: "Recently updated resources" });
    await expect(list.locator(".home-update-title-skeleton")).toHaveCount(6);
    await expect(home.getByRole("status")).toHaveText(
      "Loading recent updates…",
    );
    await expect(
      home.getByRole("button", { name: /^View Skills/ }),
    ).toBeEnabled();
    await expect(list.locator("time")).toHaveCount(6);
    await expect(list).toContainText("Updated by you");
    await expectFadingPlaceholder(list.locator(".loading-fade").first());
    await page.screenshot({
      path: info.outputPath(`home-loading-${width}.png`),
    });
    await page.evaluate(() => {
      const state = (window as unknown as MetadataWindow).metadata;
      state.finishes["skill-1"]();
      state.finishes["session-1"]();
    });
    await expect(list.locator(".home-update-title-skeleton")).toHaveCount(4);
    await expect(
      list.getByRole("button", { name: /^Interface review 1/ }),
    ).toBeVisible();
    await expect(
      list.getByRole("button", { name: /^Session decisions 1/ }),
    ).toBeVisible();
    expect(
      (
        await new AxeBuilder({ page })
          .include(".project-home-overview")
          .analyze()
      ).violations,
    ).toEqual([]);
    expect(
      await home.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await list.locator('[data-resource-id="session-2"]').click();
    await expect(
      page.getByRole("button", { name: "Back to Sessions", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByLabel("Conversation", { exact: true }),
    ).toContainText("Review the actual project context.");
  });

  test(`Skills fade pending descriptions without hiding known rows or controls at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 900 ? 640 : 800 });
    await metadataLoadingFixture(page);
    await page.getByRole("button", { name: /^Skills/ }).click();
    const skills = page.getByRole("region", { name: "skills", exact: true });
    const skillRow = (id: string) =>
      skills.getByRole("row").filter({
        has: page.locator(`[data-resource-id="${id}"]`),
      });
    await expect(skills.locator(".skill-row-description-skeleton")).toHaveCount(
      3,
    );
    const announcement = skills.getByRole("status").filter({
      hasText: "Loading skill descriptions…",
    });
    await expect(announcement).toHaveText("Loading skill descriptions…");
    await expect(
      skills.locator(".resource-table-skill .resource-table-open"),
    ).toHaveText(["Review skill 1", "Review skill 2", "Review skill 3"]);
    await expect(
      page.getByRole("searchbox", { name: "Search skills" }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Add global skills", exact: true }),
    ).toBeEnabled();
    await expect(skills.locator("time")).toHaveCount(3);
    await expectFadingPlaceholder(skills.locator(".loading-fade").first());
    await page.screenshot({
      path: info.outputPath(`skills-loading-${width}.png`),
    });
    await skills.locator('[data-resource-id="skill-2"]').click();
    await expect(
      page.getByRole("button", { name: "Back to Skills", exact: true }),
    ).toBeEnabled();
    await page
      .getByRole("button", { name: "Back to Skills", exact: true })
      .click();
    await expect(skills.locator(".skill-row-description-skeleton")).toHaveCount(
      3,
    );
    await page.evaluate(() =>
      (window as unknown as MetadataWindow).metadata.finishes["skill-1"](),
    );
    await expect(skills.locator(".skill-row-description-skeleton")).toHaveCount(
      2,
    );
    await expect(skillRow("skill-1")).toContainText(
      "Review spacing, typography, and interaction states.",
    );
    await page.evaluate(() => {
      const state = (window as unknown as MetadataWindow).metadata;
      state.failIds.push("skill-2");
      state.finishes["skill-2"]();
      state.finishes["skill-3"]();
    });
    await expect(skills.locator(".skill-row-description-skeleton")).toHaveCount(
      0,
    );
    await expect(announcement).toHaveCount(0);
    await expect(
      skillRow("skill-2").locator(".skill-row-description"),
    ).toHaveCount(0);
    await expect(
      skillRow("skill-3").locator(".skill-row-description"),
    ).toHaveCount(0);
    expect(
      (await new AxeBuilder({ page }).include(".resource-index").analyze())
        .violations,
    ).toEqual([]);
    await skills.locator('[data-resource-id="skill-3"]').click();
    await expect(
      page.getByRole("button", { name: "Back to Skills", exact: true }),
    ).toBeEnabled();
  });
}

test("Home settles failed and missing metadata into usable fallback rows", async ({
  page,
}) => {
  await metadataLoadingFixture(page);
  const home = page.locator(".project-home-overview");
  const list = page.getByRole("list", { name: "Recently updated resources" });
  await expect(list.locator(".home-update-title-skeleton")).toHaveCount(6);
  await page.evaluate(() => {
    const state = (window as unknown as MetadataWindow).metadata;
    state.failIds.push("skill-1", "session-1");
    state.nullTitles.push("session-2");
    state.held = false;
    Object.values(state.finishes).forEach((finish) => finish());
  });
  await expect(list.locator(".home-update-title-skeleton")).toHaveCount(0);
  await expect(home.getByRole("status")).toHaveCount(0);
  for (const title of [
    "Review skill 1",
    "Project session 1",
    "Project session 2",
    "Review skill 3",
  ])
    await expect(
      list.getByRole("button", { name: new RegExp(`^${title}`) }),
    ).toBeEnabled();
  await expect(
    home.getByRole("button", { name: /^View Skills/ }).locator("strong"),
  ).toHaveText("3");
  await expect(list.locator("time")).toHaveCount(6);
  await list.getByRole("button", { name: /^Project session 2/ }).click();
  await expect(
    page.getByRole("button", { name: "Back to Sessions", exact: true }),
  ).toBeEnabled();
  await expect(page.getByLabel("Conversation", { exact: true })).toContainText(
    "Review the actual project context.",
  );
});

test("Home and Skills placeholders stop breathing when reduced motion changes", async ({
  page,
}) => {
  await metadataLoadingFixture(page);
  for (const pageName of ["Home", "Skills"]) {
    if (pageName === "Skills")
      await page.getByRole("button", { name: /^Skills/ }).click();
    const placeholder = page.locator(".loading-fade").first();
    await expectFadingPlaceholder(placeholder);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(placeholder).toHaveCSS("animation-name", "loading-breathe");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expectFadingPlaceholder(placeholder);
  }
});

test("Sessions reuses ready and in-flight Home titles and retries failed reads", async ({
  page,
}) => {
  await metadataLoadingFixture(page);
  const titleCalls = () =>
    page.evaluate(() =>
      (window as unknown as MetadataWindow).metadata.calls
        .filter(({ command }) => command === "session_display_title")
        .map(({ id }) => id),
    );
  await page.evaluate(() =>
    (window as unknown as MetadataWindow).metadata.finishes["session-1"](),
  );
  await expect(
    page.getByRole("button", { name: /^Session decisions 1/ }),
  ).toBeVisible();

  const sessions = page.getByRole("button", { name: /^Sessions/ });
  await sessions.click();
  const table = page.getByRole("table");
  await expect(
    table.getByRole("button", { name: "Session decisions 1", exact: true }),
  ).toBeEnabled();
  await expect(
    table.getByRole("button", { name: "Project session 2", exact: true }),
  ).toBeEnabled();
  await expect(table).toHaveAttribute("aria-busy", "true");

  await expect.poll(titleCalls).toContain("session-3");
  expect((await titleCalls()).sort()).toEqual([
    "session-1",
    "session-2",
    "session-3",
  ]);
  await page.evaluate(() => {
    const state = (window as unknown as MetadataWindow).metadata;
    state.failIds.push("session-2");
    state.finishes["session-2"]();
    state.finishes["session-3"]();
    state.held = false;
  });
  await expect(
    page.getByText("Some session titles are unavailable."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(table).toHaveAttribute("aria-busy", "false");
  await expect(table).toContainText("Session decisions 2");
  await expect(
    page.getByText("Some session titles are unavailable."),
  ).toHaveCount(0);

  await page.getByRole("button", { name: /^Home/ }).click();
  await sessions.click();
  await expect(table).toHaveAttribute("aria-busy", "false");
  expect((await titleCalls()).sort()).toEqual([
    "session-1",
    "session-2",
    "session-2",
    "session-3",
  ]);
});
