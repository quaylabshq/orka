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
    (window as any).settingsControls.pluginRequestId = "fixture-request";
  });
  return page.getByRole("dialog", {
    name: "Connect to Orka",
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
  ).toEqual({
    operation: "approve",
    input: {
      requestId: "fixture-request",
      scopes: ["orka.read", "orka.write", "orka.manage"],
    },
  });
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
  const initialActions = await dialog.locator("footer").boundingBox();
  await expect(
    dialog.getByRole("button", { name: "Allow connection", exact: true }),
  ).toBeEnabled();
  expect(await dialog.boundingBox()).toEqual(initial);
  expect(await dialog.locator("footer").boundingBox()).toEqual(initialActions);
  const heading = await dialog.locator("header").boundingBox();
  const close = await dialog
    .getByRole("button", { name: "Close connection" })
    .boundingBox();
  expect(close!.y - heading!.y).toBe(12);
  expect(
    await dialog
      .locator("header")
      .evaluate((element) => getComputedStyle(element).borderBottomWidth),
  ).toBe("1px");
  expect(
    await dialog
      .locator("footer")
      .evaluate((element) => getComputedStyle(element).borderTopWidth),
  ).toBe("1px");
  expect(
    await dialog
      .locator("h2:not(.sr-only)")
      .evaluate((element) => getComputedStyle(element).fontSize),
  ).toBe("20px");
  await expect(
    dialog.getByRole("button", { name: "Allow connection", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await dialog.getByRole("region", { name: "Connection details" }).focus();
  await page.keyboard.press("End");
  await expect(dialog.locator(".connector-consent-note")).toBeInViewport({
    ratio: 1,
  });
  expect(await dialog.locator("footer").boundingBox()).toEqual(initialActions);
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
  await expect(dialog.getByRole("alert")).toBeInViewport({ ratio: 1 });
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
    .getByRole("button", { name: "Connectors", exact: true })
    .click();
  const panel = page.locator('.settings-panel[data-section="connections"]');
  await expect(panel.getByText("Not connected", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    (window as any).settingsControls.pluginState = "reconnect_required";
  });
  await panel
    .getByRole("button", { name: "Check connection", exact: true })
    .click();
  await expect(panel.getByRole("status")).toHaveText(
    "Connection checked. Reconnect required",
  );
  await expect(
    panel.getByText(
      "Approve the account and access shown in Orka once for each running assistant.",
      { exact: true },
    ),
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
    "Connection checked. Approved on this Mac",
  );
  expect(
    (
      await new AxeBuilder({ page })
        .include('.settings-panel[data-section="connections"]')
        .analyze()
    ).violations,
  ).toEqual([]);
});

test("Connectors keeps account details visible during recheck and reports retryable errors", async ({
  page,
}) => {
  const settings = await settingsFixture(page);
  await settings
    .getByRole("button", { name: "Connectors", exact: true })
    .click();
  const panel = page.locator('.settings-panel[data-section="connections"]');
  await expect(
    panel.getByText("morgan@example.com", { exact: true }),
  ).toBeVisible();
  const check = panel.getByRole("button", {
    name: "Check connection",
    exact: true,
  });
  const resting = await check.boundingBox();
  // Hover lays the shared state overlay over the resting fill.
  const overlay = await check.evaluate(
    (element) => getComputedStyle(element).boxShadow,
  );
  await check.hover();
  expect(await check.boundingBox()).toEqual(resting);
  await expect
    .poll(() =>
      check.evaluate((element) => getComputedStyle(element).boxShadow),
    )
    .not.toBe(overlay);
  await page.evaluate(() => {
    (window as any).settingsControls.pluginStatusDelay = 1200;
  });
  await panel
    .getByRole("button", { name: "Check connection", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "Checking…", exact: true }),
  ).toBeDisabled();
  await expect(
    panel.getByText("morgan@example.com", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Check connection", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => {
    (window as any).settingsControls.pluginStatusError =
      "Service unavailable. Try again.";
  });
  await panel
    .getByRole("button", { name: "Check connection", exact: true })
    .click();
  await expect(panel.getByRole("alert")).toContainText("Service unavailable");
  await expect(
    panel.getByText("morgan@example.com", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Check connection", exact: true }),
  ).toBeEnabled();
});

test("manual checks acknowledge an unchanged connection and can repeat", async ({
  page,
}) => {
  const settings = await settingsFixture(page, { pluginStatusDelay: 250 });
  await settings
    .getByRole("button", { name: "Connectors", exact: true })
    .click();
  const panel = page.locator('.settings-panel[data-section="connections"]');
  await expect(panel.getByRole("status")).toHaveText("Not connected");
  const calls = () =>
    settingsCalls(page).then(
      (values) =>
        values.filter(({ command }) => command === "plugin_connection_status")
          .length,
    );
  const before = await calls();
  for (let check = 1; check <= 2; check++) {
    await panel
      .getByRole("button", { name: "Check connection", exact: true })
      .click();
    await expect(
      panel.getByRole("button", { name: "Checking…", exact: true }),
    ).toBeDisabled();
    await expect(panel.getByRole("status")).toHaveText(
      "Connection checked. Not connected",
    );
    expect(await calls()).toBe(before + check);
  }
});

test("hidden connectors still allow manual checks and refresh when visible again", async ({
  page,
}) => {
  const settings = await settingsFixture(page);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
  });
  await settings
    .getByRole("button", { name: "Connectors", exact: true })
    .click();
  const panel = page.locator('.settings-panel[data-section="connections"]');
  await expect(panel.getByRole("status")).toHaveText("Not connected");
  const before = (await settingsCalls(page)).filter(
    ({ command }) => command === "plugin_connection_status",
  ).length;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  expect(
    (await settingsCalls(page)).filter(
      ({ command }) => command === "plugin_connection_status",
    ),
  ).toHaveLength(before);
  await panel
    .getByRole("button", { name: "Check connection", exact: true })
    .click();
  await expect(panel.getByRole("status")).toHaveText(
    "Connection checked. Not connected",
  );
  await page.evaluate(() => {
    (window as any).settingsControls.pluginState = "linked";
    Object.defineProperty(document, "hidden", { value: false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(panel.getByRole("status")).toContainText("Approved on this Mac");
});

test("a manual check joins a pending background check instead of overlapping it", async ({
  page,
}) => {
  const settings = await settingsFixture(page);
  await settings
    .getByRole("button", { name: "Connectors", exact: true })
    .click();
  const panel = page.locator('.settings-panel[data-section="connections"]');
  await expect(panel.getByRole("status")).toHaveText("Not connected");
  const calls = () =>
    settingsCalls(page).then(
      (values) =>
        values.filter(({ command }) => command === "plugin_connection_status")
          .length,
    );
  const before = await calls();
  await page.evaluate(() => {
    (window as any).settingsControls.pluginStatusDelay = 1000;
    window.dispatchEvent(new Event("focus"));
  });
  await expect.poll(calls).toBe(before + 1);
  await panel
    .getByRole("button", { name: "Check connection", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "Checking…", exact: true }),
  ).toBeDisabled();
  await expect(panel.getByRole("status")).toHaveText(
    "Connection checked. Not connected",
  );
  expect(await calls()).toBe(before + 1);
});

test("checks discard an old service response before loading the new service", async ({
  page,
}) => {
  const settings = await settingsFixture(page);
  await settings
    .getByRole("button", { name: "Connectors", exact: true })
    .click();
  const panel = page.locator('.settings-panel[data-section="connections"]');
  await expect(panel.getByRole("status")).toHaveText("Not connected");
  await page.evaluate(() => {
    (window as any).settingsControls.pluginStatusDelay = 2000;
    window.dispatchEvent(new Event("focus"));
    (window as any).settingsState.config.apiUrl = "https://other.example";
    (window as any).settingsEmit("workspace-changed", null);
  });
  await expect(
    panel.getByText("https://other.example", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("https://test.orka", { exact: true }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "Check connection", exact: true }),
  ).toBeEnabled();
});

test("one assistant connection shows its active sessions and revokes them together", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 640 });
  const settings = await settingsFixture(page, {
    pluginClientName: "Codex",
    pluginSessionCount: 5,
  });
  await page.evaluate(() => {
    (window as any).settingsControls.pluginState = "linked";
  });
  await settings
    .getByRole("button", { name: "Connectors", exact: true })
    .click();
  const panel = page.locator('.settings-panel[data-section="connections"]');
  const connections = panel.getByRole("region", { name: "Connector sessions" });
  await expect(
    connections.getByRole("heading", { name: "Codex", exact: true }),
  ).toHaveCount(1);
  await expect(
    connections.getByText("5 active sessions", { exact: true }),
  ).toBeVisible();
  await expect(
    connections.getByRole("button", { name: "Revoke access" }),
  ).toHaveCount(1);
  await connections.getByRole("button", { name: "Revoke access" }).click();
  await expect(
    connections.getByText("Reconnect required", { exact: true }),
  ).toBeVisible();
  await expect(
    connections.getByText("5 active sessions", { exact: true }),
  ).toHaveCount(0);
  await expect(
    connections.getByRole("button", { name: "Revoke access" }),
  ).toHaveCount(0);
  await expect(panel.getByRole("status")).toHaveText("Reconnect required");
  expect(
    (await settingsCalls(page)).filter(
      ({ command, args }) =>
        command === "plugin_authorization" && args.operation === "revoke",
    ),
  ).toHaveLength(1);
});

test("an idle assistant approval stays revocable without claiming an active connection", async ({
  page,
}) => {
  const settings = await settingsFixture(page, { pluginClientName: "Codex" });
  await page.evaluate(() => {
    (window as any).settingsControls.pluginState = "idle";
  });
  await settings
    .getByRole("button", { name: "Connectors", exact: true })
    .click();
  const panel = page.locator('.settings-panel[data-section="connections"]');
  const connections = panel.getByRole("region", { name: "Connector sessions" });
  await expect(panel.getByRole("status")).toHaveText("Not connected");
  await expect(
    connections.getByText("No active sessions", { exact: true }),
  ).toBeVisible();
  await expect(
    connections.getByText("0 active sessions", { exact: true }),
  ).toHaveCount(0);
  await connections.getByRole("button", { name: "Revoke access" }).click();
  await expect(connections).toHaveCount(0);
  await expect(panel.getByRole("status")).toHaveText("Not connected");
});

test("long connector identities scroll inside consent without moving its actions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 640 });
  await settingsFixture(page, {
    pluginClientName:
      "Fixture Assistant with a long organization and workspace name for account approval",
  });
  await page.evaluate(() => {
    (window as any).settingsProfile.displayName =
      "Morgan Taylor with a long readable account name";
    (window as any).settingsProfile.email =
      "morgan.taylor.with.a.long.account.name@example.com";
  });
  const dialog = await openConnection(page);
  await expect(
    dialog.getByRole("heading", { name: /^Fixture Assistant/ }),
  ).toBeVisible();
  const footer = await dialog.locator("footer").boundingBox();
  await dialog.locator(".connector-consent-note").scrollIntoViewIfNeeded();
  expect(await dialog.locator("footer").boundingBox()).toEqual(footer);
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await expect(
    dialog.getByRole("button", { name: "Allow connection", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  expect(
    (await new AxeBuilder({ page }).include(".plugin-authorization").analyze())
      .violations,
  ).toEqual([]);
});

test("connector scopes can narrow consent and approved sessions can be revoked", async ({
  page,
}) => {
  const settings = await settingsFixture(page);
  const dialog = await openConnection(page);
  const checks = dialog.getByRole("checkbox");
  await expect(checks).toHaveCount(3);
  await expect(checks.nth(0)).toBeDisabled();
  const permission = dialog.locator(".connector-permission").first();
  const box = await permission.locator("input").boundingBox();
  const label = await permission.locator("span").boundingBox();
  expect(label!.x).toBeGreaterThan(box!.x + box!.width);
  expect(Math.abs(label!.y - box!.y)).toBeLessThan(4);
  await checks.nth(1).uncheck();
  await checks.nth(2).uncheck();
  await dialog
    .getByRole("button", { name: "Allow connection", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("Connection approved");
  expect(
    (await settingsCalls(page)).find(
      ({ command, args }) =>
        command === "plugin_authorization" && args.operation === "approve",
    )?.args.input,
  ).toEqual({ requestId: "fixture-request", scopes: ["orka.read"] });
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await settings
    .getByRole("button", { name: "Connectors", exact: true })
    .click();
  const panel = page.locator('.settings-panel[data-section="connections"]');
  await expect(
    panel.getByRole("button", { name: "Revoke access" }),
  ).toBeVisible();
  await capture(page, "sessions");
  await panel.getByRole("button", { name: "Revoke access" }).click();
  await expect(panel.getByRole("status")).toHaveText("Reconnect required");
  expect(
    (await settingsCalls(page)).find(
      ({ command, args }) =>
        command === "plugin_authorization" && args.operation === "revoke",
    )?.args.input,
  ).toEqual({ connectionId: "fixture-connection" });
});

test("legacy plugin links cannot create approval and Connectors opens without account parameters", async ({
  page,
}) => {
  await settingsFixture(page);
  await page.evaluate(() => {
    (window as any).settingsControls.pluginCallback =
      "orka://mcp/authorize?handoff=old&service=https://other.example";
  });
  await page.waitForTimeout(1300);
  await expect(
    page.getByRole("dialog", { name: "Connect to Orka", exact: true }),
  ).toHaveCount(0);
  expect(
    (await settingsCalls(page)).filter(
      ({ command }) => command === "plugin_authorization",
    ),
  ).toHaveLength(0);
  await page.evaluate(() => {
    (window as any).settingsControls.pluginCallback = "orka://connectors";
  });
  await expect(
    page.locator('.settings-panel[data-section="connections"]'),
  ).toBeVisible();
});
