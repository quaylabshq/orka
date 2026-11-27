import { mkdirSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";

const inviteToken = "ab".repeat(24);
const expiredOrUsed =
  "This invite has expired or was already used. Ask the project owner for a new invite.";

type Preview =
  | { status: "available"; projectName: string; expiresAt: string }
  | { status: "unavailable" }
  | { status: "unsupported" };

export async function fixture(page: Page, preview: Preview, signedOut = false) {
  await page.addInitScript(
    ({ preview, signedOut, inviteToken }) => {
      let user: string | null = signedOut ? null : "user";
      let apiUrl = "https://test.orka";
      let inviteOpened = false;
      const previews: string[] = [];
      Object.assign(window, {
        joinPreviewFixture: {
          previews,
          setProjectName: (name: string) => {
            if (preview.status === "available") preview.projectName = name;
          },
          signIn: () => {
            apiUrl = "https://correct.example";
            user = "user";
          },
        },
        isTauri: true,
        __TAURI_INTERNALS__: {
          transformCallback: () => 1,
          unregisterCallback: () => {},
          invoke: async (
            command: string,
            args: { serviceUrl?: string } = {},
          ) => {
            if (command === "snapshot")
              return {
                user,
                config: { apiUrl, syncMinutes: 15 },
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
            if (command === "sync_progress") return { user, progress: null };
            if (command === "auth_capabilities") return { repositories: {} };
            if (command === "profile_events" && signedOut && !inviteOpened) {
              inviteOpened = true;
              return `orka://join/${inviteToken}`;
            }
            if (command === "invite_preview") {
              const service = args.serviceUrl ?? apiUrl;
              previews.push(service);
              return signedOut && service === "https://test.orka"
                ? { status: "unavailable" }
                : preview;
            }
            if (command === "cloud_action") return { id: "project" };
            return {};
          },
        },
      });
    },
    { preview, signedOut, inviteToken },
  );
  await page.goto("/");
  if (signedOut) return;
  await expect(
    page.getByRole("button", { name: "Join project", exact: true }).last(),
  ).toBeVisible();
}

export async function openJoinDialog(page: Page) {
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

for (const width of [1160, 900]) {
  test(`a long project name keeps the close button and dialog anchors at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 900 ? 640 : 800 });
    await fixture(page, {
      status: "available",
      projectName: "Acme",
      expiresAt: "2027-01-02T03:04:05.000Z",
    });
    await openJoinDialog(page);
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator(".ui-modal-header h2")).toHaveText("Join Acme");
    const close = dialog.getByRole("button", { name: "Close join project" });
    const anchors = async () => ({
      close: await close.boundingBox(),
      input: await dialog.getByLabel("Invite link or token").boundingBox(),
      footer: await dialog.locator(".ui-modal-footer").boundingBox(),
    });
    const before = await anchors();
    await page.evaluate(() =>
      (
        window as unknown as {
          joinPreviewFixture: { setProjectName: (name: string) => void };
        }
      ).joinPreviewFixture.setProjectName(
        "Supercalifragilisticexpialidocious".repeat(4).slice(0, 100),
      ),
    );
    await dialog
      .getByLabel("Invite link or token")
      .fill(`orka://join/${"cd".repeat(24)}`);
    const heading = dialog.locator(".ui-modal-header h2");
    await expect(heading).toHaveText(/^Join Super/);
    const after = await anchors();
    const modal = await dialog.boundingBox();
    expect(after.close!.x + after.close!.width).toBeLessThanOrEqual(
      modal!.x + modal!.width,
    );
    for (const key of ["close", "input", "footer"] as const) {
      expect(after[key]!.y).toBeCloseTo(before[key]!.y, 0);
    }
    await expect(heading).toHaveAttribute("title", /^Join Super/);
    expect(
      await heading.evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      ),
    ).toBe(true);
    await close.focus();
    await expect(close).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
  });
}

test("a legacy invite refreshes after signing in to a different configured service", async ({
  page,
}) => {
  await fixture(
    page,
    {
      status: "available",
      projectName: "Correct service",
      expiresAt: "2027-01-02T03:04:05.000Z",
    },
    true,
  );
  const previews = () =>
    page.evaluate(
      () =>
        (window as unknown as { joinPreviewFixture: { previews: string[] } })
          .joinPreviewFixture.previews,
    );
  await expect.poll(previews).toEqual(["https://test.orka"]);
  await page.evaluate(() =>
    (
      window as unknown as { joinPreviewFixture: { signIn: () => void } }
    ).joinPreviewFixture.signIn(),
  );
  const dialog = page.getByRole("dialog", {
    name: "Join Correct service",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Join project", exact: true }),
  ).toBeEnabled();
  expect(await previews()).toEqual([
    "https://test.orka",
    "https://correct.example",
  ]);
});
