import { test, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { settingsCalls, settingsFixture } from "./fixtures/settings.js";
import {
  resourceLibraryFixture,
  type LibraryWindow,
} from "./fixtures/resource-library.js";

test("Settings -> Handoff links lists active links, confirms revoke, and handles errors", async ({
  page,
}) => {
  const skulletWarnings: string[] = [];
  const collectWarning = (msg: import("@playwright/test").ConsoleMessage) => {
    if (msg.type() === "warning" && msg.text().includes("[skullet]")) {
      skulletWarnings.push(msg.text());
    }
  };
  page.on("console", collectWarning);

  const settings = await settingsFixture(page, {
    handoffsDelay: 250,
    revokeHandoffError: "Temporary network interruption",
  });
  await settings
    .getByRole("button", { name: "Handoff links", exact: true })
    .click();

  await expect(
    settings.getByRole("heading", { name: "Handoff links", exact: true }),
  ).toBeVisible();
  const rows = settings.getByRole("listitem");
  await expect(rows).toHaveCount(2);
  page.off("console", collectWarning);
  expect(skulletWarnings).toEqual([]);
  await expect(rows.nth(0)).toContainText("Investigate webhook retry backoff");
  await expect(rows.nth(0)).toContainText("Claude Code");
  await expect(rows.nth(0)).toContainText(
    "14 messages · 2 memories · 5 tool calls",
  );
  await expect(rows.nth(1)).toContainText("Refactor session pagination");
  await expect(rows.nth(1)).toContainText("Codex");
  // No fake copy button on listed handoffs
  await expect(settings.getByRole("button", { name: /copy/i })).toHaveCount(0);

  // Cancel revoke keeps row
  await rows
    .nth(0)
    .getByRole("button", { name: "Revoke", exact: true })
    .click();
  const modal = page.getByRole("dialog", { name: "Revoke handoff link?" });
  await expect(modal).toBeVisible();
  await modal.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(modal).toBeHidden();
  await expect(rows).toHaveCount(2);

  // Confirm revoke: first attempt fails, retry succeeds
  await rows
    .nth(0)
    .getByRole("button", { name: "Revoke", exact: true })
    .click();
  await expect(modal).toBeVisible();
  await modal.getByRole("button", { name: "Revoke link", exact: true }).click();
  await expect(modal.getByRole("alert")).toContainText(
    "Temporary network interruption",
  );
  await modal.getByRole("button", { name: "Revoke link", exact: true }).click();
  await expect(modal).toBeHidden();
  await expect(rows).toHaveCount(1);
  await expect(settings.getByRole("status")).toHaveText(
    "Handoff link revoked.",
  );

  const revokeCalls = (await settingsCalls(page)).filter(
    (call) => call.command === "revoke_handoff",
  );
  expect(revokeCalls).toHaveLength(2);
  expect(revokeCalls[0].args).toEqual({
    id: "11111111-1111-4111-8111-111111111111",
    accountId: "owner",
    serviceOrigin: "https://test.orka",
  });

  // Must never emit settings_section_viewed:handoffs
  const usageEvents = (await settingsCalls(page))
    .filter((call) => call.command === "record_desktop_usage")
    .flatMap((call) => call.args.events as string[]);
  expect(usageEvents).not.toContain("settings_section_viewed:handoffs");
});

test("Settings -> Handoff links shows empty, unsupported, and error-retry states", async ({
  page,
}) => {
  // Empty state
  const emptySettings = await settingsFixture(page, { handoffs: "empty" });
  await emptySettings
    .getByRole("button", { name: "Handoff links", exact: true })
    .click();
  await expect(
    emptySettings.getByText(/No active handoff links\./),
  ).toBeVisible();

  // Unsupported service (must not emit Skullet height-jump warnings)
  const skulletWarnings: string[] = [];
  const collectWarning = (msg: import("@playwright/test").ConsoleMessage) => {
    if (msg.type() === "warning" && msg.text().includes("[skullet]")) {
      skulletWarnings.push(msg.text());
    }
  };
  page.on("console", collectWarning);
  const unsupportedSettings = await settingsFixture(page, {
    handoffs: "unsupported",
    handoffsDelay: 250,
  });
  await unsupportedSettings
    .getByRole("button", { name: "Handoff links", exact: true })
    .click();
  await expect(
    unsupportedSettings.getByText(/doesn’t support browser handoffs yet/i),
  ).toBeVisible();
  page.off("console", collectWarning);
  expect(skulletWarnings).toEqual([]);

  // Error + Retry recovers populated list and shows backend error detail
  const errorSettings = await settingsFixture(page, {
    handoffs: "unavailable",
  });
  await errorSettings
    .getByRole("button", { name: "Handoff links", exact: true })
    .click();
  await expect(errorSettings.getByRole("alert")).toContainText(
    "Couldn’t load handoff links: Couldn’t reach your Orka service.",
  );
  await errorSettings
    .getByRole("button", { name: "Retry", exact: true })
    .click();
  await expect(errorSettings.getByRole("listitem")).toHaveCount(2);
});

test("Manage links from receipt opens Settings -> Handoff links", async ({
  page,
}) => {
  await resourceLibraryFixture(page, { browserHandoffs: true });
  await page.evaluate(() => {
    const host = window as unknown as LibraryWindow & {
      __TAURI_INTERNALS__: {
        invoke: (
          command: string,
          args?: Record<string, unknown>,
        ) => Promise<unknown>;
      };
    };
    const original = host.__TAURI_INTERNALS__.invoke;
    host.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      if (command === "handoff_candidates") {
        return {
          session: {
            id: args.sessionId,
            title: "My shared session",
            source: "codex",
            messageCount: 6,
            toolCallCount: 2,
          },
          memories: [],
        };
      }
      if (command === "create_handoff") {
        const input = args.input as { requestId: string };
        return {
          id: "44444444-4444-4444-8444-444444444444",
          url: "https://dashboard.example/handoff/" + "c".repeat(64),
          createdAt: "2026-11-28T00:00:00Z",
          expiresAt: "2026-12-05T00:00:00Z",
          requestId: input.requestId,
          redactionCount: 0,
          messageCount: 6,
          toolCallCount: 0,
          memoryCount: 0,
        };
      }
      if (command === "list_handoffs") {
        return {
          supported: true,
          handoffs: [
            {
              id: "44444444-4444-4444-8444-444444444444",
              title: "My shared session",
              source: "codex",
              createdAt: "2026-11-28T00:00:00Z",
              expiresAt: "2026-12-05T00:00:00Z",
              includeToolCalls: false,
              messageCount: 6,
              memoryCount: 0,
              url: null,
            },
          ],
        };
      }
      return original(command, args);
    };
  });

  await page.getByRole("button", { name: /^Sessions/ }).click();
  await expect(page.getByRole("table")).toBeVisible();
  await page
    .getByRole("table")
    .locator("tbody tr")
    .filter({
      has: page.getByRole("button", { name: "My shared session", exact: true }),
    })
    .click({ button: "right", position: { x: 8, y: 8 } });
  await page
    .getByRole("menuitem", { name: "Share handoff link…", exact: true })
    .click();

  const dialog = page.getByRole("dialog", { name: "Share handoff link" });
  await dialog.getByRole("button", { name: "Create handoff link" }).click();

  const ready = page.getByRole("dialog", { name: "Handoff link ready" });
  await expect(ready).toBeVisible();
  await ready
    .getByRole("button", { name: "Manage links", exact: true })
    .click();
  await expect(ready).toBeHidden();

  const settings = page.getByRole("region", { name: "Settings", exact: true });
  await expect(
    settings.getByRole("heading", { name: "Handoff links", exact: true }),
  ).toBeVisible();
  await expect(settings.getByRole("listitem")).toHaveCount(1);
  await expect(settings.getByRole("listitem").first()).toContainText(
    "My shared session",
  );
});

for (const viewport of [
  { width: 1160, height: 800 },
  { width: 900, height: 640 },
]) {
  test(`Handoff links manager fits cleanly with compact loading skeleton, zero skullet warnings on one-link reveal, and zero axe violations at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    const skulletWarnings: string[] = [];
    const collectWarning = (msg: import("@playwright/test").ConsoleMessage) => {
      if (msg.type() === "warning" && msg.text().includes("[skullet]")) {
        skulletWarnings.push(msg.text());
      }
    };
    page.on("console", collectWarning);

    await page.setViewportSize(viewport);
    const settings = await settingsFixture(page, {
      handoffsDelay: 250,
      handoffs: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          title:
            "Long session title investigating webhook retries across multiple workers without horizontal overflow",
          source: "claude",
          createdAt: "2026-11-24T09:30:00Z",
          expiresAt: "2026-12-01T09:30:00Z",
          includeToolCalls: true,
          messageCount: 24,
          toolCallCount: 11,
          memoryCount: 4,
          url: null,
        },
      ],
    });
    await settings
      .getByRole("button", { name: "Handoff links", exact: true })
      .click();
    await expect(settings.locator("[skullet-own]")).toBeVisible();
    await expect(settings.getByRole("listitem")).toHaveCount(1);
    await expect(settings.locator("[skullet-own]")).toHaveCount(0);
    await settings
      .locator("[skullet-reveal]")
      .evaluate((el) =>
        Promise.all(
          el.getAnimations({ subtree: true }).map((anim) => anim.finished),
        ),
      );
    await expect(settings.locator(".settings-handoff-row strong")).toHaveCSS(
      "opacity",
      "1",
    );
    await expect(settings.locator(".settings-handoff-badge")).toHaveCSS(
      "opacity",
      "1",
    );
    page.off("console", collectWarning);
    expect(skulletWarnings).toEqual([]);

    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);

    const axe = await new AxeBuilder({ page })
      .include('section[aria-label="Settings"]')
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(axe.violations).toEqual([]);

    // Also audit the Revoke confirmation modal
    await settings.getByRole("button", { name: "Revoke", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "Revoke handoff link?" });
    await expect(modal).toBeVisible();
    await expect(modal).toHaveCSS("opacity", "1");
    const modalAxe = await new AxeBuilder({ page })
      .include('[role="dialog"]')
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(modalAxe.violations).toEqual([]);
  });
}
