import type { Page } from "@playwright/test";
import type { Snapshot } from "../../../apps/mac/src/types.js";

export interface StartupControls {
  pending: boolean;
  error: string;
  release: () => void;
}
export type StartupWindow = Window & { startup: StartupControls };

/** Hold or fail the initial native snapshot before the real App mounts. */
export async function startupFixture(
  page: Page,
  options: { pending?: boolean; error?: string } = {},
) {
  await page.addInitScript((options) => {
    const waiting: (() => void)[] = [];
    const startup: StartupControls = {
      pending: options.pending ?? false,
      error: options.error ?? "",
      release() {
        this.pending = false;
        waiting.splice(0).forEach((resolve) => resolve());
      },
    };
    const state: Snapshot = {
      user: null,
      config: null,
      projects: [],
      resources: [],
      bindings: [],
      conflicts: [],
      activity: [],
      outbox: [],
      errors: [],
      sync: null,
      daemon: null,
      devices: [],
      deviceId: "startup-fixture",
      background: null,
    };
    Object.assign(window, {
      startup,
      isTauri: true,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: async (command: string) => {
          if (command === "snapshot") {
            if (startup.pending)
              await new Promise<void>((resolve) => waiting.push(resolve));
            if (startup.error) throw new Error(startup.error);
            return state;
          }
          if (command === "plugin:deep-link|get_current") return [];
          if (command === "auth_capabilities")
            return { version: 1, auth: { password: true } };
          return null;
        },
      },
    });
  }, options);
  await page.goto("/");
}
