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
    review: "Conflicts panel handoff",
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
    await pick(page, "Status", "Needs review");
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page)).toContainText(scene.review);
  });

  test(`${scene.label} open newest first, and a sort by status puts the most urgent first`, async ({
    page,
  }) => {
    await open(page, scene.label);
    await expect(page.getByRole("button", { name: /^Sort/ })).toContainText(
      "Last updated",
    );
    await expect(
      page.getByRole("columnheader", { name: "Updated" }),
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
