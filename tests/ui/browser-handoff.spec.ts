import { test, expect, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import {
  resourceLibraryFixture,
  type LibraryWindow,
} from "./fixtures/resource-library.js";

interface HandoffControls {
  candidatesError?: string;
  createBehavior?:
    | "ok"
    | "unconfirmed"
    | "unexpected-link"
    | "rate-limit"
    | "invalid-request"
    | "bad-payload-object"
    | "conflict"
    | "secret";
  createAttempts: number;
  createdInputs: Record<string, unknown>[];
  memories: {
    id: string;
    slug: string;
    title: string;
    scope: "local" | "shared";
    preselected: boolean;
    byteSize: number;
    redactionCount: number;
  }[];
}

type HandoffWindow = LibraryWindow & {
  handoffControls: HandoffControls;
  __TAURI_INTERNALS__: {
    invoke: (
      command: string,
      args?: Record<string, unknown>,
    ) => Promise<unknown>;
  };
};

const VALID_TOKEN = "b".repeat(64);
const VALID_URL = `https://dashboard.example/handoff/${VALID_TOKEN}`;

async function handoffFixture(
  page: Page,
  options: {
    browserHandoffs?: boolean;
    extraMemories?: number;
  } = {},
) {
  await resourceLibraryFixture(page, {
    browserHandoffs: options.browserHandoffs ?? true,
    piSession: true,
  });
  await page.evaluate(
    ({ extraMemories, validUrl }) => {
      const host = window as unknown as HandoffWindow;
      const memories = [
        {
          id: "mem-root",
          slug: "claude-md",
          title: "CLAUDE.md",
          scope: "shared" as const,
          preselected: true,
          byteSize: 1840,
          redactionCount: 0,
        },
        {
          id: "mem-notes",
          slug: "auth-migration-notes",
          title:
            "Long project memory title that should stay on a single horizontal row and truncate with an ellipsis cleanly",
          scope: "local" as const,
          preselected: false,
          byteSize: 4210,
          redactionCount: 2,
        },
        ...Array.from({ length: extraMemories }, (_, index) => ({
          id: `mem-extra-${index}`,
          slug: `extra-memory-${index}`,
          title: `Extra project memory ${index + 1}`,
          scope: (index % 2 === 0 ? "shared" : "local") as "shared" | "local",
          preselected: false,
          byteSize: 1024 * (index + 1),
          redactionCount: 0,
        })),
      ];
      const controls: HandoffControls = {
        createBehavior: "ok",
        createAttempts: 0,
        createdInputs: [],
        memories,
      };
      host.handoffControls = controls;

      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            document.documentElement.dataset.copiedHandoff = text;
          },
        },
      });

      const original = host.__TAURI_INTERNALS__.invoke;
      host.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
        if (command === "handoff_candidates") {
          host.library.calls.push({ command, args });
          if (controls.candidatesError) {
            const msg = controls.candidatesError;
            controls.candidatesError = undefined;
            throw new Error(msg);
          }
          return {
            session: {
              id: args.sessionId,
              title:
                args.sessionId === "session-local"
                  ? "Private session notes"
                  : args.sessionId === "session-pi"
                    ? "Private Pi session"
                    : "My shared session",
              source: args.sessionId === "session-pi" ? "pi" : "codex",
              messageCount: 12,
              toolCallCount: 4,
            },
            memories: controls.memories,
          };
        }
        if (command === "create_handoff") {
          host.library.calls.push({ command, args });
          const input = args.input as Record<string, unknown>;
          controls.createdInputs.push(structuredClone(input));
          controls.createAttempts += 1;
          if (controls.createBehavior === "unconfirmed") {
            controls.createBehavior = "ok";
            throw "Your Orka service didn’t confirm this handoff. Try again to get its link.";
          }
          if (controls.createBehavior === "unexpected-link") {
            controls.createBehavior = "ok";
            throw "The Orka service returned an unexpected handoff link. Nothing was opened.";
          }
          if (controls.createBehavior === "rate-limit") {
            controls.createBehavior = "ok";
            throw "You reached the hourly limit for new handoffs. Try again later.";
          }
          if (controls.createBehavior === "invalid-request") {
            controls.createBehavior = "ok";
            throw "Invalid request";
          }
          if (controls.createBehavior === "bad-payload-object") {
            controls.createBehavior = "ok";
            throw { message: "400: Bad payload" };
          }
          if (controls.createBehavior === "conflict") {
            controls.createBehavior = "ok";
            throw "This request ID was already used for a different handoff";
          }
          if (controls.createBehavior === "secret") {
            controls.createBehavior = "ok";
            throw "HANDOFF_SECRET: Orka found a secret it couldn’t remove from this handoff, so nothing was sent.";
          }
          const memoryIds = (input.memoryIds as string[]) ?? [];
          return {
            id: "33333333-3333-4333-8333-333333333333",
            url: validUrl,
            createdAt: "2026-11-28T00:00:00Z",
            expiresAt: "2026-12-05T00:00:00Z",
            requestId: input.requestId,
            redactionCount: memoryIds.includes("mem-notes") ? 2 : 0,
            messageCount: 12,
            toolCallCount: input.includeToolCalls ? 4 : 0,
            memoryCount: memoryIds.length,
          };
        }
        return original(command, args);
      };
    },
    { extraMemories: options.extraMemories ?? 0, validUrl: VALID_URL },
  );
}

async function openSessions(page: Page) {
  await page.getByRole("button", { name: /^Sessions/ }).click();
  await expect(page.getByRole("table")).toBeVisible();
}

function sessionRow(page: Page, name: string) {
  return page
    .getByRole("table")
    .locator("tbody tr")
    .filter({ has: page.getByRole("button", { name, exact: true }) });
}

async function openHandoffFromRow(page: Page, name: string) {
  await sessionRow(page, name).click({
    button: "right",
    position: { x: 8, y: 8 },
  });
  await page
    .getByRole("menuitem", { name: "Share handoff link…", exact: true })
    .click();
}

test("hides Share handoff link when capability is absent and for non-session resources", async ({
  page,
}) => {
  await handoffFixture(page, { browserHandoffs: false });
  await openSessions(page);
  await sessionRow(page, "Private session notes").click({
    button: "right",
    position: { x: 8, y: 8 },
  });
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Share handoff link…", exact: true }),
  ).toHaveCount(0);
  const more = page.getByRole("menuitem", { name: "More actions" });
  if ((await more.count()) > 0) {
    await more.hover();
    await expect(
      page.getByRole("menuitem", { name: "Share handoff link…", exact: true }),
    ).toHaveCount(0);
  }
  await page.keyboard.press("Escape");

  // With capability enabled, Memories still do not show Share handoff link…
  await handoffFixture(page, { browserHandoffs: true });
  await page.getByRole("button", { name: /^Memories/ }).click();
  await expect(page.getByRole("table")).toBeVisible();
  await sessionRow(page, "My shared memory").click({
    button: "right",
    position: { x: 8, y: 8 },
  });
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Share handoff link…", exact: true }),
  ).toHaveCount(0);
});

test("creates and copies a handoff link from Sessions menu and SessionDetail launcher", async ({
  page,
}) => {
  await handoffFixture(page, { browserHandoffs: true });
  await openSessions(page);

  // 1. Open from local session row menu -> More actions -> Share handoff link…
  await openHandoffFromRow(page, "Private session notes");

  const dialog = page.getByRole("dialog", { name: "Share handoff link" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("12 messages · 4 tool calls")).toBeVisible();
  await expect(dialog.getByLabel(/CLAUDE\.md/)).toBeChecked();
  await expect(
    dialog.getByLabel(/Long project memory title/),
  ).not.toBeChecked();
  await expect(
    dialog.getByRole("switch", { name: "Include tool calls" }),
  ).not.toBeChecked();

  await dialog.getByLabel(/Long project memory title/).check();
  await dialog
    .getByLabel("Handoff note (optional)")
    .fill("Focus on the retry handler.");
  await dialog.getByRole("button", { name: "Create handoff link" }).click();

  const readyDialog = page.getByRole("dialog", { name: "Handoff link ready" });
  const linkInput = readyDialog.getByRole("textbox", { name: "Handoff link" });
  const copyButton = readyDialog.getByRole("button", { name: "Copy link" });
  await expect(linkInput).toHaveValue(VALID_URL);
  await expect(copyButton).toBeFocused();
  await expect(readyDialog.getByRole("status")).toHaveText(
    "Copy this link before closing. Orka cannot show it again.",
  );

  await copyButton.click();
  await expect(readyDialog.getByRole("status")).toHaveText("Link copied.");
  await expect(page.locator("html")).toHaveAttribute(
    "data-copied-handoff",
    VALID_URL,
  );

  await readyDialog.getByRole("button", { name: "Done" }).click();
  await expect(readyDialog).toBeHidden();
  await expect(
    sessionRow(page, "Private session notes").getByRole("button", {
      name: "Private session notes",
      exact: true,
    }),
  ).toBeFocused();

  // 2. Open via keyboard from SessionDetail menus & restore focus to the opener trigger on Escape
  await sessionRow(page, "Private Pi session")
    .getByRole("button", { name: "Private Pi session", exact: true })
    .click();

  const detailTrigger = page.getByRole("button", {
    name: "More resource actions",
    exact: true,
  });
  await detailTrigger.focus();
  await page.keyboard.press("Enter");
  const detailMenu = page.getByRole("menu", {
    name: "More resource actions",
    exact: true,
  });
  await expect(detailMenu).toBeVisible();
  expect(
    await detailMenu.locator(':scope > [role="menuitem"]').count(),
  ).toBeLessThanOrEqual(8);
  await detailMenu
    .getByRole("menuitem", { name: "More actions", exact: true })
    .press("ArrowRight");
  const detailShareItem = page
    .getByRole("menu", { name: "More actions", exact: true })
    .getByRole("menuitem", { name: "Share handoff link…", exact: true });
  await expect(detailShareItem).toBeVisible();
  await detailShareItem.press("Enter");
  await expect(
    page.getByRole("dialog", { name: "Share handoff link" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Share handoff link" }),
  ).toBeHidden();
  await expect(detailTrigger).toBeFocused();

  const launcherTrigger = page.getByRole("button", {
    name: "Choose how to open session",
    exact: true,
  });
  await launcherTrigger.focus();
  await page.keyboard.press("Enter");
  const launcherMenu = page.getByRole("menu", {
    name: "Open session",
    exact: true,
  });
  const launcherShareItem = launcherMenu.getByRole("menuitem", {
    name: "Share handoff link…",
    exact: true,
  });
  await expect(launcherShareItem).toBeVisible();
  await launcherShareItem.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("dialog", { name: "Share handoff link" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Share handoff link" }),
  ).toBeHidden();
  await expect(launcherTrigger).toBeFocused();
});

test("preserves requestId on retryable/unconfirmed failures and clears on terminal outcomes", async ({
  page,
}) => {
  await handoffFixture(page, { browserHandoffs: true });
  await openSessions(page);

  await openHandoffFromRow(page, "My shared session");
  const dialog = page.getByRole("dialog", { name: "Share handoff link" });
  await expect(dialog.getByLabel(/CLAUDE\.md/)).toBeChecked();

  for (const [behavior, expectedAlert] of [
    ["unconfirmed", "didn’t confirm"],
    ["unexpected-link", "unexpected handoff link"],
    ["rate-limit", "hourly limit"],
  ] as const) {
    await page.evaluate((nextBehavior) => {
      (window as unknown as HandoffWindow).handoffControls.createBehavior =
        nextBehavior;
    }, behavior);
    const buttonName =
      behavior === "unconfirmed" ? "Create handoff link" : "Try again";
    await dialog.getByRole("button", { name: buttonName }).click();
    await expect(dialog.getByRole("alert")).toContainText(expectedAlert);
  }

  // Final retry succeeds with the exact same requestId
  await dialog.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("dialog", { name: "Handoff link ready" }),
  ).toBeVisible();

  const retryIds = await page.evaluate(() =>
    (window as unknown as HandoffWindow).handoffControls.createdInputs.map(
      (input) => input.requestId,
    ),
  );
  expect(retryIds).toHaveLength(4);
  expect(new Set(retryIds).size).toBe(1);

  await page.getByRole("button", { name: "Done" }).click();

  // Terminal 400 (stripped & object), 409 conflict & secret errors mint fresh requestIds on subsequent tries
  await openHandoffFromRow(page, "My shared session");
  await expect(dialog).toBeVisible();

  await page.evaluate(() => {
    (window as unknown as HandoffWindow).handoffControls.createBehavior =
      "invalid-request";
  });
  await dialog.getByRole("button", { name: "Create handoff link" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Invalid request");

  await page.evaluate(() => {
    (window as unknown as HandoffWindow).handoffControls.createBehavior =
      "bad-payload-object";
  });
  await dialog.getByRole("button", { name: "Try again" }).click();
  const badPayloadAlert = dialog.getByRole("alert");
  await expect(badPayloadAlert).toContainText("400: Bad payload");
  await expect(badPayloadAlert).not.toContainText("[object Object]");

  await page.evaluate(() => {
    (window as unknown as HandoffWindow).handoffControls.createBehavior =
      "conflict";
  });
  await dialog.getByRole("button", { name: "Try again" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "already used for a different handoff",
  );

  await page.evaluate(() => {
    (window as unknown as HandoffWindow).handoffControls.createBehavior =
      "secret";
  });
  await dialog.getByRole("button", { name: "Try again" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Secret blocked this handoff",
  );
  await expect(dialog.getByRole("alert")).toContainText(
    "Uncheck a memory or turn off tool calls",
  );

  // Uncheck memory -> fresh requestId & succeeds
  await dialog.getByLabel(/CLAUDE\.md/).uncheck();
  await dialog.getByRole("button", { name: "Create handoff link" }).click();
  await expect(
    page.getByRole("dialog", { name: "Handoff link ready" }),
  ).toBeVisible();

  const allIds = await page.evaluate(() =>
    (window as unknown as HandoffWindow).handoffControls.createdInputs.map(
      (input) => input.requestId,
    ),
  );
  expect(allIds).toHaveLength(9);
  expect(allIds[5]).not.toBe(allIds[4]);
  expect(allIds[6]).not.toBe(allIds[5]);
  expect(allIds[7]).not.toBe(allIds[6]);
  expect(allIds[8]).not.toBe(allIds[7]);
});

for (const viewport of [
  { width: 1160, height: 800 },
  { width: 900, height: 640 },
]) {
  test(`handoff modal fits cleanly with single-line memory rows, stable geometry, visible alerts, and zero axe violations at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await handoffFixture(page, { browserHandoffs: true, extraMemories: 8 });
    await openSessions(page);
    await openHandoffFromRow(page, "Private session notes");

    const dialog = page.getByRole("dialog", { name: "Share handoff link" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("1 of 10 selected")).toBeVisible();

    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    expect(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);

    // Every memory row stays single-line (<= 40px) and memory list has no horizontal overflow
    const memoryRows = dialog.locator(".browser-handoff-memory-row");
    const rowCount = await memoryRows.count();
    expect(rowCount).toBe(10);
    for (let i = 0; i < Math.min(rowCount, 4); i += 1) {
      const rowBox = (await memoryRows.nth(i).boundingBox())!;
      expect(rowBox.height).toBeLessThanOrEqual(40);
    }
    expect(
      await dialog
        .locator(".browser-handoff-memory-list")
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);

    const configureHeadingY = (await dialog
      .locator(".ui-modal-header h2")
      .boundingBox())!.y;
    const configureFooterBottomY = await dialog
      .locator(".ui-modal-footer")
      .evaluate((el) => el.getBoundingClientRect().bottom);

    // Public-access disclosure is pinned and completely visible within body bounds before Create
    const assertPinnedDisclosureVisible = async () => {
      const disclosure = dialog.locator(".browser-handoff-disclosure");
      await expect(disclosure).toBeInViewport();
      const [bodyRect, discRect] = await Promise.all([
        dialog
          .locator(".ui-modal-body")
          .evaluate((el) => el.getBoundingClientRect().toJSON()),
        disclosure.evaluate((el) => el.getBoundingClientRect().toJSON()),
      ]);
      expect(discRect.top).toBeGreaterThanOrEqual(bodyRect.top - 1);
      expect(discRect.bottom).toBeLessThanOrEqual(bodyRect.bottom + 1);
    };
    await assertPinnedDisclosureVisible();

    const configureAxe = await new AxeBuilder({ page })
      .include('[role="dialog"]')
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(configureAxe.violations).toEqual([]);

    // General error appears pinned in red inside viewport without scrolling
    await page.evaluate(() => {
      (window as unknown as HandoffWindow).handoffControls.createBehavior =
        "unconfirmed";
    });
    await dialog.getByRole("button", { name: "Create handoff link" }).click();
    const generalAlert = dialog.locator(".ui-modal-error[role='alert']");
    await expect(generalAlert).toBeInViewport();
    await assertPinnedDisclosureVisible();
    const alertColor = await generalAlert.evaluate(
      (el) => getComputedStyle(el).color,
    );
    const helperColor = await dialog
      .locator(".browser-handoff-tools-copy p")
      .evaluate((el) => getComputedStyle(el).color);
    expect(alertColor).not.toBe(helperColor);
    const errorHeadingY = (await dialog
      .locator(".ui-modal-header h2")
      .boundingBox())!.y;
    const errorFooterBottomY = await dialog
      .locator(".ui-modal-footer")
      .evaluate((el) => el.getBoundingClientRect().bottom);
    expect(Math.abs(errorHeadingY - configureHeadingY)).toBeLessThanOrEqual(2);
    expect(
      Math.abs(errorFooterBottomY - configureFooterBottomY),
    ).toBeLessThanOrEqual(2);

    // Secret-block alert scrolls into view within scroll container while disclosure stays pinned
    await page.evaluate(() => {
      (window as unknown as HandoffWindow).handoffControls.createBehavior =
        "secret";
    });
    await dialog.getByRole("button", { name: "Try again" }).click();
    const secretAlert = dialog.locator(".browser-handoff-alert--secret");
    await expect(secretAlert).toBeInViewport();
    await assertPinnedDisclosureVisible();
    const [scrollRect, secretRect] = await Promise.all([
      dialog
        .locator(".browser-handoff-form-scroll")
        .evaluate((el) => el.getBoundingClientRect().toJSON()),
      secretAlert.evaluate((el) => el.getBoundingClientRect().toJSON()),
    ]);
    expect(secretRect.top).toBeGreaterThanOrEqual(scrollRect.top - 1);
    expect(secretRect.bottom).toBeLessThanOrEqual(scrollRect.bottom + 1);
    expect(
      await dialog
        .locator(".browser-handoff-form-scroll")
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);

    // Receipt preserves header/footer frame anchors cleanly
    await dialog.getByRole("button", { name: "Try again" }).click();
    const ready = page.getByRole("dialog", { name: "Handoff link ready" });
    await expect(ready).toBeVisible();

    const readyBox = (await ready.boundingBox())!;
    expect(readyBox.y + readyBox.height).toBeLessThanOrEqual(viewport.height);
    expect(
      await ready.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);

    const readyHeadingY = (await ready
      .locator(".ui-modal-header h2")
      .boundingBox())!.y;
    const readyFooterBottomY = await ready
      .locator(".ui-modal-footer")
      .evaluate((el) => el.getBoundingClientRect().bottom);
    expect(Math.abs(readyHeadingY - configureHeadingY)).toBeLessThanOrEqual(2);
    expect(
      Math.abs(readyFooterBottomY - configureFooterBottomY),
    ).toBeLessThanOrEqual(2);

    const receiptAxe = await new AxeBuilder({ page })
      .include('[role="dialog"]')
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(receiptAxe.violations).toEqual([]);
  });
}
