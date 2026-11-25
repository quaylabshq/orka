import { type Page } from "@playwright/test";
import { resourceLibraryFixture } from "./resource-library.js";

export async function liveFixture(page: Page, owner: boolean) {
  await resourceLibraryFixture(page, { team: true, online: true });
  await page.evaluate((owner) => {
    const w = window as any;
    const original = w.__TAURI_INTERNALS__.invoke;
    const status = {
      available: true,
      eligible: owner,
      active: !owner,
      publishing: false,
      following: false,
      agentFollowing: false,
      episodeId: owner ? undefined : "episode",
    };
    const feed = {
      active: true,
      episodeId: "episode",
      cursor: 1,
      messages: [
        { index: 0, role: "user", text: "Review the migration with me." },
      ],
    };
    w.liveActions = [];
    w.__TAURI_INTERNALS__.invoke = (command: string, args: any) => {
      if (command !== "live_session") return original(command, args);
      const { action, input } = args;
      w.liveActions.push({ action, input });
      if (action === "start")
        Object.assign(status, {
          active: true,
          publishing: true,
          episodeId: "episode",
        });
      if (action === "stop")
        Object.assign(status, {
          active: false,
          publishing: false,
          episodeId: undefined,
        });
      if (action === "follow" || action === "unfollow")
        status.following = action === "follow";
      if (action === "agent_follow" || action === "agent_unfollow")
        status.agentFollowing = action === "agent_follow";
      if (action === "targets")
        return Promise.resolve({
          targets: [
            {
              provider: "codex",
              nativeId: "recipient",
              title: "Release planning",
              following: status.agentFollowing,
            },
          ],
        });
      if (action === "read") return Promise.resolve(structuredClone(feed));
      if (action === "wait")
        return new Promise((resolve) => {
          w.finishLiveWait = (end: boolean) => {
            if (end) {
              feed.active = false;
              status.active = false;
              status.following = false;
            } else
              feed.messages.push({
                index: 1,
                role: "assistant",
                text: "The migration preserves existing sessions.",
              });
            feed.cursor++;
            resolve(structuredClone(feed));
          };
        });
      return Promise.resolve({ ...status });
    };
  }, owner);
  await page.getByRole("button", { name: /^Sessions/ }).click();
  await page
    .getByRole("button", {
      name: owner ? "My shared session" : "Mira's session",
      exact: true,
    })
    .click();
}
