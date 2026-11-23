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
  const path: string[] = [];
  const expectEvent = async (event: string) => {
    path.push(event);
    await expect.poll(events, { intervals: [100, 250] }).toEqual(path);
  };

  await expectEvent("screen:projects");
  for (const [button, screen] of [
    [/^Memories/, "memories"],
    [/^Skills/, "skills"],
    [/^Plans/, "plans"],
    [/^Reviews/, "reviews"],
    [/^Sessions/, "sessions"],
  ] as const) {
    await page.getByRole("button", { name: button }).click();
    await expectEvent(`screen:${screen}`);
  }
  await page
    .getByRole("button", { name: "Private Pi session", exact: true })
    .click();
  await page.getByRole("button", { name: "Open in Pi", exact: true }).click();
  await expectEvent("feature:session_resumed");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expectEvent("screen:settings");
  await page.getByRole("button", { name: "Members", exact: true }).click();
  await expectEvent("screen:members");
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expectEvent("screen:projects");
});
