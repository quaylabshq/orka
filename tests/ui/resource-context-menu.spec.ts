import { test, expect, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import {
  resourceLibraryFixture,
  type LibraryWindow,
} from "./fixtures/resource-library.js";
import { skillFixture } from "./fixtures/skill-detail.js";
import type { SessionLaunchOption } from "../../apps/mac/src/components/use-resource-actions.js";
import type { Snapshot, SyncProgress } from "../../apps/mac/src/types.js";

interface MenuControls {
  shareStatus: string;
  deleteStatus: string;
  deleteFailures: number;
  deferPreview: boolean;
  previewFailures: number;
  previewTitle?: string;
  previewNote?: string;
  previewExpiresIn?: number;
  projectName?: string;
  previewFiles?: { path: string; size: number }[];
  previewProgress?: (progress: SyncProgress) => void;
  previewProgresses: ((progress: SyncProgress) => void)[];
  finishPreview?: () => void;
  failPreview?: () => void;
  finishPreviews: (() => void)[];
  deferShare: boolean;
  shareProgress?: (progress: SyncProgress) => void;
  finishShare?: () => void;
  failShare?: () => void;
  resourceVersion: number;
  deleted: string[];
  finishLaunchOptions?: () => void;
  publicLinkVersion?: string;
  publicLinkFailure?: boolean;
}
type MenuWindow = LibraryWindow & {
  resourceMenu: MenuControls;
  __TAURI_INTERNALS__: {
    invoke: (
      command: string,
      args?: Record<string, unknown>,
    ) => Promise<unknown>;
  };
};

async function menuFixture(
  page: Page,
  options: Parameters<typeof resourceLibraryFixture>[1] = {},
) {
  await resourceLibraryFixture(page, options);
  await page.evaluate(() => {
    const host = window as unknown as MenuWindow;
    const controls: MenuControls = {
      shareStatus: "queued",
      deleteStatus: "deleted",
      deleteFailures: 0,
      deferPreview: false,
      previewFailures: 0,
      previewProgresses: [],
      finishPreviews: [],
      deferShare: false,
      resourceVersion: 0,
      deleted: [],
    };
    host.resourceMenu = controls;
    const original = host.__TAURI_INTERNALS__.invoke;
    host.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      if (command === "resource_command") {
        host.library.calls.push({ command, args });
        const input = args.input as {
          resourceId: string;
          previewToken?: string;
        };
        const action = String(args.action);
        if (action === "public-link-status")
          return {
            active: Boolean(controls.publicLinkVersion),
            linkVersion: controls.publicLinkVersion ?? null,
          };
        if (action === "create-public-link") {
          controls.publicLinkVersion = crypto.randomUUID();
          if (controls.publicLinkFailure) {
            controls.publicLinkFailure = false;
            throw new Error("Couldn’t confirm the public link status.");
          }
          return {
            active: true,
            linkVersion: controls.publicLinkVersion,
            url: "https://dashboard.example/share/" + "a".repeat(64),
          };
        }
        if (action === "revoke-public-link") {
          controls.publicLinkVersion = undefined;
          return { active: false, linkVersion: null };
        }
        const onProgress = args.onProgress as
          { onmessage: (value: SyncProgress) => void } | undefined;
        if (action.startsWith("preview-")) {
          controls.previewProgress = onProgress?.onmessage;
          if (onProgress) controls.previewProgresses.push(onProgress.onmessage);
          if (controls.previewFailures > 0) {
            controls.previewFailures -= 1;
            throw new Error("Local folder temporarily unavailable");
          }
          const files = controls.previewFiles ?? [
            { path: "content.md", size: 20 },
          ];
          const preview = {
            previewToken: `frozen-${action}-${input.resourceId}`,
            title: controls.previewTitle ?? `Reviewed ${input.resourceId}`,
            kind: input.resourceId.split("-")[0],
            files,
            totalBytes: files.reduce((total, file) => total + file.size, 0),
            ...(controls.previewExpiresIn
              ? {
                  expiresAt:
                    Math.floor(Date.now() / 1000) + controls.previewExpiresIn,
                }
              : {}),
            paths: ["/synthetic/library/content.md"],
            note:
              controls.previewNote ??
              (action === "preview-delete"
                ? "This removes the shared snapshot and its installed copies through sync."
                : "Only this exact snapshot will be shared. Later changes stay private."),
          };
          if (controls.deferPreview)
            return new Promise((resolve, reject) => {
              controls.finishPreview = () => resolve(preview);
              controls.failPreview = () =>
                reject(
                  new Error(
                    "Local folder temporarily unavailable. Reconnect the source folder and try preparing this snapshot again.",
                  ),
                );
              controls.finishPreviews.push(controls.finishPreview);
            });
          return preview;
        }
        if (action === "share") {
          controls.shareProgress = onProgress?.onmessage;
          if (controls.deferShare)
            return new Promise((resolve, reject) => {
              controls.finishShare = () =>
                resolve({ status: controls.shareStatus });
              controls.failShare = () =>
                reject(
                  new Error(
                    "Connection interrupted while sharing. The reviewed snapshot is still available; retry when you are connected.",
                  ),
                );
            });
          return { status: controls.shareStatus };
        }
        if (action === "delete") {
          if (controls.deleteFailures > 0) {
            controls.deleteFailures -= 1;
            throw new Error("Offline: deletion was not completed.");
          }
          if (controls.deleteStatus === "deleted")
            controls.deleted.push(input.resourceId);
          return { status: controls.deleteStatus };
        }
        return { paths: ["/synthetic/library/content.md"] };
      }
      const result = await original(command, args);
      if (command === "snapshot") {
        const snapshot = result as Snapshot;
        snapshot.projects = snapshot.projects.map((project) => ({
          ...project,
          name: controls.projectName ?? project.name,
        }));
        snapshot.resources = snapshot.resources.map((resource) => ({
          ...resource,
          deleted: controls.deleted.includes(resource.resourceId),
          hash: controls.resourceVersion
            ? resource.hash + ":" + controls.resourceVersion
            : resource.hash,
        }));
      }
      return result;
    };
  });
}

async function collection(
  page: Page,
  label: "Memories" | "Sessions" | "Plans" | "Skills",
) {
  await page.getByRole("button", { name: new RegExp("^" + label) }).click();
  await expect(page.getByRole("table")).toBeVisible();
}

function resourceRow(page: Page, name: string) {
  return page
    .getByRole("table")
    .locator("tbody tr")
    .filter({
      has: page.getByRole("button", { name, exact: true }),
    });
}

async function resourceMenu(page: Page, name: string, action?: string) {
  await resourceRow(page, name).click({
    button: "right",
    position: { x: 8, y: 8 },
  });
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  if (action)
    await menu.getByRole("menuitem", { name: action, exact: true }).click();
  return menu;
}

const resourceCalls = (page: Page, action: string) =>
  page.evaluate(
    (action) =>
      (window as unknown as MenuWindow).library.calls.filter(
        (call) =>
          call.command === "resource_command" && call.args.action === action,
      ),
    action,
  );

test("resource row right-click and ellipsis share actions without opening, with keyboard dismissal", async ({
  page,
}) => {
  await menuFixture(page, { emptyLocal: true });
  await collection(page, "Plans");
  const row = resourceRow(page, "My shared plan");
  const opener = row.getByRole("button", {
    name: "My shared plan",
    exact: true,
  });
  const menu = await resourceMenu(page, "My shared plan");
  const actions = await menu.getByRole("menuitem").allTextContents();
  await expect(
    page.getByRole("region", { name: "Plan details", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(opener).toBeFocused();
  const more = row.getByRole("button", {
    name: "Actions for My shared plan",
    exact: true,
  });
  await more.click();
  expect(
    await page.getByRole("menu").getByRole("menuitem").allTextContents(),
  ).toEqual(actions);
  await page.keyboard.press("Escape");
  await expect(more).toBeFocused();
  await opener.focus();
  await opener.press("Shift+F10");
  await expect(
    page.getByRole("menuitem", { name: "Open", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("menuitem", { name: "Open in editor", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(opener).toBeFocused();
});

for (const width of [1160, 900]) {
  for (const withoutRepositories of [false, true]) {
    test(`collection action buttons fit padded rows at ${width}px ${withoutRepositories ? "without" : "with"} repositories`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 800 });
      await menuFixture(page, { emptyLocal: true, withoutRepositories });
      for (const label of ["Sessions", "Memories", "Plans"] as const) {
        await collection(page, label);
        const table = page.getByRole("table");
        await expect(
          table.getByRole("columnheader", { name: "Repository", exact: true }),
        ).toHaveCount(withoutRepositories ? 0 : 1);
        const buttons = table.getByRole("button", { name: /^Actions for / });
        await expect(buttons).toHaveCount(2);
        if (label === "Sessions")
          await page.screenshot({ path: testInfo.outputPath("sessions.png") });
        const bounds = await buttons.evaluateAll((buttons) =>
          buttons.map((button) => {
            const cell = button.closest("td")!;
            const box = button.getBoundingClientRect();
            const cellBox = cell.getBoundingClientRect();
            const style = getComputedStyle(cell);
            return {
              leftGap: box.left - cellBox.left,
              rightGap: cellBox.right - box.right,
              paddingLeft: parseFloat(style.paddingLeft),
              paddingRight: parseFloat(style.paddingRight),
              centerOffset: Math.abs(
                box.top + box.height / 2 - cellBox.top - cellBox.height / 2,
              ),
            };
          }),
        );
        for (const box of bounds) {
          expect(box.leftGap).toBeGreaterThanOrEqual(box.paddingLeft - 1);
          expect(box.rightGap).toBeGreaterThanOrEqual(box.paddingRight - 1);
          expect(box.centerOffset).toBeLessThanOrEqual(1);
        }
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await buttons.first().click();
        await expect(page.getByRole("menu")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(buttons.first()).toBeFocused();
      }
    });
  }
}

test("Home keeps resource context menus without separate action buttons in a compact accessible window", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 900, height: 640 });
  await menuFixture(page, { emptyLocal: true });
  const home = page.getByRole("list", { name: "Recently updated resources" });
  await page.screenshot({ path: testInfo.outputPath("home.png") });
  await expect(home.getByRole("button", { name: /^Actions for / })).toHaveCount(
    0,
  );
  await expect(home.getByRole("button")).toHaveCount(6);
  await home
    .locator('[data-resource-id="memory-own"]')
    .click({ button: "right" });
  const memoryActions = await page
    .getByRole("menu")
    .getByRole("menuitem")
    .allTextContents();
  await expect(
    page.getByRole("menuitem", { name: "Copy content", exact: true }),
  ).toBeVisible();
  const menuBounds = await page.getByRole("menu").boundingBox();
  expect(menuBounds).not.toBeNull();
  expect(menuBounds!.x).toBeGreaterThanOrEqual(0);
  expect(menuBounds!.y + menuBounds!.height).toBeLessThanOrEqual(640);
  await page.keyboard.press("Escape");
  const memory = home.locator('[data-resource-id="memory-own"]');
  await memory.focus();
  await memory.press("Shift+F10");
  expect(
    await page.getByRole("menu").getByRole("menuitem").allTextContents(),
  ).toEqual(memoryActions);
  await page.keyboard.press("Escape");
  await expect(memory).toBeFocused();
  await home
    .locator('[data-resource-id="session-own"]')
    .click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Continue or fork in…", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Delete update", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await collection(page, "Memories");
  await resourceMenu(page, "My shared memory");
  // The list's row menu is one flat list, as on Skills.
  expect(
    await page.getByRole("menu").getByRole("menuitem").allTextContents(),
  ).toEqual([
    ...memoryActions.filter((action) => action !== "More actions"),
    "Show in Finder",
    "Copy local path",
  ]);
  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
});

test("every shared session action has an icon in both menu entry points", async ({
  page,
}) => {
  await menuFixture(page, { emptyLocal: true });
  await collection(page, "Sessions");
  const ownedMenu = await resourceMenu(page, "My shared session");
  const actions = await ownedMenu.getByRole("menuitem").allTextContents();
  expect(actions).toEqual([
    "Open",
    "Continue or fork in…",
    "Copy session prompt",
    "Create copy",
    "Copy link",
    "Download session (.zip)…",
    "Show in Finder",
    "Copy local path",
    "Remove from history…",
  ]);
  await expect(ownedMenu.locator("svg.item-menu-icon")).toHaveCount(
    actions.length,
  );
  await page.keyboard.press("Escape");
  await resourceRow(page, "My shared session")
    .getByRole("button", { name: "Actions for My shared session", exact: true })
    .click();
  const overflowMenu = page.getByRole("menu", {
    name: "Actions for My shared session",
    exact: true,
  });
  expect(await overflowMenu.getByRole("menuitem").allTextContents()).toEqual(
    actions,
  );
  await expect(overflowMenu.locator("svg.item-menu-icon")).toHaveCount(
    actions.length,
  );
  await page.keyboard.press("Escape");
});

test("the session launcher stays compact while checking apps and keeps its split actions keyboard accessible", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 640 });
  const title =
    "Review the synthetic session and continue iterating on the workspace "
      .repeat(4)
      .trim();
  await menuFixture(page, { emptyLocal: true, teammateSessionTitle: title });
  await page.evaluate(() => {
    const host = window as unknown as MenuWindow;
    const original = host.__TAURI_INTERNALS__.invoke;
    const options: SessionLaunchOption[] = (
      ["claude", "codex"] as const
    ).flatMap((tool) =>
      (["desktop", "terminal", "warp"] as const).map((destination) => ({
        tool,
        destination,
        label:
          destination === "desktop"
            ? tool === "claude"
              ? "Claude Desktop"
              : "Codex"
            : destination === "terminal"
              ? "Terminal"
              : "Warp",
        isDefault: tool === "claude" && destination === "desktop",
        mode: tool === "claude" ? "resume" : "handoff",
        available: true,
        reason: null,
      })),
    );
    const launchOptions = new Promise((resolve) => {
      host.resourceMenu.finishLaunchOptions = () => resolve(options);
    });
    host.__TAURI_INTERNALS__.invoke = (command, args) =>
      command === "session_launch_options"
        ? launchOptions
        : original(command, args);
  });
  await collection(page, "Sessions");
  await page.getByRole("searchbox", { name: "Search sessions" }).fill(title);
  await page
    .getByRole("button", { name: "Collapse sidebar", exact: true })
    .click();
  await resourceMenu(page, title, "Continue or fork in…");
  const dialog = page.getByRole("dialog", {
    name: "Continue or fork session",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  const initialBounds = (await dialog.boundingBox())!;
  expect(initialBounds.height).toBeLessThan(240);
  const open = dialog.getByRole("button", {
    name: "Open in Claude Desktop",
    exact: true,
  });
  const close = dialog.getByRole("button", {
    name: "Close session launcher",
    exact: true,
  });
  const choose = dialog.getByRole("button", {
    name: "Choose how to open session",
    exact: true,
  });
  await expect(
    dialog.getByRole("button", {
      name: "Fork and open in Claude Desktop",
      exact: true,
    }),
  ).toBeDisabled();
  const closeBounds = await close.boundingBox();
  const chooseBounds = await choose.boundingBox();
  const sessionTitle = dialog.getByText(title, { exact: true });
  expect(
    await sessionTitle.evaluate((element) => ({
      clamped: element.scrollHeight > element.clientHeight,
      horizontalOverflow: element.scrollWidth > element.clientWidth,
    })),
  ).toEqual({ clamped: true, horizontalOverflow: false });
  await page.evaluate(() => {
    (window as unknown as MenuWindow).resourceMenu.finishLaunchOptions?.();
  });
  await expect(open).toBeEnabled();
  expect(await dialog.boundingBox()).toEqual(initialBounds);
  expect(await close.boundingBox()).toEqual(closeBounds);
  expect(await choose.boundingBox()).toEqual(chooseBounds);
  const splitBounds = (await dialog
    .locator(".session-launcher")
    .boundingBox())!;
  expect(splitBounds.width).toBeLessThan(initialBounds.width * 0.75);

  await choose.focus();
  await choose.press("Enter");
  const menu = page.getByRole("menu", { name: "Open session", exact: true });
  const fork = menu.getByRole("menuitem", {
    name: "Fork and open in Claude Desktop",
    exact: true,
  });
  await expect(fork).toBeVisible();
  const firstOption = menu.getByRole("menuitem", {
    name: "Open in Claude Desktop Default",
    exact: true,
  });
  await expect(firstOption).toBeInViewport({ ratio: 1 });
  await firstOption.press("End");
  await page.keyboard.press("Tab");
  const terminal = page.getByRole("combobox", { name: "Terminal application" });
  await expect(terminal).toBeFocused();
  await expect(terminal).toBeInViewport({ ratio: 1 });

  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(choose).toBeFocused();

  await open.focus();
  await open.press("Enter");
  const resumeCalls = () =>
    page.evaluate(() =>
      (window as unknown as MenuWindow).library.calls
        .filter((call) => call.command === "resume_session")
        .map((call) => call.args),
    );
  const target = {
    id: "session-teammate",
    tool: "claude",
    destination: "desktop",
  };
  await expect.poll(resumeCalls).toEqual([target]);
  await expect(choose).toBeEnabled();
  await choose.press("Enter");
  await fork.press("Enter");
  await expect.poll(resumeCalls).toEqual([target, { ...target, fork: true }]);

  await close.click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("button", { name: title, exact: true }),
  ).toBeFocused();
});

test("local and teammate sessions expose useful actions without mutation of another owner's history", async ({
  page,
}) => {
  await menuFixture(page);
  await collection(page, "Sessions");
  await resourceMenu(page, "Private session notes");
  await expect(
    page.getByRole("menuitem", {
      name: "Share with team…",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Copy link", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("menuitem", { name: "Remove from history…", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await resourceMenu(page, "Mira's session");
  await expect(
    page.getByRole("menuitem", { name: "Create copy", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Copy link", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: /Share with team|Remove from history/ }),
  ).toHaveCount(0);
});

for (const [label, kind, rest] of [
  [
    "Sessions",
    "session",
    [
      "Continue or fork in…",
      "Copy session prompt",
      "Download session (.zip)…",
      "Show in Finder",
      "Copy local path",
    ],
  ],
  [
    "Plans",
    "plan",
    [
      "Open in editor",
      "Copy content",
      "Export ZIP…",
      "Show in Finder",
      "Copy local path",
    ],
  ],
  [
    "Memories",
    "memory",
    ["Open in editor", "Copy content", "Show in Finder", "Copy local path"],
  ],
] as const)
  test(`${label} offer Share with team… right after Open, in its own group`, async ({
    page,
  }) => {
    await menuFixture(page);
    await collection(page, label);
    const menu = await resourceMenu(page, `Private ${kind} notes`);
    expect(
      await menu
        .locator('[role="menuitem"], [role="separator"]')
        .evaluateAll((entries) =>
          entries.map((entry) =>
            entry.getAttribute("role") === "separator"
              ? "---"
              : entry.textContent,
          ),
        ),
    ).toEqual(["Open", "---", "Share with team…", "---", ...rest]);
  });

test("public links use the saved shared revision and can be revoked after reopening", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 640 });
  await menuFixture(page, { publicLinks: true });
  await collection(page, "Sessions");
  await resourceMenu(page, "Private session notes");
  await expect(
    page.getByRole("menuitem", { name: "Manage public link…" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await resourceMenu(page, "My shared session", "Manage public link…");
  const dialog = page.getByRole("dialog", { name: "Manage public link" });
  await expect(dialog.getByText(/Anyone with the link/)).toBeVisible();
  await expect(dialog.getByText(/readable conversation/)).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Create public link" }),
  ).toBeVisible();
  const before = (await dialog.boundingBox())!;
  expect(before.height).toBeLessThan(330);
  expect(await resourceCalls(page, "create-public-link")).toHaveLength(0);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          document.documentElement.dataset.copiedLink = text;
        },
      },
    });
  });
  await dialog.getByRole("button", { name: "Create public link" }).click();
  const link = "https://dashboard.example/share/" + "a".repeat(64);
  const address = dialog.getByRole("textbox", { name: "Public link" });
  const copy = dialog.getByRole("button", { name: "Copy link" });
  await expect(address).toHaveValue(link);
  await expect(copy).toBeFocused();
  const after = (await dialog.boundingBox())!;
  expect(Math.abs(before.y - after.y)).toBeLessThan(2);
  const inputBox = (await address.boundingBox())!;
  const copyBox = (await copy.boundingBox())!;
  expect(
    Math.abs(inputBox.y + inputBox.height / 2 - copyBox.y - copyBox.height / 2),
  ).toBeLessThan(2);
  await expect(
    dialog.getByText("Copy this link before closing."),
  ).toBeInViewport();
  await copy.press("Enter");
  await expect(dialog.getByRole("status")).toHaveText("Link copied.");
  await expect(page.locator("html")).toHaveAttribute("data-copied-link", link);
  expect(await resourceCalls(page, "create-public-link")).toMatchObject([
    {
      args: {
        input: {
          accountId: "user",
          projectId: "project",
          resourceId: "session-own",
          revision: 3,
          linkVersion: null,
        },
      },
    },
  ]);
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(
    resourceRow(page, "My shared session").getByRole("button", {
      name: "My shared session",
      exact: true,
    }),
  ).toBeFocused();
  await resourceMenu(page, "My shared session", "Manage public link…");
  await expect(
    dialog.getByRole("button", { name: "Replace link" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Revoke link" }).click();
  await expect(dialog.getByRole("status")).toHaveText("Public link revoked.");
  expect(await resourceCalls(page, "revoke-public-link")).toMatchObject([
    { args: { input: { linkVersion: expect.any(String) } } },
  ]);
  await expect(
    dialog.getByRole("button", { name: "Create public link" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await collection(page, "Memories");
  await resourceMenu(page, "My shared memory");
  await expect(
    page.getByRole("menuitem", { name: "Manage public link…" }),
  ).toHaveCount(0);
});

test("an uncertain public-link change can be checked before another attempt", async ({
  page,
}) => {
  await menuFixture(page, { publicLinks: true });
  await page.evaluate(() => {
    (window as unknown as MenuWindow).resourceMenu.publicLinkFailure = true;
  });
  await collection(page, "Plans");
  await resourceMenu(page, "My shared plan", "Manage public link…");
  const dialog = page.getByRole("dialog", { name: "Manage public link" });
  await dialog.getByRole("button", { name: "Create public link" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Couldn’t confirm the public link status.",
  );
  await dialog.getByRole("button", { name: "Check link status" }).click();
  await expect(
    dialog.getByRole("button", { name: "Replace link" }),
  ).toBeVisible();
  expect(await resourceCalls(page, "create-public-link")).toHaveLength(1);
});

const shareDialog = (page: Page, name = "Share with team") =>
  page.getByRole("dialog", { name, exact: true });
const statusPill = (dialog: ReturnType<typeof shareDialog>) =>
  dialog.locator(".share-dialog-pill");

test("sharing a snapshot shows what goes where and submits the exact frozen token without changing category sharing", async ({
  page,
}) => {
  await menuFixture(page);
  await collection(page, "Memories");
  await resourceMenu(page, "Private memory notes", "Share with team…");
  const dialog = shareDialog(page);
  const preview = dialog.getByRole("region", {
    name: "Selected item",
    exact: true,
  });
  await expect(preview).toContainText("Memory");
  await expect(preview).toContainText("Reviewed memory-local");
  await expect(preview).toContainText("1 file · 20 B");
  await expect(dialog.locator(".share-dialog-facts")).toContainText(
    "ProjectLibrary",
  );
  await expect(statusPill(dialog)).toHaveText("On your Mac");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toHaveCount(0);
  expect(await resourceCalls(page, "share")).toEqual([]);
  await dialog
    .getByRole("button", { name: "Share with team", exact: true })
    .click();
  // The fixture is offline, so its service queues the share.
  const queued = shareDialog(page, "Queued to share");
  await expect(statusPill(queued)).toHaveText("Sends when online");
  expect((await resourceCalls(page, "share"))[0]?.args.input).toEqual({
    accountId: "user",
    serviceOrigin: "https://library.example",
    projectId: "project",
    resourceId: "memory-local",
    previewToken: "frozen-preview-share-memory-local",
  });
  await queued.getByRole("button", { name: "Done", exact: true }).click();
  await expect(queued).toHaveCount(0);
  const calls = await page.evaluate(
    () => (window as unknown as MenuWindow).library.calls,
  );
  expect(
    calls.filter(
      (call) =>
        call.command === "project_command" || call.command === "configure",
    ),
  ).toEqual([]);
});

for (const [kind, label, kindName] of [
  ["memory", "Memories", "Memory"],
  ["session", "Sessions", "Session"],
  ["plan", "Plans", "Plan"],
  ["skill", "Skills", "Skill"],
] as const)
  test(`a published ${kind} closes the dialog and records one successful share`, async ({
    page,
  }) => {
    await menuFixture(page, { localSkill: kind === "skill" });
    await collection(page, label);
    await page.evaluate(() => {
      (window as unknown as MenuWindow).resourceMenu.shareStatus = "published";
    });
    await resourceMenu(page, `Private ${kind} notes`, "Share with team…");
    const dialog = shareDialog(page);
    await expect(
      dialog.getByRole("region", { name: "Selected item", exact: true }),
    ).toContainText(kindName);
    await dialog
      .getByRole("button", { name: "Share with team", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByText("Shared with team", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as unknown as MenuWindow).library.calls
            .filter(({ command }) => command === "record_desktop_usage")
            .flatMap(({ args }) =>
              (args.events as string[]).filter((event) =>
                event.startsWith("feature:"),
              ),
            ),
        ),
      )
      .toEqual([`feature:${kind}_shared`]);
  });

for (const viewport of [
  { width: 1160, height: 800 },
  { width: 900, height: 640 },
]) {
  for (const motion of ["reduce", "no-preference"] as const) {
    test(`the share dialog keeps one frame through every state at ${viewport.width}px with ${motion} motion`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      await menuFixture(page);
      await page.emulateMedia({ reducedMotion: motion });
      await page.evaluate(() => {
        const controls = (window as unknown as MenuWindow).resourceMenu;
        controls.deferPreview = true;
        controls.deferShare = true;
        controls.previewTitle =
          "A much longer reviewed session title that must stay on one line inside the preview card without moving the details table or the footer button.";
      });
      await collection(page, "Sessions");
      await resourceMenu(page, "Private session notes", "Share with team…");
      const dialog = page.getByRole("dialog");
      await page.evaluate(() => document.fonts.ready);
      const geometry = () =>
        dialog.evaluate((el) =>
          [
            el,
            ...[
              ".share-dialog-header",
              ".share-dialog-preview",
              ".share-dialog-facts",
              ".share-dialog-action",
            ].map((selector) => el.querySelector(selector)!),
          ].map((node) => {
            const rect = node.getBoundingClientRect();
            return [rect.right, rect.y, rect.height].map(
              (value) => Math.round(value * 100) / 100,
            );
          }),
        );
      const initial = await geometry();
      const stationary = () => expect.poll(geometry).toEqual(initial);
      const capture = (name: string) =>
        motion === "reduce"
          ? page.screenshot({
              path: testInfo.outputPath(`share-${name}-${viewport.width}.png`),
            })
          : Promise.resolve();
      const action = dialog.locator(".share-dialog-action");
      await expect(statusPill(dialog)).toHaveText("Preparing preview");
      await expect(action).toBeDisabled();
      await page.evaluate(() => {
        (window as unknown as MenuWindow).resourceMenu.projectName =
          "A long project name that must truncate within the details table instead of growing the dialog";
      });
      await expect(
        dialog.locator(".share-dialog-facts dd").first(),
      ).toHaveAttribute("title", /A long project name/);
      await stationary();
      await page.evaluate(() =>
        (window as unknown as MenuWindow).resourceMenu.failPreview?.(),
      );
      await expect(statusPill(dialog)).toContainText("Preview failed");
      await expect(statusPill(dialog)).toHaveAttribute(
        "title",
        /Local folder temporarily unavailable/,
      );
      await stationary();
      await capture("preview-failed");
      await action.click();
      await expect(statusPill(dialog)).toHaveText("Preparing preview");
      await page.evaluate(() =>
        (window as unknown as MenuWindow).resourceMenu.finishPreview?.(),
      );
      await expect(statusPill(dialog)).toHaveText("On your Mac");
      await expect(action).toHaveText("Share with team");
      await expect(action).toBeEnabled();
      const title = dialog.locator(".share-dialog-title");
      expect(
        await title.evaluate((el) => el.scrollWidth > el.clientWidth),
      ).toBe(true);
      await stationary();
      await capture("ready");
      await action.click();
      await expect(action).toHaveText("Sharing…");
      await expect(action).toBeDisabled();
      await page.evaluate(() =>
        (window as unknown as MenuWindow).resourceMenu.shareProgress?.({
          label: "Uploading reviewed files",
          completed: 2,
          total: 3,
        }),
      );
      await expect(statusPill(dialog)).toHaveText("Sending 2 of 3");
      await stationary();
      await capture("sending");
      await page.evaluate(() =>
        (window as unknown as MenuWindow).resourceMenu.failShare?.(),
      );
      await expect(
        page.getByRole("dialog", { name: "Couldn’t share", exact: true }),
      ).toBeVisible();
      await expect(statusPill(dialog)).toHaveAttribute(
        "title",
        /Connection interrupted while sharing/,
      );
      await stationary();
      await capture("share-failed");
      // Trying again prepares a fresh review instead of resending the old token.
      await action.click();
      await expect(statusPill(dialog)).toHaveText("Preparing preview");
      await page.evaluate(() =>
        (window as unknown as MenuWindow).resourceMenu.finishPreview?.(),
      );
      await action.click();
      await page.evaluate(() => {
        const controls = (window as unknown as MenuWindow).resourceMenu;
        controls.shareStatus = "approval_required";
        controls.finishShare?.();
      });
      await expect(
        page.getByRole("dialog", { name: "Sent for approval", exact: true }),
      ).toBeVisible();
      await expect(statusPill(dialog)).toHaveText("Awaiting approval");
      await stationary();
      await capture("sent-for-approval");
      expect(await resourceCalls(page, "preview-share")).toHaveLength(3);
      expect(await resourceCalls(page, "share")).toHaveLength(2);
      expect(
        await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      expect(
        (await new AxeBuilder({ page }).include(".share-dialog").analyze())
          .violations,
      ).toEqual([]);
      await dialog.getByRole("button", { name: "Done", exact: true }).click();
      await expect(
        resourceRow(page, "Private session notes").getByRole("button", {
          name: "Private session notes",
          exact: true,
        }),
      ).toBeFocused();
    });
  }
}

test("a conflict result stays in the dialog instead of claiming success", async ({
  page,
}) => {
  await menuFixture(page);
  await collection(page, "Memories");
  await page.evaluate(() => {
    (window as unknown as MenuWindow).resourceMenu.shareStatus = "conflict";
  });
  await resourceMenu(page, "Private memory notes", "Share with team…");
  await shareDialog(page)
    .getByRole("button", { name: "Share with team", exact: true })
    .click();
  const result = shareDialog(page, "Someone changed it first");
  await expect(statusPill(result)).toHaveText("Version conflict");
  await expect(page.getByText("Shared with team", { exact: true })).toHaveCount(
    0,
  );
});

test("closing while sending lets the share finish and reports it by toast", async ({
  page,
}) => {
  await menuFixture(page);
  await collection(page, "Memories");
  await page.evaluate(() => {
    const controls = (window as unknown as MenuWindow).resourceMenu;
    controls.deferShare = true;
    controls.shareStatus = "published";
  });
  await resourceMenu(page, "Private memory notes", "Share with team…");
  const dialog = shareDialog(page);
  await dialog
    .getByRole("button", { name: "Share with team", exact: true })
    .click();
  await expect(statusPill(dialog)).toHaveText("Sending");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() =>
    (window as unknown as MenuWindow).resourceMenu.finishShare?.(),
  );
  await expect(
    page.getByText("Shared with team", { exact: true }),
  ).toBeVisible();
  expect(await resourceCalls(page, "share")).toHaveLength(1);
});

test("a review that is about to expire is prepared again on its own", async ({
  page,
}) => {
  await page.clock.install();
  await menuFixture(page);
  await collection(page, "Memories");
  await page.evaluate(() => {
    (window as unknown as MenuWindow).resourceMenu.previewExpiresIn = 600;
  });
  await resourceMenu(page, "Private memory notes", "Share with team…");
  const dialog = shareDialog(page);
  await expect(statusPill(dialog)).toHaveText("On your Mac");
  expect(await resourceCalls(page, "preview-share")).toHaveLength(1);
  await page.clock.runFor(600_000);
  await expect
    .poll(async () => (await resourceCalls(page, "preview-share")).length)
    .toBe(2);
  await expect(statusPill(dialog)).toHaveText("On your Mac");
  expect(await resourceCalls(page, "share")).toEqual([]);
});

test("canceled snapshot preparation cannot update a reopened review", async ({
  page,
}) => {
  await menuFixture(page);
  await collection(page, "Memories");
  await page.evaluate(() => {
    (window as unknown as MenuWindow).resourceMenu.deferPreview = true;
  });
  await resourceMenu(page, "Private memory notes", "Share with team…");
  const dialog = shareDialog(page);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await resourceMenu(page, "Private memory notes", "Share with team…");
  await page.evaluate(() => {
    (window as unknown as MenuWindow).resourceMenu.finishPreviews[0]?.();
  });
  const confirm = dialog.getByRole("button", {
    name: "Share with team",
    exact: true,
  });
  await expect(statusPill(dialog)).toHaveText("Preparing preview");
  await expect(confirm).toBeDisabled();
  await page.evaluate(() =>
    (window as unknown as MenuWindow).resourceMenu.finishPreview?.(),
  );
  await expect(confirm).toBeEnabled();
  expect(await resourceCalls(page, "share")).toEqual([]);
});

test("shared deletion retries a network failure with the same reviewed token before acknowledged success", async ({
  page,
}) => {
  await menuFixture(page, { emptyLocal: true });
  await collection(page, "Plans");
  await page.evaluate(() => {
    const controls = (window as unknown as MenuWindow).resourceMenu;
    controls.deleteFailures = 1;
  });
  await resourceMenu(page, "My shared plan", "Delete shared plan…");
  const dialog = page.getByRole("dialog", {
    name: "Delete shared plan",
    exact: true,
  });
  await expect(dialog).toContainText("installed copies through sync");
  expect(await resourceCalls(page, "delete")).toEqual([]);
  const confirm = dialog.getByRole("button", {
    name: "Confirm deletion",
    exact: true,
  });
  await confirm.click();
  await expect(dialog.getByRole("alert")).toContainText(
    "deletion was not completed",
  );
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  await expect(resourceRow(page, "My shared plan")).toHaveCount(0);
  const deletes = await resourceCalls(page, "delete");
  expect(deletes).toHaveLength(2);
  expect(
    new Set(
      deletes.map(
        (call) => (call.args.input as { previewToken: string }).previewToken,
      ),
    ),
  ).toEqual(new Set(["frozen-preview-delete-plan-own"]));
});

test("removing shared history from Home refreshes a cached collection for newly discovered local sessions", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-11-14T10:00:00Z"));
  await menuFixture(page, { emptyLocal: true });
  await page.evaluate(async () => {
    const host = window as unknown as MenuWindow;
    const original = host.__TAURI_INTERNALS__.invoke;
    const snapshot = (await original("snapshot")) as Snapshot;
    const shared = snapshot.resources.find(
      (resource) => resource.resourceId === "session-own",
    )!;
    host.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      const result = await original(command, args);
      if (
        command === "local_resource_catalog" &&
        args.kind === "session" &&
        host.resourceMenu.deleted.includes(shared.resourceId)
      )
        return {
          resources: [
            {
              ...shared,
              resourceId: "session-retained",
              title: "New private session notes",
              local: true,
              revision: 0,
            },
          ],
          errors: [],
        };
      return result;
    };
  });
  const scans = () =>
    page.evaluate(
      () =>
        (window as unknown as MenuWindow).library.calls.filter(
          (call) =>
            call.command === "local_resource_catalog" &&
            call.args.refresh !== false &&
            call.args.kind === "session",
        ).length,
    );
  const home = page.getByRole("button", { name: "Home", exact: true });
  await collection(page, "Sessions");
  await expect(resourceRow(page, "My shared session")).toBeVisible();
  expect(await scans()).toBe(1);
  await home.click();
  await collection(page, "Sessions");
  expect(await scans()).toBe(1);
  await home.click();
  await page
    .getByRole("list", { name: "Recently updated resources" })
    .locator('[data-resource-id="session-own"]')
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Remove from history…", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Remove from history",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "Confirm deletion", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await collection(page, "Sessions");
  await expect.poll(scans).toBe(2);
  await expect(
    resourceRow(page, "New private session notes").getByLabel("On this Mac", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(resourceRow(page, "My shared session")).toHaveCount(0);
  expect(await resourceCalls(page, "delete")).toHaveLength(1);
});

test("a changed shared resource invalidates an open deletion review", async ({
  page,
}) => {
  await menuFixture(page, { emptyLocal: true });
  await collection(page, "Plans");
  await resourceMenu(page, "My shared plan", "Delete shared plan…");
  const dialog = page.getByRole("dialog", {
    name: "Delete shared plan",
    exact: true,
  });
  await expect(
    dialog.getByRole("button", { name: "Confirm deletion", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => {
    (window as unknown as MenuWindow).resourceMenu.resourceVersion += 1;
  });
  await expect(dialog.getByRole("alert")).toContainText(
    "This item or account changed",
  );
  await expect(
    dialog.getByRole("button", { name: "Confirm deletion", exact: true }),
  ).toBeDisabled();
  expect(await resourceCalls(page, "delete")).toEqual([]);
});

test("a late snapshot preview cannot be submitted after changing accounts", async ({
  page,
}) => {
  await menuFixture(page);
  await collection(page, "Memories");
  await page.evaluate(() => {
    (window as unknown as MenuWindow).resourceMenu.deferPreview = true;
  });
  await resourceMenu(page, "Private memory notes", "Share with team…");
  const dialog = shareDialog(page);
  await expect(
    dialog.getByRole("button", { name: "Share with team", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => {
    (window as unknown as MenuWindow).library.user = "another-user";
  });
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() => {
    (window as unknown as MenuWindow).resourceMenu.finishPreview?.();
  });
  await expect(dialog).toHaveCount(0);
  expect(await resourceCalls(page, "share")).toEqual([]);
});

test("app chrome suppresses webview menus while text fields and selected resource text keep native editing", async ({
  page,
}) => {
  await menuFixture(page, { emptyLocal: true });
  await collection(page, "Memories");
  const allowed = (target: HTMLElement) =>
    target.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
  expect(await page.locator("main").evaluate(allowed)).toBe(false);
  expect(
    await page
      .getByRole("searchbox", { name: "Search memories", exact: true })
      .evaluate(allowed),
  ).toBe(true);
  const text = resourceRow(page, "My shared memory").getByRole("button", {
    name: "My shared memory",
    exact: true,
  });
  expect(
    await text.evaluate((target) => {
      const selection = window.getSelection()!;
      const range = document.createRange();
      range.selectNodeContents(target);
      selection.removeAllRanges();
      selection.addRange(range);
      return target.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      );
    }),
  ).toBe(true);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await text.focus();
  await text.press("Shift+F10");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await text.click();
  await page
    .getByRole("region", { name: "Memory details", exact: true })
    .evaluate((element) => {
      const link = document.createElement("a");
      link.href = "https://example.com/notes";
      link.textContent = "Read linked notes";
      element.append(link);
      const input = document.createElement("input");
      input.setAttribute("aria-label", "Local note text");
      element.append(input);
    });
  for (const target of [
    page.getByRole("link", { name: "Read linked notes" }),
    page.getByRole("textbox", { name: "Local note text" }),
  ]) {
    await target.focus();
    await target.press("Shift+F10");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(target).toBeFocused();
  }
});

test("read-only shared skills retain copy and export but omit sharing and deletion", async ({
  page,
}) => {
  await skillFixture(page, { role: "member", access: "read", open: false });
  await page.locator(".index-table tbody tr").click({
    button: "right",
    position: { x: 8, y: 8 },
  });
  const menu = page.getByRole("menu", { name: "skill actions", exact: true });
  await expect(
    menu.getByRole("menuitem", { name: "Copy link", exact: true }),
  ).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: /Delete shared skill|Share with team/ }),
  ).toHaveCount(0);
  // The Skills index shows every action in one list, with no submenu.
  await expect(
    menu.getByRole("menuitem", { name: "More actions", exact: true }),
  ).toHaveCount(0);
  await expect(
    menu.getByRole("menuitem", { name: "Export ZIP…", exact: true }),
  ).toBeVisible();
});
