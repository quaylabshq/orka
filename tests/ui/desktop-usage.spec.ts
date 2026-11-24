import { expect, test } from "@playwright/test";
import {
  resourceLibraryFixture,
  type LibraryWindow,
} from "./fixtures/resource-library.js";

test("records the desktop screens and a successful session launch from real navigation", async ({
  page,
}) => {
  await resourceLibraryFixture(page, { piSession: true, restricted: true });

  const events = async () =>
    page.evaluate(() =>
      (window as unknown as LibraryWindow).library.calls
        .filter(({ command }) => command === "record_desktop_usage")
        .flatMap(({ args }) => args.events),
    );
  let previous = -1;
  const expectEvent = async (event: string) => {
    await expect
      .poll(async () => (await events()).indexOf(event, previous + 1), {
        intervals: [100, 250],
      })
      .toBeGreaterThan(previous);
    previous = (await events()).indexOf(event, previous + 1);
  };

  await expectEvent("project_home_viewed");
  for (const [button, screen] of [
    [/^Memories/, "resource_list_viewed:memory"],
    [/^Skills/, "resource_list_viewed:skill"],
    [/^Plans/, "resource_list_viewed:plan"],
    [/^Reviews/, "review_list_viewed"],
    [/^Sessions/, "resource_list_viewed:session"],
  ] as const) {
    await page.getByRole("button", { name: button }).click();
    await expectEvent(screen);
  }
  await page
    .getByRole("button", { name: "Private Pi session", exact: true })
    .click();
  await page.getByRole("button", { name: "Open in Pi", exact: true }).click();
  await expectEvent("feature:session_resumed");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expectEvent("settings_section_viewed:account");
  await page.getByRole("button", { name: "Members", exact: true }).click();
  await expectEvent("settings_section_viewed:members");
  await page.getByRole("button", { name: "View logs", exact: true }).click();
  await expectEvent("project_logs_viewed");
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expectEvent("project_home_viewed");
});

test("records a resource screen opened directly from Home", async ({
  page,
}) => {
  await resourceLibraryFixture(page);
  const events = () =>
    page.evaluate(() =>
      (window as unknown as LibraryWindow).library.calls
        .filter(({ command }) => command === "record_desktop_usage")
        .flatMap(({ args }) => args.events),
    );
  await expect.poll(events).toEqual(["project_home_viewed"]);
  await page
    .getByRole("list", { name: "Recently updated resources" })
    .getByRole("button", { name: /My shared session/ })
    .click();
  await expect.poll(events).toContain("resource_detail_viewed:session");
});
