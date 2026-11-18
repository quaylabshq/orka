import { mkdirSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";

const inviteToken = "ab".repeat(24);
const expiredOrUsed =
  "This invite has expired or was already used. Ask the project owner for a new invite.";

type Preview =
  | { status: "available"; projectName: string; expiresAt: string }
  | { status: "unavailable" }
  | { status: "unsupported" };

async function fixture(page: Page, preview: Preview) {
  await page.addInitScript(
    ({ preview }) => {
      Object.assign(window, {
        isTauri: true,
        __TAURI_INTERNALS__: {
          transformCallback: () => 1,
          unregisterCallback: () => {},
          invoke: async (command: string) => {
            if (command === "snapshot")
              return {
                user: "user",
                config: { apiUrl: "https://test.orka", syncMinutes: 15 },
                projects: [],
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
            if (command === "invite_preview") return preview;
            if (command === "cloud_action") return { id: "project" };
            return {};
          },
        },
      });
    },
    { preview },
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
}

test("the join dialog names the project and says when the invite expires", async ({
  page,
}) => {
  await fixture(page, {
    status: "available",
    projectName: "Acme",
    expiresAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
  });
  await openJoinDialog(page);
  const dialog = page.getByRole("dialog", { name: "Join Acme" });
  await expect(dialog.getByText("Expires in 2 days.")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Join project", exact: true }),
  ).toBeEnabled();
  mkdirSync("/tmp/orka-briefs", { recursive: true });
  await page.screenshot({ path: "/tmp/orka-briefs/join-name-1.png" });
});

test("an expired or used invite says so and blocks joining", async ({
  page,
}) => {
  await fixture(page, { status: "unavailable" });
  await openJoinDialog(page);
  const dialog = page.getByRole("dialog", { name: "Join project" });
  await expect(dialog.getByRole("alert")).toHaveText(expiredOrUsed);
  await expect(
    dialog.getByRole("button", { name: "Join project", exact: true }),
  ).toBeDisabled();
});
