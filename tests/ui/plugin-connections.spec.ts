import { expect, test, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { settingsCalls, settingsFixture } from "./fixtures/settings.js";
import { join } from "node:path";

async function capture(page: Page, state: string) {
  const directory = process.env.ORKA_CAPTURE_DIR;
  const helper = process.env.ORKA_CAPTURE_HELPER;
  if (!directory || !helper) return;
  const revision = process.env.ORKA_CAPTURE_REVISION ?? "";
  const side = process.env.ORKA_CAPTURE_SIDE ?? "";
  const { capturePage } = await import(helper);
  await capturePage(page, {
    path: join(
      directory,
      `desktop-${side}-${revision.slice(0, 12)}-${state}.png`,
    ),
    side,
    revision,
    surface: "desktop",
    state,
    fixture: "synthetic-settings-v1",
    theme: "desktop-dark",
    expectedVisible: [
      state === "consent" ? ".plugin-authorization" : ".settings-panel",
    ],
  });
}

const openConnection = async (page: Page) => {
  await page.evaluate(() => {
    (window as any).settingsControls.pluginCallback =
      `orka://mcp/authorize?handoff=${"h".repeat(43)}&service=https%3A%2F%2Ffixture.example`;
  });
  return page.getByRole("dialog", {
    name: "Connect your assistant",
    exact: true,
  });
};

test("desktop consent shows the native identity and submits only its request ID", async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await settingsFixture(page);
  await capture(page, "settings");
  const dialog = await openConnection(page);
  await expect(
    dialog.getByText("morgan@example.com", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("Fixture Assistant", { exact: false }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("list", { name: "Requested permissions" }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("desktop-consent.png"),
    animations: "disabled",
  });
  await capture(page, "consent");
  await dialog
    .getByRole("button", { name: "Allow connection", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("Connection approved");
  expect(
    (await settingsCalls(page)).find(
      ({ command, args }) =>
        command === "plugin_authorization" && args.operation === "approve",
    )?.args,
  ).toEqual({ operation: "approve", input: { requestId: "fixture-request" } });
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(
    (await settingsCalls(page)).filter(
      ({ command, args }) =>
        command === "plugin_authorization" && args.operation === "cancel",
    ),
  ).toHaveLength(0);
});

test("consent remains fixed while loading and fits a compact window", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 640 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await settingsFixture(page, { pluginDelay: 1200 });
  const dialog = await openConnection(page);
  await expect(dialog.getByRole("status")).toHaveText(
    "Checking connection request…",
  );
  const initial = await dialog.boundingBox();
  await expect(
    dialog.getByRole("button", { name: "Allow connection", exact: true }),
  ).toBeEnabled();
  expect(await dialog.boundingBox()).toEqual(initial);
  await expect(
    dialog.getByRole("button", { name: "Allow connection", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  const accessibility = await new AxeBuilder({ page })
    .include(".plugin-authorization")
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(
    (await settingsCalls(page)).find(
      ({ command, args }) =>
        command === "plugin_authorization" && args.operation === "cancel",
    )?.args.input,
  ).toEqual({ requestId: "fixture-request" });
});

test("native stale-session errors require a new connection", async ({
  page,
}) => {
  await settingsFixture(page);
  const dialog = await openConnection(page);
  await expect(
    dialog.getByRole("button", { name: "Allow connection", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => {
    (window as any).settingsControls.pluginError =
      "Account changed. Reconnect your assistant.";
  });
  await dialog
    .getByRole("button", { name: "Allow connection", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("Account changed");
  await expect(
    dialog.getByRole("button", { name: "Allow connection", exact: true }),
  ).toBeDisabled();
});

test("a transient preview failure can retry a fresh native review", async ({
  page,
}) => {
  await settingsFixture(page, {
    pluginError: "Another Orka operation is in progress. Try again.",
  });
  const dialog = await openConnection(page);
  await expect(dialog.getByRole("alert")).toContainText(
    "Another Orka operation",
  );
  await expect(
    dialog.getByRole("button", { name: "Allow connection", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => {
    (window as any).settingsControls.pluginError = "";
  });
  await dialog
    .getByRole("button", { name: "Retry connection", exact: true })
    .click();
  await expect(
    dialog.getByText("morgan@example.com", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Allow connection", exact: true }),
  ).toBeEnabled();
  expect(
    (await settingsCalls(page)).filter(
      ({ command, args }) =>
        command === "plugin_authorization" && args.operation === "preview",
    ),
  ).toHaveLength(2);
  expect(
    (await settingsCalls(page)).filter(
      ({ command, args }) =>
        command === "plugin_authorization" && args.operation === "approve",
    ),
  ).toHaveLength(0);
});

test("a changed workspace cannot approve the identity shown before the change", async ({
  page,
}) => {
  await settingsFixture(page);
  const dialog = await openConnection(page);
  await expect(
    dialog.getByRole("button", { name: "Allow connection", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => {
    (window as any).settingsState.user = "different-account";
    (window as any).settingsEmit("workspace-changed", null);
  });
  // The normal workspace refresh observes the switched identity.
  await expect(dialog.getByRole("alert")).toContainText(
    "account or service changed",
    { timeout: 15000 },
  );
  await expect(
    dialog.getByRole("button", { name: "Allow connection", exact: true }),
  ).toBeDisabled();
  expect(
    (await settingsCalls(page)).filter(
      ({ command, args }) =>
        command === "plugin_authorization" && args.operation === "approve",
    ),
  ).toHaveLength(0);
});

test("connections show reconnect instructions and refresh recorded approval", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 900, height: 640 });
  const settings = await settingsFixture(page, { noProjects: true });
  await settings
    .getByRole("button", { name: "Assistant connections", exact: true })
    .click();
  const panel = page.locator('.settings-panel[data-section="connections"]');
  await expect(
    panel.getByText("Connect using your desktop account", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as any).settingsControls.pluginState = "reconnect_required";
  });
  await panel
    .getByRole("button", { name: "Check connection", exact: true })
    .click();
  await expect(panel.getByRole("status")).toHaveText(
    "Reconnect your assistant",
  );
  await expect(
    panel.getByText("Use account in Orka", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("desktop-reconnect.png"),
    animations: "disabled",
  });
  await capture(page, "reconnect");
  await page.evaluate(() => {
    (window as any).settingsControls.pluginState = "linked";
  });
  await panel
    .getByRole("button", { name: "Check connection", exact: true })
    .click();
  await expect(panel.getByRole("status")).toHaveText(
    "Desktop approval recorded",
  );
  expect(
    (
      await new AxeBuilder({ page })
        .include('.settings-panel[data-section="connections"]')
        .analyze()
    ).violations,
  ).toEqual([]);
});
