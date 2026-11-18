import { test, expect } from "@playwright/test";
import { settingsFixture } from "./fixtures/settings.js";

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
