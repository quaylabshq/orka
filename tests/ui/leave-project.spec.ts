import { mkdir } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { settingsFixture, settingsCalls } from "./fixtures/settings.js";

test("a member sees Leave project and can confirm it without typing", async ({
  page,
}) => {
  const settings = await settingsFixture(page, { role: "member" });
  const danger = settings.getByRole("region", {
    name: "Danger zone",
    exact: true,
  });
  await expect(
    danger.getByRole("button", { name: "Leave project", exact: true }),
  ).toBeVisible();
  await expect(
    danger.getByRole("button", { name: "Delete project", exact: true }),
  ).toHaveCount(0);
  await expect(
    danger.getByRole("button", { name: "Archive project", exact: true }),
  ).toHaveCount(0);
  await danger
    .getByRole("button", { name: "Leave project", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Leave project?",
    exact: true,
  });
  await expect(dialog).toContainText("lose access");
  await expect(dialog).toContainText("on all your devices");
  await expect(dialog).not.toContainText("on this Mac");
  await expect(dialog).toContainText("other members stay");
  await expect(dialog.getByRole("textbox")).toHaveCount(0);
  await mkdir("/tmp/orka-briefs", { recursive: true });
  await page.screenshot({
    path: "/tmp/orka-briefs/leave-1.png",
    animations: "disabled",
  });
  await dialog
    .getByRole("button", { name: "Leave project", exact: true })
    .click();
  await expect
    .poll(async () =>
      (await settingsCalls(page)).find(
        (call) =>
          call.command === "project_command" && call.args.action === "leave",
      ),
    )
    .toMatchObject({ args: { input: { expectedPolicyRevision: 1 } } });
});

test("a refused leave keeps its message in the open dialog", async ({
  page,
}) => {
  const settings = await settingsFixture(page, {
    role: "member",
    queued: true,
  });
  const danger = settings.getByRole("region", {
    name: "Danger zone",
    exact: true,
  });
  await danger
    .getByRole("button", { name: "Leave project", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Leave project?",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "Leave project", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Sync queued changes and finish pending ENV publications before leaving this project",
  );
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Stay", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});
