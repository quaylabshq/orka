import { expect, test } from "@playwright/test";
import { resourceLibraryFixture } from "./fixtures/resource-library.js";

test("reopening a growing local session refreshes behind its cached turns", async ({
  page,
}) => {
  await resourceLibraryFixture(page);
  await page.getByRole("button", { name: /^Sessions/ }).click();
  const openSession = () =>
    page
      .getByRole("button", { name: "Private session notes", exact: true })
      .click();
  await openSession();
  const conversation = page.getByLabel("Conversation", { exact: true });
  await expect(conversation).toContainText("Private session conversation 0");
  await page
    .getByRole("button", { name: "Back to Sessions", exact: true })
    .click();
  await page.evaluate(() => {
    const w = window as any;
    w.library.tail = 1;
    const original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command === "session_messages")
        await new Promise<void>((resolve) => {
          w.finishSessionRefresh = resolve;
        });
      return original(command, args);
    };
  });
  await openSession();
  await expect(conversation).toContainText("Private session conversation 0");
  await expect(
    page.getByText("Loading messages…", { exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => typeof (window as any).finishSessionRefresh),
    )
    .toBe("function");
  await page.evaluate(() => (window as any).finishSessionRefresh());
  await expect(conversation).toContainText("Private session conversation 1");
});

test("a failed content refresh keeps the conversation readable and retries", async ({
  page,
}) => {
  await page.clock.install();
  await resourceLibraryFixture(page);
  await page.getByRole("button", { name: /^Sessions/ }).click();
  await page
    .getByRole("button", { name: "Private session notes", exact: true })
    .click();
  const conversation = page.getByLabel("Conversation", { exact: true });
  await expect(conversation).toContainText("Private session conversation 0");
  await page.evaluate(() => {
    const w = window as any;
    w.library.tail = 1;
    w.failSessionRefresh = true;
    const original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (command: string, args: any) => {
      if (command === "session_messages" && w.failSessionRefresh)
        return Promise.reject(new Error("Native session read unavailable"));
      return original(command, args);
    };
  });
  await page.clock.runFor(61_000);
  await expect(conversation.getByRole("alert")).toContainText(
    "Native session read unavailable",
  );
  await expect(conversation).toContainText("Private session conversation 0");
  await page.evaluate(() => {
    (window as any).failSessionRefresh = false;
  });
  await conversation
    .getByRole("button", { name: "Retry", exact: true })
    .click();
  await expect(conversation).toContainText("Private session conversation 1");
  await expect(conversation.getByRole("alert")).toHaveCount(0);
});
