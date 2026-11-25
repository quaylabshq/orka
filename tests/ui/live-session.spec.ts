import { expect, test } from "@playwright/test";
import { liveFixture } from "./fixtures/live-session.js";

test("future turns require explicit confirmation and publishing can be stopped", async ({
  page,
}) => {
  await liveFixture(page, true);
  await page.getByRole("button", { name: "Share live…" }).click();
  await expect(page.getByText(/future completed turns/)).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(
    await page.evaluate(() =>
      (window as any).liveActions.some((op: any) => op.action === "start"),
    ),
  ).toBe(false);
  await page.getByRole("button", { name: "Share live…" }).click();
  await page.getByRole("button", { name: "Start live sharing" }).click();
  await page.getByRole("button", { name: "Stop sharing live" }).click();
  await expect(page.getByRole("button", { name: "Share live…" })).toBeVisible();
});

test("watching delivers attributed completed turns and clears them on stop", async ({
  page,
}) => {
  await liveFixture(page, false);
  await page.getByRole("button", { name: "Watch live" }).click();
  const feed = page.getByLabel("Live conversation", { exact: true });
  await expect(feed.getByRole("article", { name: "Mira" })).toContainText(
    "Review the migration with me.",
  );
  await page.evaluate(() => (window as any).finishLiveWait(false));
  await expect(feed.getByRole("article", { name: /Claude/ })).toContainText(
    "The migration preserves existing sessions.",
  );
  await page.evaluate(() => (window as any).finishLiveWait(true));
  await expect(feed).toHaveCount(0);
  await expect(page.getByLabel("Conversation", { exact: true })).toBeVisible();
});

test("an agent follow targets an explicitly chosen local conversation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 850, height: 720 });
  await liveFixture(page, false);
  await page.getByRole("button", { name: "Follow in an agent…" }).click();
  await expect(page.getByText("Release planning · Codex")).toBeVisible();
  await page.getByRole("button", { name: "Follow", exact: true }).click();
  await expect(page.getByRole("button", { name: "Watch live" })).toBeVisible();
  const follow = await page.evaluate(() =>
    (window as any).liveActions.find((op: any) => op.action === "agent_follow"),
  );
  expect(follow.input).toMatchObject({
    episodeId: "episode",
    projectId: "project",
    id: "session-teammate",
    userId: "user",
    provider: "codex",
    nativeId: "recipient",
  });
  await page.getByRole("button", { name: "Unfollow", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Follow", exact: true }),
  ).toBeVisible();
});
