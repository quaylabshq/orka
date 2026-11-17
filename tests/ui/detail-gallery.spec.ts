import { test, expect, type Page } from "@playwright/test";
import {
  capture,
  compact,
  detailGalleryFixture,
  extraWide,
  wide,
  type DetailGalleryOptions,
} from "./fixtures/detail-gallery.js";

// States page: one screenshot per state of the shared detail layout for
// memories, plans, and sessions. Assertions keep each capture honest about
// what is on screen. Skills are captured by skill-detail-gallery.spec.ts.
async function open(
  page: Page,
  viewport: { width: number; height: number },
  options: DetailGalleryOptions,
) {
  await page.setViewportSize(viewport);
  return detailGalleryFixture(page, options);
}
const stateTitle = (page: Page) => page.locator(".reader-state-title");

for (const kind of ["memory", "plan"] as const) {
  const folder = kind === "memory" ? "memories" : "plans";
  const label = kind === "memory" ? "Memory" : "Plan";
  const files = ["content.md", "notes/checklist.md", "scripts/check.sh"];
  const rail = (page: Page) =>
    page.getByRole("complementary", { name: `${label} information` });

  test(`${kind}: reader and raw Markdown`, async ({ page }) => {
    const view = await open(page, wide, { kind });
    await expect(
      view.getByRole("article", { name: "Rendered Markdown" }),
    ).toBeVisible();
    await expect(rail(page).locator(".detail-facts")).toContainText("Version3");
    await capture(
      page,
      folder,
      "01-reader",
      "Default. Title card, Formatted view, and the info panel with facts and actions.",
    );
    await view.getByRole("button", { name: "Markdown", exact: true }).click();
    await expect(
      view.getByRole("group", { name: "Markdown source" }),
    ).toBeVisible();
    await capture(
      page,
      folder,
      "02-raw-markdown",
      "The Markdown toggle shows the original file.",
    );
  });

  test(`${kind}: loading`, async ({ page }) => {
    const view = await open(page, wide, { kind, inspect: "hold" });
    await expect(
      view.getByRole("status").filter({ hasText: "Loading content…" }),
    ).toHaveCount(1);
    await page.waitForTimeout(400);
    await capture(
      page,
      folder,
      "03-loading",
      "Content is loading. The title, facts, and Back stay usable.",
    );
  });

  test(`${kind}: read failed`, async ({ page }) => {
    await open(page, wide, { kind, inspect: "error" });
    await expect(stateTitle(page)).toHaveText("Couldn’t load content.md");
    await capture(
      page,
      folder,
      "04-read-failed",
      "The file could not be read. Retry is offered.",
    );
  });

  test(`${kind}: offline and uncached`, async ({ page }) => {
    await open(page, wide, { kind, inspect: "error", offline: true });
    await expect(stateTitle(page)).toHaveText("File unavailable offline");
    await capture(
      page,
      folder,
      "05-offline-uncached",
      "Offline with no cached copy of the file.",
    );
  });

  test(`${kind}: file missing`, async ({ page }) => {
    await open(page, wide, { kind, inspect: "missing" });
    await expect(stateTitle(page)).toHaveText("content.md is missing");
    await capture(
      page,
      folder,
      "06-file-missing",
      "The file is listed but no longer exists.",
    );
  });

  test(`${kind}: empty file`, async ({ page }) => {
    await open(page, wide, { kind, content: "" });
    await expect(stateTitle(page)).toHaveText("Empty file");
    await capture(page, folder, "07-empty-file", "The file has no content.");
  });

  test(`${kind}: comparing`, async ({ page }) => {
    const view = await open(page, wide, { kind });
    await rail(page).locator(".detail-compare").click();
    await expect(view.locator(".diff-lines")).toBeVisible();
    await capture(
      page,
      folder,
      "08-comparing",
      "View changes compares with the previous version. The button flips to Show content.",
    );
  });

  test(`${kind}: comparing without changes`, async ({ page }) => {
    await open(page, wide, { kind, previous: "equal" });
    await rail(page).locator(".detail-compare").click();
    await expect(stateTitle(page)).toHaveText("No changes");
    await capture(
      page,
      folder,
      "09-no-changes",
      "Comparing when the file matches its previous version.",
    );
  });

  test(`${kind}: comparing without a cached previous version`, async ({
    page,
  }) => {
    await open(page, wide, { kind, previous: "missing" });
    await rail(page).locator(".detail-compare").click();
    await expect(stateTitle(page)).toHaveText("Previous version unavailable");
    await capture(
      page,
      folder,
      "10-previous-unavailable",
      "Comparing when the previous version isn’t cached on this Mac.",
    );
  });

  test(`${kind}: on this Mac`, async ({ page }) => {
    const view = await open(page, wide, { kind, local: true });
    await expect(view.locator(".detail-status")).toHaveText("On this Mac");
    await expect(rail(page).locator(".detail-compare")).toHaveCount(0);
    await capture(
      page,
      folder,
      "11-on-this-mac",
      "Never shared. No version, no link, and no View changes.",
    );
  });

  test(`${kind}: local changes`, async ({ page }) => {
    const view = await open(page, wide, { kind, localChanges: true });
    await expect(view.locator(".detail-status")).toHaveText("Local changes");
    await capture(
      page,
      folder,
      "12-local-changes",
      "Shared, with newer edits that are only on this Mac.",
    );
  });

  test(`${kind}: multiple files`, async ({ page }) => {
    const view = await open(page, wide, {
      kind,
      files,
      repository: "orka-app",
    });
    await expect(rail(page).locator(".detail-file")).toHaveCount(3);
    await expect(rail(page).locator(".detail-facts")).toContainText(
      "Repositoryorka-app",
    );
    await capture(
      page,
      folder,
      "13-multiple-files",
      "More than one file adds the Files card. A repository adds a Repository fact.",
    );
    await rail(page)
      .locator(".detail-file")
      .filter({ hasText: "scripts/check.sh" })
      .click();
    await expect(view.locator(".source-card-type")).toHaveText("Shell script");
    await capture(
      page,
      folder,
      "14-script-file",
      "A non-Markdown file shows as source, without the Formatted toggle.",
    );
  });

  test(`${kind}: folder disconnected`, async ({ page }) => {
    const view = await open(page, wide, { kind, disconnected: true });
    await expect(view.locator(".detail-context")).toContainText(
      "Reconnect the project folder",
    );
    await expect(
      rail(page).getByRole("button", { name: "Open in editor", exact: true }),
    ).toBeDisabled();
    await capture(
      page,
      folder,
      "15-folder-disconnected",
      "The project folder isn’t connected, so Open in editor is disabled.",
    );
  });

  test(`${kind}: compact`, async ({ page }) => {
    const view = await open(page, compact, { kind, files });
    await expect(view).toHaveAttribute("data-layout", "compact");
    await expect(view.locator(".detail-title-card")).toHaveCSS(
      "padding",
      "0px",
    );
    await expect(view.locator(".detail-meta")).toContainText("Version 3");
    await capture(
      page,
      folder,
      "16-compact",
      "Narrow window. The panel folds into a meta line and an action row.",
    );
    await view.getByRole("button", { name: "Files, 3", exact: true }).click();
    await expect(page.locator(".detail-files-popover")).toBeVisible();
    await capture(
      page,
      folder,
      "17-compact-files",
      "Narrow window. Files open from a menu instead of a card.",
    );
  });

  test(`${kind}: extra wide`, async ({ page }) => {
    const view = await open(page, extraWide, { kind });
    const reader = await view.locator(".detail-title-card").boundingBox();
    expect(Math.round(reader!.width)).toBe(870);
    await capture(
      page,
      folder,
      "18-extra-wide",
      "A 1920px window. Content stays 870px wide and sits centered with the panel.",
    );
  });
}

const sessionRail = (page: Page) =>
  page.getByRole("complementary", { name: "Session information" });
const launcher = (page: Page) =>
  page.getByRole("button", { name: /^(Fork and open|Continue|Open) in/ });

test("session: conversation and raw Markdown", async ({ page }) => {
  const view = await open(page, wide, { kind: "session" });
  await expect(view.locator(".session-turn")).toHaveCount(4);
  await expect(launcher(page)).toBeEnabled();
  await capture(
    page,
    "sessions",
    "01-conversation",
    "Default. Conversation view, with the launcher as the primary action in the info panel.",
  );
  await page
    .getByRole("button", { name: "More resource actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Show Markdown", exact: true })
    .click();
  await expect(view.locator(".session-turn pre.content").first()).toBeVisible();
  await capture(
    page,
    "sessions",
    "02-raw-markdown",
    "Show Markdown in the More menu shows each turn as literal text.",
  );
});

test("session: loading", async ({ page }) => {
  const view = await open(page, wide, { kind: "session", messages: "hold" });
  await expect(view.locator(".loading-region")).toHaveAttribute(
    "aria-busy",
    "true",
  );
  await page.waitForTimeout(400);
  await capture(
    page,
    "sessions",
    "03-loading",
    "Messages are loading. The title, facts, and launcher stay usable.",
  );
});

test("session: read failed", async ({ page }) => {
  const view = await open(page, wide, { kind: "session", messages: "error" });
  await expect(view.locator(".reader-state-title")).toHaveText(
    "Couldn’t load this conversation",
  );
  await capture(
    page,
    "sessions",
    "04-read-failed",
    "The conversation could not be read. Retry is offered.",
  );
});

test("session: no readable messages", async ({ page }) => {
  const view = await open(page, wide, { kind: "session", messages: "empty" });
  await expect(view.locator(".reader-state-title")).toHaveText(
    "No conversation messages",
  );
  await capture(
    page,
    "sessions",
    "05-no-messages",
    "The session has no readable conversation turns.",
  );
});

test("session: long conversation", async ({ page }) => {
  const view = await open(page, wide, { kind: "session", messages: "long" });
  await expect(view.locator(".session-turn").first()).toBeVisible();
  await view.locator(".detail-reader").evaluate((element) => {
    element.scrollTop = 600;
  });
  await page.waitForTimeout(200);
  await capture(
    page,
    "sessions",
    "06-long-conversation",
    "Scrolled. The conversation scrolls on its own and the info panel stays in place.",
  );
});

test("session: transcript", async ({ page }) => {
  const view = await open(page, wide, { kind: "session" });
  await view.getByRole("button", { name: "Transcript", exact: true }).click();
  await expect(
    view.locator("pre.content").filter({ hasText: '"type":"user"' }),
  ).toBeVisible();
  await expect(
    view.getByRole("button", { name: "Transcript", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  // Let the toggle finish its transition before the capture.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
  await capture(
    page,
    "sessions",
    "07-transcript",
    "Transcript shows the original session file.",
  );
});

test("session: transcript read failed", async ({ page }) => {
  const view = await open(page, wide, { kind: "session", inspect: "error" });
  await view.getByRole("button", { name: "Transcript", exact: true }).click();
  await expect(view.locator(".reader-state-title")).toHaveText(
    "Couldn’t load the transcript",
  );
  await capture(
    page,
    "sessions",
    "08-transcript-failed",
    "The transcript could not be read. Retry is offered.",
  );
});

test("session: conflict", async ({ page }) => {
  const view = await open(page, wide, { kind: "session", conflict: true });
  await expect(view.locator(".conflict")).toContainText(
    "Two session versions need a choice.",
  );
  await capture(
    page,
    "sessions",
    "09-conflict",
    "Two versions need a choice. The panel sits above the conversation it affects.",
  );
  await view
    .getByRole("button", { name: "View incoming version", exact: true })
    .click();
  await expect(
    view.getByRole("button", { name: "View incoming version", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(view.locator(".session-turn").first()).toBeVisible();
  await capture(
    page,
    "sessions",
    "10-conflict-preview",
    "Previewing the incoming version before choosing.",
  );
});

test("session: another person's session", async ({ page }) => {
  await open(page, wide, { kind: "session", owner: "teammate" });
  await expect(sessionRail(page).locator(".detail-info-note")).toHaveText(
    "Resuming saves your continuation as a copy.",
  );
  await capture(
    page,
    "sessions",
    "11-another-owner",
    "Someone else’s session. A note next to the launcher explains the copy.",
  );
});

test("session: forked", async ({ page }) => {
  const view = await open(page, wide, { kind: "session", fork: true });
  // The chip is short; its meaning is spelled out for assistive technology.
  await expect(view.locator(".detail-status")).toHaveText(
    "Forked. Opening continues this session; choose Fork and open to create another.",
  );
  await expect(sessionRail(page).locator(".detail-info-note")).toHaveCount(0);
  await expect(launcher(page)).toHaveText(/Open in Claude Desktop/);
  await capture(
    page,
    "sessions",
    "12-forked",
    "A fork you own. A Forked chip above the title; the launcher continues it.",
  );
});

test("session: launcher menu and launch error", async ({ page }) => {
  await open(page, wide, { kind: "session", resumeError: true });
  await page
    .getByRole("button", { name: "Choose how to open session" })
    .click();
  await expect(page.getByRole("menu", { name: "Open session" })).toBeVisible();
  // Let the menu finish opening before the capture.
  await page.waitForTimeout(400);
  await capture(
    page,
    "sessions",
    "13-launcher-menu",
    "The launcher menu: other apps, copy prompt, and Download session.",
  );
  await page.keyboard.press("Escape");
  await launcher(page).click();
  await expect(
    sessionRail(page).locator(".detail-info-note--error"),
  ).toHaveText("Could not launch destination");
  await capture(
    page,
    "sessions",
    "14-launch-error",
    "Opening failed. The error stays next to the launcher, with a toast.",
  );
});

test("session: on this Mac", async ({ page }) => {
  const view = await open(page, wide, { kind: "session", local: true });
  await expect(view.locator(".detail-status")).toHaveText("On this Mac");
  await expect(view.locator(".session-turn").first()).toBeVisible();
  await capture(
    page,
    "sessions",
    "15-on-this-mac",
    "Never shared. No version and no link.",
  );
});

test("session: local changes", async ({ page }) => {
  const view = await open(page, wide, { kind: "session", localChanges: true });
  await expect(view.locator(".detail-status")).toHaveText("Local changes");
  await expect(view.locator(".session-turn").first()).toBeVisible();
  await capture(
    page,
    "sessions",
    "16-local-changes",
    "Shared, with newer turns that are only on this Mac.",
  );
});

test("session: folder disconnected", async ({ page }) => {
  const view = await open(page, wide, { kind: "session", disconnected: true });
  await expect(view.locator(".session-turn").first()).toBeVisible();
  await expect(launcher(page)).toBeDisabled();
  await capture(
    page,
    "sessions",
    "17-folder-disconnected",
    "The repository isn’t connected, so the session can be read but not opened.",
  );
});

test("session: compact", async ({ page }) => {
  const view = await open(page, compact, {
    kind: "session",
    owner: "teammate",
  });
  await expect(view).toHaveAttribute("data-layout", "compact");
  await expect(view.locator(".detail-title-card")).toHaveCSS("padding", "0px");
  await expect(view.locator(".session-turn").first()).toBeVisible();
  await capture(
    page,
    "sessions",
    "18-compact",
    "Narrow window. The panel folds into a meta line, notes, and an action row.",
  );
  await page
    .getByRole("button", { name: "Choose how to open session" })
    .click();
  await expect(page.getByRole("menu", { name: "Open session" })).toBeVisible();
  // Let the menu finish opening before the capture.
  await page.waitForTimeout(400);
  await capture(
    page,
    "sessions",
    "19-compact-launcher-menu",
    "Narrow window with the launcher menu open.",
  );
});

test("session: extra wide", async ({ page }) => {
  const view = await open(page, extraWide, { kind: "session" });
  await expect(view.locator(".session-turn").first()).toBeVisible();
  const reader = await view.locator(".detail-title-card").boundingBox();
  expect(Math.round(reader!.width)).toBe(870);
  await capture(
    page,
    "sessions",
    "20-extra-wide",
    "A 1920px window. The conversation stays 870px wide and sits centered with the panel.",
  );
});

// Implicit states: what appears on hover, focus, right-click, or mid-action,
// plus variants no explicit state above covers.
const settle = (page: Page) => page.waitForTimeout(400);
async function tabTo(page: Page, name: string | RegExp) {
  const target = page.getByRole("button", { name });
  for (let presses = 0; presses < 40; presses++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((element) => element === document.activeElement))
      return target;
  }
  throw new Error(`Tab never reached ${name}`);
}

for (const kind of ["memory", "plan"] as const) {
  const folder = kind === "memory" ? "memories" : "plans";
  const label = kind === "memory" ? "Memory" : "Plan";
  const files = ["content.md", "notes/checklist.md", "scripts/check.sh"];
  const rail = (page: Page) =>
    page.getByRole("complementary", { name: `${label} information` });

  test(`${kind}: menus`, async ({ page }) => {
    const view = await open(page, wide, { kind });
    await page
      .getByRole("button", { name: "More resource actions", exact: true })
      .click();
    await expect(
      page.getByRole("menuitem", { name: "Copy content", exact: true }),
    ).toBeVisible();
    await settle(page);
    await capture(page, folder, "19-more-menu", "Implicit. The More menu.");
    await page.keyboard.press("Escape");
    await view.locator(".markdown-content").click({ button: "right" });
    await expect(
      page.getByRole("menuitem", { name: "Open in editor", exact: true }),
    ).toBeVisible();
    await settle(page);
    await capture(
      page,
      folder,
      "20-context-menu",
      "Implicit. Right-clicking anywhere in the reader opens the same actions.",
    );
  });

  test(`${kind}: tooltip and copied link`, async ({ page }) => {
    await open(page, wide, { kind });
    const copy = rail(page).getByRole("button", {
      name: `Copy ${kind} link`,
      exact: true,
    });
    await copy.hover();
    await expect(page.locator(".skill-action-tooltip")).toHaveText(
      `Copy ${kind} link`,
    );
    await capture(
      page,
      folder,
      "21-action-tooltip",
      "Implicit. Icon actions name themselves on hover.",
    );
    await copy.click();
    await expect(rail(page).locator('[data-copied="true"]')).toBeVisible();
    await settle(page);
    await capture(
      page,
      folder,
      "22-link-copied",
      "Implicit. Copy link confirms in place for two seconds.",
    );
  });

  test(`${kind}: hover and keyboard focus`, async ({ page }) => {
    await open(page, wide, { kind, files });
    const compare = rail(page).locator(".detail-compare");
    await compare.hover();
    await settle(page);
    expect(await compare.evaluate((element) => element.matches(":hover"))).toBe(
      true,
    );
    await capture(
      page,
      folder,
      "23-button-hover",
      "Implicit. Hovering View changes.",
    );
    const row = rail(page)
      .locator(".detail-file")
      .filter({ hasText: "notes/checklist.md" });
    await row.hover();
    await settle(page);
    await capture(
      page,
      folder,
      "24-file-hover",
      "Implicit. Hovering a file that isn’t selected.",
    );
    await page.mouse.move(0, 0);
    const editor = await tabTo(page, "Open in editor");
    await expect(editor).toBeFocused();
    await capture(
      page,
      folder,
      "25-keyboard-focus",
      "Implicit. The focus ring when tabbing to Open in editor.",
    );
  });

  test(`${kind}: editor failure toast`, async ({ page }) => {
    await open(page, wide, { kind, editorFailure: true });
    await rail(page)
      .getByRole("button", { name: "Open in editor", exact: true })
      .click();
    await expect(page.locator("[data-orka-toast]")).toContainText(
      "Couldn’t open editor",
    );
    await capture(
      page,
      folder,
      "26-editor-failure-toast",
      "Implicit. Opening the editor failed.",
    );
  });

  test(`${kind}: long title`, async ({ page }) => {
    const view = await open(page, wide, { kind, longTitle: true });
    const title = await view.locator(".detail-title").boundingBox();
    expect(title!.height).toBeGreaterThan(40);
    await capture(
      page,
      folder,
      "27-long-title",
      "Implicit. A long title wraps instead of truncating.",
    );
  });

  test(`${kind}: view-only access`, async ({ page }) => {
    const view = await open(page, wide, { kind, viewOnly: true });
    const request = view.locator(".detail-toolbar").getByRole("button", {
      name: "Request editing access",
      exact: true,
    });
    await expect(request).toBeVisible();
    await capture(
      page,
      folder,
      "28-view-only-access",
      "Implicit. A member who can only view gets a request button beside the Formatted toggle.",
    );
    await request.click();
    await expect(
      page.getByRole("dialog", { name: "Request access" }),
    ).toBeVisible();
    await settle(page);
    await capture(
      page,
      folder,
      "29-request-access",
      "Implicit. The request dialog that button opens.",
    );
  });

  test(`${kind}: compact variants`, async ({ page }) => {
    const view = await open(page, compact, { kind, local: true });
    await expect(view.locator(".detail-compact-notes")).toContainText(
      "hasn’t been shared",
    );
    await capture(
      page,
      folder,
      "30-compact-on-this-mac",
      "Implicit. Narrow window for something never shared: the note moves under the meta line.",
    );
  });

  test(`${kind}: compact comparing`, async ({ page }) => {
    const view = await open(page, compact, { kind, longTitle: true });
    await view.getByRole("button", { name: "View changes" }).click();
    await expect(view.locator(".diff-lines")).toBeVisible();
    await capture(
      page,
      folder,
      "31-compact-comparing",
      "Implicit. Narrow window with a long title, comparing changes.",
    );
  });
}

test("session: menus", async ({ page }) => {
  const view = await open(page, wide, { kind: "session" });
  await expect(view.locator(".session-turn")).toHaveCount(4);
  await page
    .getByRole("button", { name: "More resource actions", exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Copy session prompt", exact: true }),
  ).toBeVisible();
  await settle(page);
  await capture(
    page,
    "sessions",
    "21-more-menu",
    "Implicit. The More menu for a session.",
  );
  await page.keyboard.press("Escape");
  await view.locator(".session-turn").first().click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Copy session prompt", exact: true }),
  ).toBeVisible();
  await settle(page);
  await capture(
    page,
    "sessions",
    "22-context-menu",
    "Implicit. Right-clicking a turn opens the same actions.",
  );
});

test("session: tooltip, copied link, and focus", async ({ page }) => {
  await open(page, wide, { kind: "session" });
  await sessionRail(page)
    .getByRole("button", { name: "Download session", exact: true })
    .hover();
  await expect(page.locator(".skill-action-tooltip")).toHaveText(
    "Download session",
  );
  await capture(
    page,
    "sessions",
    "23-action-tooltip",
    "Implicit. Icon actions name themselves on hover.",
  );
  await sessionRail(page)
    .getByRole("button", { name: "Copy session link", exact: true })
    .click();
  await expect(sessionRail(page).locator('[data-copied="true"]')).toBeVisible();
  await settle(page);
  await capture(
    page,
    "sessions",
    "24-link-copied",
    "Implicit. Copy link confirms in place for two seconds.",
  );
  await page.mouse.move(0, 0);
  const open_ = await tabTo(page, /^Fork and open in/);
  await expect(open_).toBeFocused();
  await capture(
    page,
    "sessions",
    "25-keyboard-focus",
    "Implicit. The focus ring when tabbing to the launcher.",
  );
});

test("session: checking apps", async ({ page }) => {
  await open(page, wide, { kind: "session", launch: "slow" });
  await page
    .getByRole("button", { name: "Choose how to open session" })
    .click();
  await expect(page.getByRole("menu", { name: "Open session" })).toContainText(
    "Checking apps…",
  );
  await settle(page);
  await capture(
    page,
    "sessions",
    "26-checking-apps",
    "Implicit. Until the installed apps are known, the launcher is disabled and its menu shows placeholder rows.",
  );
});

test("session: no compatible app", async ({ page }) => {
  await open(page, wide, { kind: "session", launch: "none" });
  await page
    .getByRole("button", { name: "Choose how to open session" })
    .click();
  await expect(page.getByRole("menu", { name: "Open session" })).toContainText(
    "No compatible app available.",
  );
  await settle(page);
  await capture(
    page,
    "sessions",
    "27-no-compatible-app",
    "Implicit. No app on this Mac can open the session. Copy prompt and Download remain.",
  );
});

test("session: loading more messages", async ({ page }) => {
  const view = await open(page, wide, { kind: "session", messages: "paged" });
  await expect(view.locator(".session-turn").first()).toBeVisible();
  await view.locator(".detail-reader").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(
    view.getByText("Loading messages…", { exact: true }),
  ).toBeVisible();
  await capture(
    page,
    "sessions",
    "29-loading-more",
    "Implicit. Reaching the end of a long session loads the next page of turns.",
  );
});

test("session: transcript loading", async ({ page }) => {
  const view = await open(page, wide, { kind: "session", inspect: "hold" });
  await view.getByRole("button", { name: "Transcript", exact: true }).click();
  await expect(
    view.getByRole("status").filter({ hasText: "Loading content…" }),
  ).toHaveCount(1);
  await page.mouse.move(0, 0);
  await settle(page);
  await capture(
    page,
    "sessions",
    "30-transcript-loading",
    "Implicit. The transcript loads only when it is first opened.",
  );
});

test("session: long title and view-only access", async ({ page }) => {
  const view = await open(page, wide, {
    kind: "session",
    longTitle: true,
    viewOnly: true,
  });
  await expect(view.locator(".session-turn").first()).toBeVisible();
  await expect(
    view.locator(".detail-toolbar").getByRole("button", {
      name: "Request editing access",
      exact: true,
    }),
  ).toBeVisible();
  await capture(
    page,
    "sessions",
    "31-long-title-view-only",
    "Implicit. A long title wraps, and a view-only member gets a request button beside the view toggle.",
  );
});

test("session: compact conflict and transcript", async ({ page }) => {
  const view = await open(page, compact, { kind: "session", conflict: true });
  await expect(view.locator(".conflict")).toBeVisible();
  await capture(
    page,
    "sessions",
    "32-compact-conflict",
    "Implicit. Narrow window with a conflict to resolve.",
  );
  await view.getByRole("button", { name: "Transcript", exact: true }).click();
  await expect(
    view.locator("pre.content").filter({ hasText: '"type":"user"' }),
  ).toBeVisible();
  await page.mouse.move(0, 0);
  await settle(page);
  await capture(
    page,
    "sessions",
    "33-compact-transcript",
    "Implicit. Narrow window in Transcript view.",
  );
});
