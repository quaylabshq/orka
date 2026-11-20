import { test, expect, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

type Call = { command: string; args: Record<string, unknown> };
type Outcome = "created" | "cancelled" | "expired";
type Fixture = {
  setupCalls: Call[];
  releaseSetup: (outcome: Outcome) => void;
  openInvite: (link: string) => void;
};

// `cloud_action` behaves like a create that reaches a busy workspace: it
// reports that it is waiting and holds until the test releases it.
async function fixture(
  page: Page,
  options: { join?: boolean; failConnection?: boolean } = {},
) {
  await page.addInitScript(({ failConnection }) => {
    const calls: Call[] = [];
    let created = false;
    let release: (outcome: Outcome) => void = () => {};
    let deepLinkCallback: number | undefined;
    const callbacks = new Map<number, (payload: unknown) => void>();
    let connectionAttempts = 0;
    let connectedPaths: string[] = [];
    const project = (id: string, name: string) => ({
      id,
      name,
      role: "owner",
      sources:
        id === "created"
          ? connectedPaths.map((path, index) => ({
              id: `source-${index}`,
              name: path.split("/").at(-1),
              path,
            }))
          : [],
    });
    Object.assign(window, {
      setupCalls: calls,
      releaseSetup: (outcome: Outcome) => release(outcome),
      openInvite: (link: string) => {
        if (deepLinkCallback !== undefined) {
          callbacks.get(deepLinkCallback)?.({ payload: [link] });
        }
      },
      isTauri: true,
      __TAURI_INTERNALS__: {
        transformCallback: (callback: (payload: unknown) => void) => {
          const id = callbacks.size + 1;
          callbacks.set(id, callback);
          return id;
        },
        unregisterCallback: (id: number) => callbacks.delete(id),
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          if (command === "snapshot")
            return {
              user: "user",
              config: { apiUrl: "https://test.orka", syncMinutes: 15 },
              projects: [
                project("project", "Product"),
                ...(created ? [project("created", "Atlas")] : []),
              ],
              resources: [],
              bindings: [],
              conflicts: [],
              activity: [],
              outbox: [],
              errors: [],
              sync: { online: true },
              daemon: { running: true },
              devices: [],
              deviceId: "mac",
              background: true,
            };
          if (command === "sync_progress")
            return { user: "user", progress: null };
          if (
            command === "plugin:event|listen" &&
            args.event === "deep-link://new-url"
          ) {
            deepLinkCallback = Number(args.handler);
            return deepLinkCallback;
          }
          calls.push({ command, args });
          if (command === "invite_preview") return { status: "unsupported" };
          if (command === "connect_project_sources") {
            if (failConnection && connectionAttempts++ === 0)
              throw "Sync or another project operation is still running. Try again after it finishes.";
            connectedPaths = args.paths as string[];
            return {};
          }
          if (command === "plugin:dialog|open")
            return ["/new/desktop", "/new/backend"];
          if (
            command === "cloud_action" &&
            (args.action === "create" || args.action === "join")
          ) {
            const progress = args.onProgress as {
              onmessage: (value: { waiting: boolean }) => void;
            };
            progress.onmessage({ waiting: true });
            return new Promise((resolve, reject) => {
              release = (outcome) => {
                if (outcome === "cancelled")
                  return reject("Cancelled while waiting for sync to finish.");
                progress.onmessage({ waiting: false });
                if (outcome === "expired")
                  return reject(
                    "410: This invite is no longer valid. Ask the project owner for a new invite.",
                  );
                created = true;
                resolve({ id: "created" });
              };
            });
          }
          if (command.startsWith("plugin:")) return null;
          return {};
        },
      },
    });
  }, options);
  await page.goto("/");
  const mode = options.join ? "Join" : "Create";
  await page
    .getByRole("button", {
      name: options.join ? "Join project" : "Add project",
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog");
  if (options.join) {
    await dialog
      .getByRole("textbox", { name: "Invite link or token" })
      .fill(invite);
  } else {
    await dialog.getByRole("textbox", { name: "Project name" }).fill("Atlas");
    await dialog.getByRole("button", { name: "Add folders" }).click();
  }
  const footer = dialog.locator(".create-project-footer");
  const restingFooter = await footer.boundingBox();
  await dialog
    .getByRole("button", { name: `${mode} project`, exact: true })
    .click();
  await expect(progress(dialog)).toContainText("Waiting for sync to finish.");
  return { dialog, footer, restingFooter };
}

const invite = `orka://join/${"ab".repeat(24)}`;
const progress = (dialog: ReturnType<Page["getByRole"]>) =>
  dialog.getByRole("status", { name: "Project setup progress" });

const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as Fixture).setupCalls);
const release = (page: Page, outcome: Outcome) =>
  page.evaluate(
    (outcome) => (window as unknown as Fixture).releaseSetup(outcome),
    outcome,
  );

test("one Create click waits for sync, keeps the choices and opens the project", async ({
  page,
}) => {
  const { dialog } = await fixture(page);
  await expect(
    dialog.getByRole("button", { name: "Waiting for sync…" }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("textbox", { name: "Project name" }),
  ).toHaveValue("Atlas");
  await expect(dialog.getByText("/new/backend")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeEnabled();
  expect(
    (await new AxeBuilder({ page }).include('[role="dialog"]').analyze())
      .violations,
  ).toEqual([]);

  await release(page, "created");
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("combobox", { name: "Select project", exact: true }),
  ).toContainText("Atlas");
  const made = await calls(page);
  expect(made.filter((call) => call.command === "cloud_action")).toHaveLength(
    1,
  );
  expect(
    made.find((call) => call.command === "connect_project_sources")?.args,
  ).toEqual({ id: "created", paths: ["/new/desktop", "/new/backend"] });
});

test("Cancel stops a create that is waiting for sync without an error", async ({
  page,
}) => {
  const { dialog } = await fixture(page);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(progress(dialog)).toHaveText("Cancelling…");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
  expect((await calls(page)).map((call) => call.command)).toContain(
    "cancel_project_setup",
  );

  await release(page, "cancelled");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(
    (await calls(page)).some(
      (call) => call.command === "connect_project_sources",
    ),
  ).toBe(false);
});

test("Escape while waiting cancels instead of hiding a pending create", async ({
  page,
}) => {
  const { dialog } = await fixture(page);
  await page.keyboard.press("Escape");
  await expect(progress(dialog)).toHaveText("Cancelling…");
  await release(page, "cancelled");
  await expect(dialog).toBeHidden();
});

test("at minimum window size, the wait remains visible and sends keyboard focus to Cancel", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 640 });
  const { dialog, footer, restingFooter } = await fixture(page);
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  await expect(cancel).toBeFocused();
  expect(await footer.boundingBox()).toEqual(restingFooter);
  await expect(progress(dialog)).toBeInViewport({ ratio: 1 });
  const axe = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .analyze();
  expect(axe.violations).toEqual([]);
  await page.keyboard.press("Enter");
  await expect(progress(dialog)).toBeInViewport({ ratio: 1 });
  await expect(progress(dialog)).toHaveText("Cancelling…");
  expect(await footer.boundingBox()).toEqual(restingFooter);
  await release(page, "cancelled");
  await expect(
    page.getByRole("button", { name: "Add project", exact: true }),
  ).toBeFocused();
});

test("an incoming invite waits for a cancellable Create to settle", async ({
  page,
}) => {
  const { dialog } = await fixture(page);
  await page.evaluate(
    (link) => (window as unknown as Fixture).openInvite(link),
    invite,
  );
  await expect(dialog).toHaveAccessibleName("Create project");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(progress(dialog)).toHaveText("Cancelling…");
  await release(page, "cancelled");
  await expect(dialog).toHaveAccessibleName("Join project");
  await expect(
    dialog.getByRole("textbox", { name: "Invite link or token" }),
  ).toHaveValue(invite);
  expect(
    (await calls(page)).filter(({ command }) => command === "cloud_action"),
  ).toHaveLength(1);
});

test("a late Cancel shows the service error after Join leaves the wait", async ({
  page,
}) => {
  const { dialog } = await fixture(page, { join: true });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(progress(dialog)).toHaveText("Cancelling…");
  await release(page, "expired");
  await expect(dialog.getByRole("alert")).toContainText(
    "Ask the project owner for a new invite",
  );
  await expect(
    dialog.getByRole("textbox", { name: "Invite link or token" }),
  ).toHaveValue(invite);
});

test("folder failure preserves both selections and retries only attachment", async ({
  page,
}) => {
  const { dialog } = await fixture(page, { failConnection: true });
  await release(page, "created");
  await expect(dialog).toHaveAccessibleName("Connect project folders");
  await expect(dialog.getByRole("alert")).toContainText(
    "Project created. Couldn’t connect the selected folders.",
  );
  await expect(dialog.getByRole("checkbox", { name: /desktop/ })).toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: /backend/ })).toBeChecked();
  const retry = dialog.getByRole("button", { name: "Retry connection" });
  await expect(retry).toBeFocused();
  await retry.click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("combobox", { name: "Select project", exact: true }),
  ).toContainText("Atlas");
  expect(
    (await calls(page)).filter(({ command }) => command === "cloud_action"),
  ).toHaveLength(1);
  expect(
    (await calls(page))
      .filter(({ command }) => command === "connect_project_sources")
      .map(({ args }) => args),
  ).toEqual([
    { id: "created", paths: ["/new/desktop", "/new/backend"] },
    { id: "created", paths: ["/new/desktop", "/new/backend"] },
  ]);
});
