import { test, expect, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import type {
  Snapshot,
  SyncProgress,
  SyncQueueEntry,
} from "../../apps/mac/src/types.js";

declare global {
  interface Window {
    syncProgressFixture: {
      progress: SyncProgress | null;
      queue: SyncQueueEntry[];
      sync: Snapshot["sync"];
      running: boolean;
      errors: Snapshot["errors"];
      calls: string[];
      cancelled: string[];
      projectNames: Record<string, string>;
    };
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const fixture: Window["syncProgressFixture"] = {
      progress: null,
      queue: [],
      sync: { online: true, lastSync: "2026-11-13T08:00:00Z" },
      running: true,
      errors: [],
      calls: [],
      cancelled: [],
      projectNames: { one: "Orka", two: "Docs", three: "Site" },
    };
    Object.assign(window, {
      syncProgressFixture: fixture,
      isTauri: true,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: async (name: string, args?: { projectId?: string }) => {
          fixture.calls.push(name);
          if (name === "snapshot")
            return {
              user: "user",
              config: { apiUrl: "https://test.local", syncMinutes: 15 },
              projects: [
                {
                  id: "one",
                  name: fixture.projectNames.one,
                  path: "/test/orka",
                  role: "owner",
                },
                {
                  id: "two",
                  name: fixture.projectNames.two,
                  path: "/test/docs",
                  role: "owner",
                },
                {
                  id: "three",
                  name: fixture.projectNames.three,
                  path: "/test/site",
                  role: "owner",
                },
              ],
              resources: [],
              bindings: [],
              conflicts: [],
              activity: [],
              outbox: [],
              errors: fixture.errors,
              sync: fixture.sync,
              syncProgress: fixture.progress,
              daemon: { running: fixture.running },
              devices: [],
              deviceId: "device",
              background: true,
            } satisfies Snapshot;
          if (name === "sync_progress")
            return { user: "user", progress: fixture.progress };
          if (name === "sync_queue_state") return fixture.queue;
          if (name === "cancel_sync") {
            fixture.cancelled.push(args?.projectId ?? "");
            fixture.queue = fixture.queue.flatMap((entry) => {
              if (entry.projectId !== args?.projectId) return [entry];
              return entry.state === "running"
                ? [{ ...entry, cancelRequested: true }]
                : [];
            });
            return;
          }
          if (name === "sync_now") {
            fixture.progress = { label: "Waiting for sync to start…" };
            return;
          }
          return {};
        },
      },
    });
  });
  await page.goto("/");
  await expect(page.locator(".workspace-header .sync-status")).toBeVisible();
});

async function setProgress(page: Page, progress: SyncProgress | null) {
  await page.evaluate((value) => {
    window.syncProgressFixture.progress = value;
  }, progress);
}

async function openSync(page: Page) {
  await page.locator(".workspace-header .sync-status").click();
  return page.getByRole("dialog", { name: "Sync status and notifications" });
}

test("Sync now shows queued and local file activity without an estimated bar", async ({
  page,
}) => {
  const dialog = await openSync(page);
  await dialog.getByRole("button", { name: "Sync now", exact: true }).click();
  const footer = dialog.locator(".sync-menu-progress");
  await expect(footer).toContainText("Waiting for sync to start…");
  await expect(dialog.getByRole("progressbar")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Syncing…", exact: true }),
  ).toHaveCount(0);
  await setProgress(page, {
    label: "Checking local files",
    detail: "Orka · .agents/skills/writing/SKILL.md",
    completed: 0,
    total: null,
  });
  await expect(footer).toContainText(".agents/skills/writing/SKILL.md");
  await expect(footer).not.toContainText("%");
  await expect(dialog.getByRole("progressbar")).toHaveCount(0);
  await expect(page.locator(".workspace-header .sync-status")).toContainText(
    "Syncing…",
  );
  expect(await page.evaluate(() => window.syncProgressFixture.calls)).toContain(
    "sync_now",
  );
});

test("known batches show live phase counts and survive closing the modal", async ({
  page,
}) => {
  await setProgress(page, {
    label: "Uploading changes",
    detail: "Orka · AGENTS.md",
    completed: 2,
    total: 8,
  });
  const dialog = await openSync(page);
  const bar = dialog.getByRole("progressbar", { name: "Uploading changes" });
  await expect(bar).toHaveAttribute("aria-valuenow", "2");
  await expect(bar).toHaveAttribute("aria-valuemax", "8");
  await expect(bar).toHaveAttribute("aria-valuetext", "2 of 8 complete (25%)");
  await expect(dialog.locator(".sync-menu-progress-count")).toHaveText(
    "2 of 8",
  );
  await page.keyboard.press("Escape");
  await expect(page.locator(".workspace-header .sync-status")).toBeFocused();
  await setProgress(page, {
    label: "Uploading changes",
    detail: "Orka · CLAUDE.md",
    completed: 5,
    total: 8,
  });
  await openSync(page);
  await expect(bar).toHaveAttribute("aria-valuenow", "5");
  await expect(dialog.locator(".sync-menu-progress")).toContainText(
    "CLAUDE.md",
  );
  await dialog.screenshot({ path: "artifacts/sync-progress.png" });
  await setProgress(page, {
    label: "Downloading updates",
    detail: "Orka · 30 updates received",
    completed: 30,
    total: null,
  });
  await expect(bar).toHaveCount(0);
  await expect(dialog.locator(".sync-menu-progress-count")).toHaveCount(0);
  await expect(dialog.locator(".sync-menu-progress")).toContainText(
    "30 updates received",
  );
});

test("unknown and empty totals never produce a progress bar", async ({
  page,
}) => {
  const dialog = await openSync(page);
  for (const total of [undefined, null, 0]) {
    await setProgress(page, {
      label: "Preparing sync",
      completed: 0,
      total,
    });
    await expect(dialog.locator(".sync-menu-progress")).toBeVisible();
    await expect(dialog.getByRole("progressbar")).toHaveCount(0);
  }
});

test("completion and failure clear active progress and allow another sync", async ({
  page,
}) => {
  const dialog = await openSync(page);
  const sync = dialog.getByRole("button", { name: "Sync now", exact: true });
  await sync.click();
  await expect(dialog.locator(".sync-menu-progress")).toBeVisible();
  await setProgress(page, null);
  await expect(dialog.locator(".sync-menu-progress")).toHaveCount(0);
  await expect(sync).toBeEnabled();
  await expect(page.locator(".workspace-header .sync-status")).toContainText(
    "Up to date",
  );
  await sync.click();
  await expect(dialog.locator(".sync-menu-progress")).toBeVisible();
  await page.evaluate(() => {
    window.syncProgressFixture.progress = null;
    window.syncProgressFixture.sync = {
      online: false,
      lastSync: "2026-11-13T08:00:00Z",
      error: "Cloud unavailable; local work stays queued",
    };
  });
  await expect(dialog.locator(".sync-menu-progress")).toHaveCount(0);
  await expect(dialog).toContainText(
    "Cloud unavailable; local work stays queued",
  );
  await expect(sync).toBeEnabled();
  await expect(page.locator(".workspace-header .sync-status")).toContainText(
    "Offline",
  );
});

test("stopped sync hides stale activity", async ({ page }) => {
  await page.evaluate(() => {
    window.syncProgressFixture.running = false;
    window.syncProgressFixture.progress = {
      label: "Uploading changes",
      completed: 1,
      total: 10,
    };
  });
  await expect(page.locator(".workspace-header .sync-status")).toContainText(
    "Stopped",
  );
  const dialog = await openSync(page);
  await expect(dialog.locator(".sync-menu-progress")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Sync now", exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Set up background sync", exact: true }),
  ).toBeEnabled();
});

async function queueThreeProjects(page: Page) {
  await page.evaluate(() => {
    window.syncProgressFixture.queue = [
      {
        projectId: "one",
        state: "running",
        reason: "sync now",
        attempts: 0,
        notBefore: null,
      },
      {
        projectId: "two",
        state: "queued",
        reason: "local",
        attempts: 0,
        notBefore: null,
      },
      {
        projectId: "three",
        state: "waiting",
        reason: "timer",
        attempts: 2,
        notBefore: new Date(Date.now() + 120_000).toISOString(),
      },
    ];
    window.syncProgressFixture.progress = {
      projectId: "one",
      label: "Uploading changes",
      detail: "Orka · AGENTS.md",
      completed: 2,
      total: 8,
    };
  });
}

test("the project queue has one active block and consistent Cancel actions", async ({
  page,
}) => {
  await queueThreeProjects(page);
  const dialog = await openSync(page);
  await expect(dialog.getByText("All projects", { exact: true })).toBeVisible();
  const row = (name: string) =>
    dialog.locator(".sync-queue-row").filter({ hasText: name });
  await expect(row("Orka")).toHaveCount(1);
  await expect(dialog.locator(".sync-menu-progress")).toContainText("Orka");
  await expect(dialog.locator(".sync-menu-progress")).toContainText(
    "Uploading changes",
  );
  await expect(dialog.locator(".sync-menu-progress")).toContainText(
    "AGENTS.md",
  );
  await expect(row("Docs")).toContainText("Queued");
  await expect(row("Site")).toContainText("Waiting to retry");
  await expect(row("Site")).toContainText(/in 2 min/);
  const exactRetryTime = await page.evaluate(() =>
    new Date(window.syncProgressFixture.queue[2].notBefore!).toLocaleString(),
  );
  expect(
    await row("Site")
      .locator("[title]")
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("title")),
      ),
  ).toEqual(expect.arrayContaining([expect.stringContaining(exactRetryTime)]));
  for (const name of ["Orka", "Docs", "Site"]) {
    await expect(
      row(name).getByRole("button", { name: `Cancel sync for ${name}` }),
    ).toBeEnabled();
  }
  const accessibility = await new AxeBuilder({ page })
    .include(".sync-menu")
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await row("Docs")
    .getByRole("button", { name: "Cancel sync for Docs" })
    .click();
  await expect(row("Docs")).toHaveCount(0);
  await row("Site")
    .getByRole("button", { name: "Cancel sync for Site" })
    .click();
  await expect(row("Site")).toHaveCount(0);
  await expect(row("Orka")).toContainText("Syncing");
  expect(
    await page.evaluate(() => window.syncProgressFixture.cancelled),
  ).toEqual(["two", "three"]);
  await dialog.screenshot({ path: "artifacts/sync-queue.png" });
});

test("running cancellation stays stopping until the worker settles and the next project starts", async ({
  page,
}) => {
  await queueThreeProjects(page);
  const dialog = await openSync(page);
  const active = dialog.locator(".sync-queue-row").filter({ hasText: "Orka" });
  await active.getByRole("button", { name: "Cancel sync for Orka" }).click();
  await expect(active).toContainText("Stopping");
  await expect(active.getByRole("button")).toBeDisabled();
  await expect(page.getByText("Sync cancelled", { exact: true })).toHaveCount(
    0,
  );
  expect(
    await page.evaluate(() => window.syncProgressFixture.cancelled),
  ).toEqual(["one"]);
  await dialog.screenshot({ path: "artifacts/sync-queue-stopping.png" });
  await page.evaluate(() => {
    window.syncProgressFixture.queue = window.syncProgressFixture.queue
      .filter((entry) => entry.projectId !== "one")
      .map((entry) =>
        entry.projectId === "two" ? { ...entry, state: "running" } : entry,
      );
    window.syncProgressFixture.progress = {
      projectId: "two",
      label: "Downloading updates",
      detail: "Docs · README.md",
      completed: 1,
      total: 3,
    };
  });
  await expect(active).toHaveCount(0);
  await expect(dialog.locator(".sync-menu-progress")).toContainText("Docs");
  await expect(dialog.locator(".sync-menu-progress")).toContainText(
    "README.md",
  );
  await expect(
    dialog.getByRole("button", { name: "Cancel sync for Docs" }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(page.locator(".workspace-header .sync-status")).toBeFocused();
});

test("a stale project's progress cannot be shown under a different active project", async ({
  page,
}) => {
  await queueThreeProjects(page);
  await setProgress(page, {
    projectId: "two",
    label: "Downloading updates",
    detail: "Docs-only stale file",
    completed: 4,
    total: 5,
  });
  const dialog = await openSync(page);
  await expect(dialog.locator(".sync-menu-progress")).toContainText("Orka");
  await expect(dialog).not.toContainText("Docs-only stale file");
  await expect(
    dialog.getByRole("progressbar", { name: "Downloading updates" }),
  ).toHaveCount(0);
});

for (const size of [
  { width: 1160, height: 800 },
  { width: 900, height: 640 },
]) {
  test(`active project stays visible above scrolling issues at ${size.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const detail = `Orka · ${"WWWWWWWWWWWW/".repeat(60)}AGENTS.md`;
    await page.evaluate((detail) => {
      window.syncProgressFixture.progress = {
        label: "Applying updates on this Mac",
        detail,
        completed: 3,
        total: 12,
      };
      window.syncProgressFixture.errors = Array.from(
        { length: 24 },
        (_, i) => ({
          source: `one:file-${i}`,
          error: `File ${i} needs review before syncing`,
        }),
      );
    }, detail);
    await queueThreeProjects(page);
    await setProgress(page, {
      projectId: "one",
      label: "Applying updates on this Mac",
      detail,
      completed: 3,
      total: 12,
    });
    const dialog = await openSync(page);
    await expect(
      dialog.getByText("File 0 needs review before syncing", { exact: true }),
    ).toBeVisible();
    const footer = dialog.locator(".sync-menu-progress");
    await expect(footer.locator(".sync-menu-progress-copy p")).toHaveAttribute(
      "title",
      detail,
    );
    const bounds = (await dialog.boundingBox())!;
    const progressBounds = (await footer.boundingBox())!;
    const feedBounds = (await dialog.locator(".sync-menu-feed").boundingBox())!;
    expect(progressBounds.y + progressBounds.height).toBeLessThanOrEqual(
      feedBounds.y + 1,
    );
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(size.height - 11);
    expect(
      await dialog
        .locator(".sync-menu-feed")
        .evaluate((element) => element.scrollHeight > element.clientHeight),
    ).toBe(true);
    const firstIssue = dialog.getByText("File 0 needs review before syncing", {
      exact: true,
    });
    await expect(firstIssue).toBeInViewport({ ratio: 1 });
    expect(
      await dialog.evaluate((element) => {
        const queued = Array.from(
          element.querySelectorAll(".sync-queue-row"),
        ).find((row) => row.textContent?.includes("Docs"))!;
        const issue = Array.from(element.querySelectorAll("p")).find(
          (item) => item.textContent === "File 0 needs review before syncing",
        )!;
        return Boolean(
          queued.compareDocumentPosition(issue) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        );
      }),
    ).toBe(true);
    const lastIssue = dialog.getByText("File 23 needs review before syncing", {
      exact: true,
    });
    await lastIssue.scrollIntoViewIfNeeded();
    await expect(lastIssue).toBeInViewport({ ratio: 1 });
    await expect(dialog.getByRole("progressbar")).toBeInViewport({ ratio: 1 });
    const afterScroll = (await footer.boundingBox())!;
    expect(afterScroll.y).toBeCloseTo(progressBounds.y, 0);
    expect(afterScroll.height).toBeCloseTo(progressBounds.height, 0);
    expect(
      await footer
        .locator(".sync-activity-icon svg")
        .evaluateAll((icons) =>
          icons.every(
            (icon) => getComputedStyle(icon).animationName === "none",
          ),
        ),
    ).toBe(true);
    const accessibility = await new AxeBuilder({ page })
      .include(".sync-menu")
      .analyze();
    expect(accessibility.violations).toEqual([]);
    await page.screenshot({
      path: `artifacts/sync-progress-${size.width}.png`,
    });
  });
}

for (const size of [
  { width: 1160, height: 800 },
  { width: 900, height: 640 },
]) {
  test(`long project names preserve aligned Cancel controls at ${size.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await page.evaluate(() => {
      window.syncProgressFixture.projectNames.one =
        "Orka desktop with a very long project name and connected repositories";
      window.syncProgressFixture.projectNames.two =
        "Documentation and onboarding guidance across every repository";
      window.syncProgressFixture.projectNames.three = "Website";
    });
    await queueThreeProjects(page);
    const dialog = await openSync(page);
    const rows = dialog.locator(".sync-queue-row");
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText(
      "Orka desktop with a very long project name and connected repositories",
    );
    await expect(rows.nth(1)).toContainText(
      "Documentation and onboarding guidance across every repository",
    );
    const buttons = rows.getByRole("button");
    const rects = await buttons.evaluateAll((elements) =>
      elements.map((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          right: bounds.right,
          height: bounds.height,
          width: bounds.width,
        };
      }),
    );
    for (const rect of rects) {
      expect(rect.right).toBeCloseTo(rects[0].right, 0);
      expect(rect.height).toBe(32);
    }
    expect(
      await rows.evaluateAll((elements) =>
        elements.every(
          (element) => element.scrollWidth <= element.clientWidth + 1,
        ),
      ),
    ).toBe(true);
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(11);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(size.width - 11);
    const accessibility = await new AxeBuilder({ page })
      .include(".sync-menu")
      .analyze();
    expect(accessibility.violations).toEqual([]);
    await dialog.screenshot({
      path: `artifacts/sync-queue-long-${size.width}.png`,
    });
  });
}
