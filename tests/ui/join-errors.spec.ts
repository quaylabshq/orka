import { test, expect, type Page } from "@playwright/test";

const inviteToken = "ab".repeat(24);
const expired =
  "This invite has expired. Ask the project owner for a new invite.";
const used =
  "This invite was already used or is no longer valid. Ask the project owner for a new invite.";
const expiredOrUsed =
  "This invite has expired or was already used. Ask the project owner for a new invite.";
const archived = "This project is archived, so its invites no longer work.";

type Join = { reject?: string; projectId?: string };

async function fixture(page: Page, join: Join, projects: string[] = []) {
  await page.addInitScript(
    ({ join, projects }) => {
      const known = projects.map((id) => ({
        id,
        name: id === "project" ? "Existing project" : id,
        path: "/test/existing",
        role: "member",
        sharing: {
          memory: false,
          session: false,
          plan: false,
          skill: false,
          env: false,
        },
      }));
      const calls: { command: string; args: Record<string, unknown> }[] = [];
      Object.assign(window, {
        joinCalls: calls,
        isTauri: true,
        __TAURI_INTERNALS__: {
          transformCallback: () => 1,
          unregisterCallback: () => {},
          invoke: async (
            command: string,
            args: Record<string, unknown> = {},
          ) => {
            if (command === "snapshot")
              return {
                user: "user",
                config: { apiUrl: "https://test.orka", syncMinutes: 15 },
                projects: known,
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
            if (command === "auth_capabilities") return { repositories: {} };
            calls.push({ command, args });
            if (command.startsWith("plugin:")) return null;
            if (command === "cloud_action" && args.action === "join") {
              if (join.reject) throw join.reject;
              return { id: join.projectId };
            }
            return {};
          },
        },
      });
    },
    { join, projects },
  );
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Join project", exact: true }).last(),
  ).toBeVisible();
}

async function openJoinDialog(page: Page) {
  await page
    .getByRole("button", { name: "Join project", exact: true })
    .last()
    .click();
  const dialog = page.getByRole("dialog", { name: "Join project" });
  await dialog
    .getByLabel("Invite link or token")
    .fill(`orka://join/${inviteToken}`);
  return dialog;
}

const calls = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          joinCalls: { command: string; args: Record<string, unknown> }[];
        }
      ).joinCalls,
  );

test("a wrong account join says which address the invite was sent to", async ({
  page,
}) => {
  await fixture(page, {
    reject:
      "403: This invite was sent to mira@example.com. Sign in with that verified email address to join.",
  });
  const dialog = await openJoinDialog(page);
  await dialog
    .getByRole("button", { name: "Join project", exact: true })
    .click();
  const alert = dialog.getByRole("alert");
  await expect(alert).toHaveText(
    "This invite was sent to mira@example.com. Sign in with that email address to join.",
  );
  await expect(alert).not.toContainText("403");
});

test("expired, used and archived invites each get one clear line", async ({
  page,
}) => {
  const cases = [
    [
      "400: This invite has expired. Ask the project owner for a new invite.",
      expired,
    ],
    ["400: Invite expired or already used", expiredOrUsed],
    [
      "400: This invite was already used or is no longer valid. Ask the project owner for a new invite.",
      used,
    ],
    ["400: This project is archived, so its invites no longer work.", archived],
  ];
  for (const [reject, expected] of cases) {
    await fixture(page, { reject });
    const dialog = await openJoinDialog(page);
    await dialog
      .getByRole("button", { name: "Join project", exact: true })
      .click();
    const alert = dialog.getByRole("alert");
    await expect(alert).toHaveText(expected);
    await expect(alert).not.toContainText("400");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  }
});

test("an existing member opens the project without joining again", async ({
  page,
}) => {
  await fixture(page, { projectId: "project" }, ["project"]);
  const dialog = await openJoinDialog(page);
  await dialog
    .getByRole("button", { name: "Join project", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("[data-orka-toast]")).toContainText(
    "You’re already in this project",
  );
  // A member join must not offer to connect folders again.
  expect(
    (await calls(page))
      .map((call) => call.command)
      .filter((command) =>
        [
          "cloud_action",
          "connect_project_sources",
          "plugin:dialog|open",
        ].includes(command),
      ),
  ).toEqual(["cloud_action"]);
});
