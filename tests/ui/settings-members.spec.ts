import { test, expect, type Page } from "@playwright/test";
import { settingsCalls, settingsFixture } from "./fixtures/settings.js";

for (const [role, width, height] of [
  ["owner", 1160, 768],
  ["member", 900, 640],
] as const)
  test(`Members puts the current ${role} first and uses their account email at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height });
    const settings = await settingsFixture(page, { role });
    const otherEmail = `${"alex.".repeat(12)}chen@example.com`;
    await page.evaluate(
      ({ role, otherEmail }) => {
        (window as any).settingsCatalog.members = [
          {
            id: "other-a",
            name: "Alex Chen",
            role: "admin",
            email: otherEmail,
          },
          { id: "other-b", name: "Jamie Rivera", role: "member" },
          { id: role, name: "Morgan Taylor", role },
        ];
      },
      { role, otherEmail },
    );
    await settings
      .getByRole("button", { name: "Members", exact: true })
      .click();
    const rows = settings.getByRole("listitem");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0).getByText("You", { exact: true })).toBeVisible();
    await expect(
      rows.nth(0).getByText("morgan@example.com", { exact: true }),
    ).toBeVisible();
    await expect(
      rows.nth(1).getByText(otherEmail, { exact: true }),
    ).toHaveAttribute("title", otherEmail);
    await expect(
      rows.nth(2).getByText("Jamie Rivera", { exact: true }),
    ).toBeVisible();
    await expect(rows.nth(2).locator("p")).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        (window as any).settingsCatalog.members.map((member: any) => member.id),
      ),
    ).toEqual(["other-a", "other-b", role]);
    expect(
      await rows.nth(1).evaluate((row) => row.scrollWidth <= row.clientWidth),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath(`members-${width}.png`) });
  });

test("Members keeps supplied emails and does not invent an unavailable account email", async ({
  page,
}) => {
  const settings = await settingsFixture(page, { noProfile: true });
  await page.evaluate(() => {
    (window as any).settingsCatalog.members = [
      {
        id: "member",
        name: "Jamie Rivera",
        role: "member",
        email: "jamie@example.com",
      },
      { id: "owner", name: "Morgan Taylor", role: "owner" },
    ];
  });
  await settings.getByRole("button", { name: "Members", exact: true }).click();
  const rows = settings.getByRole("listitem");
  await expect(rows.nth(0).getByText("You", { exact: true })).toBeVisible();
  await expect(rows.nth(0).locator("p")).toHaveCount(0);
  await expect(
    rows.nth(1).getByText("jamie@example.com", { exact: true }),
  ).toBeVisible();
});

test("a confirmed missing email does not revive the cached account email", async ({
  page,
}) => {
  const settings = await settingsFixture(page);
  await settings.getByRole("button", { name: "Members", exact: true }).click();
  const self = settings
    .getByRole("listitem")
    .filter({ has: page.getByText("You", { exact: true }) });
  await expect(
    self.getByText("morgan@example.com", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    const w = window as any;
    w.settingsCatalog.members.find(
      (member: any) => member.id === "owner",
    ).email = null;
    w.settingsState.projects[0].policyRevision++;
  });
  await expect(self.locator("p")).toHaveCount(0);
  await expect(self.getByText("Morgan Taylor", { exact: true })).toBeVisible();
});

test("removal and ownership transfer identify the selected member in full", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 640 });
  const settings = await settingsFixture(page);
  const name = "Jamie Rivera from the application engineering team";
  const email = "application.engineering.team.jamie.rivera@example.com";
  await page.evaluate(
    ({ name, email }) => {
      const member = (window as any).settingsCatalog.members.find(
        (m: any) => m.id === "member",
      );
      Object.assign(member, { name, email });
    },
    { name, email },
  );
  await settings.getByRole("button", { name: "Members", exact: true }).click();
  for (const [action, title] of [
    ["Remove Member", "Remove member?"],
    ["Transfer ownership", "Transfer ownership?"],
  ]) {
    await settings.getByRole("button", { name: `Actions for ${name}` }).click();
    await page.getByRole("menuitem", { name: action, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: title, exact: true });
    const target = dialog.getByRole("heading", { name, exact: true });
    await expect(target).toBeVisible();
    const address = dialog.getByText(email, { exact: true });
    await expect(address).toBeVisible();
    for (const text of [target, address])
      expect(
        await text.evaluate(
          (el) =>
            el.scrollWidth <= el.clientWidth &&
            el.scrollHeight <= el.clientHeight,
        ),
      ).toBe(true);
    await dialog.getByRole("button", { name: "Stay" }).click();
  }
});

test("Members uses invite wording for the invite action and pending invites", async ({
  page,
}) => {
  const settings = await settingsFixture(page, {
    pendingInvites: [
      { email: "teammate@example.com", expiresAt: "2026-11-14T12:00:00Z" },
    ],
  });
  await settings.getByRole("button", { name: "Members", exact: true }).click();
  const pending = settings.getByRole("region", {
    name: "Pending invites",
    exact: true,
  });
  await expect(
    pending.getByRole("heading", { name: "Pending invites (1)", exact: true }),
  ).toBeVisible();
  await expect(settings.getByText("Pending invitations")).toHaveCount(0);
  await expect(
    settings.getByRole("button", { name: "Add Member", exact: true }),
  ).toHaveCount(0);
  await settings
    .getByRole("button", { name: "Invite member", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Invite member",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Copy invite link", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Copy joining link", exact: true }),
  ).toHaveCount(0);
});

const email = "teammate@example.com";
const invites = [{ email, expiresAt: "2026-11-14T12:00:00Z" }];
const pendingRow = (settings: Awaited<ReturnType<typeof settingsFixture>>) =>
  settings
    .getByRole("region", { name: "Pending invites", exact: true })
    .getByRole("listitem")
    .filter({ hasText: email });
const inviteAction = async (page: Page, action: "Resend" | "Revoke") => {
  await page
    .getByRole("button", { name: `Actions for invite to ${email}` })
    .click();
  await page.getByRole("menuitem", { name: action, exact: true }).click();
};
const inviteActions = async (page: Page) => {
  await page
    .getByRole("button", { name: `Actions for invite to ${email}` })
    .click();
  const items = await page.getByRole("menuitem").allInnerTexts();
  await page.keyboard.press("Escape");
  return items;
};

test("Resend sends the invite again to the same address", async ({ page }) => {
  const settings = await settingsFixture(page, {
    emailInvites: true,
    pendingInvites: invites,
  });
  await settings.getByRole("button", { name: "Members", exact: true }).click();
  await inviteAction(page, "Resend");
  await expect(settings.getByRole("status")).toHaveText(
    `Invite sent again to ${email}.`,
  );
  const sends = (await settingsCalls(page)).filter(
    (call) => call.command === "cloud_action" && call.args.action === "invite",
  );
  expect(sends.map((call) => call.args.input.email)).toEqual([email]);
  await expect(pendingRow(settings).getByText("Pending")).toBeVisible();
});

test("Resend shows the service's rate limit message", async ({ page }) => {
  const message =
    "An invite was just sent to this address. Wait a minute before sending it again.";
  const settings = await settingsFixture(page, {
    pendingInvites: invites,
    emailInviteError: `429: ${message}`,
  });
  await settings.getByRole("button", { name: "Members", exact: true }).click();
  await inviteAction(page, "Resend");
  await expect(settings.getByRole("alert")).toHaveText(message);
  await expect(pendingRow(settings).getByText("Pending")).toBeVisible();
});

test("an unconfirmed delivery keeps Resend without claiming the email was not delivered", async ({
  page,
}) => {
  const settings = await settingsFixture(page, {
    pendingInvites: invites,
    emailInviteError:
      "503: Invitation email delivery could not be confirmed. Try again in a minute or use a joining link.",
  });
  await settings.getByRole("button", { name: "Members", exact: true }).click();
  await inviteAction(page, "Resend");
  await expect(settings.getByRole("alert")).toHaveText(
    "Invitation email delivery could not be confirmed. Try again in a minute or use a joining link.",
  );
  await expect(
    pendingRow(settings).getByText("Delivery unconfirmed", { exact: true }),
  ).toBeVisible();
  await expect(
    pendingRow(settings).getByText("Not delivered", { exact: true }),
  ).toHaveCount(0);
  expect(await inviteActions(page)).toEqual(["Resend", "Revoke"]);
});

test("Revoke asks first, then removes the invite", async ({ page }) => {
  const settings = await settingsFixture(page, { pendingInvites: invites });
  await settings.getByRole("button", { name: "Members", exact: true }).click();
  await inviteAction(page, "Revoke");
  const dialog = page.getByRole("dialog", { name: "Revoke invite?" });
  await dialog.getByRole("button", { name: "Stay" }).click();
  await expect(pendingRow(settings)).toBeVisible();
  await inviteAction(page, "Revoke");
  await dialog.getByRole("button", { name: "Revoke invite" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(settings.getByRole("status")).toHaveText(
    `Invite to ${email} revoked.`,
  );
  await expect(
    settings.getByRole("region", { name: "Pending invites" }),
  ).toHaveCount(0);
});

test("an older service hides Revoke and asks for an update", async ({
  page,
}) => {
  const settings = await settingsFixture(page, {
    pendingInvites: invites,
    revokeMissing: true,
  });
  await settings.getByRole("button", { name: "Members", exact: true }).click();
  await inviteAction(page, "Revoke");
  await page
    .getByRole("dialog", { name: "Revoke invite?" })
    .getByRole("button", { name: "Revoke invite" })
    .click();
  await expect(settings.getByRole("alert")).toContainText(
    "Revoking invites needs an updated Orka service.",
  );
  await expect(pendingRow(settings)).toBeVisible();
  expect(await inviteActions(page)).toEqual(["Resend"]);
});

test("a policy change during the initial Members read obtains the latest catalog", async ({
  page,
}) => {
  await page.clock.install();
  const settings = await settingsFixture(page);
  await page.evaluate(() => {
    const w = window as any;
    const original = w.__TAURI_INTERNALS__.invoke;
    w.memberCatalogReads = 0;
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command === "governance_command" && args.action === "catalog") {
        w.memberCatalogReads++;
        if (w.memberCatalogReads === 1) {
          const previous = structuredClone(w.settingsCatalog);
          await new Promise<void>((resolve) => {
            w.finishPreviousCatalog = resolve;
          });
          return previous;
        }
      }
      return original(command, args);
    };
  });
  await settings.getByRole("button", { name: "Members", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).memberCatalogReads))
    .toBe(1);
  await page.evaluate(() => {
    const w = window as any;
    w.settingsState.projects[0].policyRevision++;
    w.settingsCatalog.policyRevision++;
    w.settingsCatalog.members = [
      { id: "owner", name: "Current owner", role: "owner" },
      { id: "new-member", name: "New teammate", role: "member" },
    ];
  });
  await page.clock.runFor(3100);
  await expect(settings).toContainText("New teammate");
  await page.evaluate(() => (window as any).finishPreviousCatalog());
  await expect(settings).toContainText("New teammate");
  await expect
    .poll(() => page.evaluate(() => (window as any).memberCatalogReads))
    .toBe(2);
});
