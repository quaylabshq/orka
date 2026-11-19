import type { Page } from "@playwright/test";
import type { Snapshot } from "../../../apps/mac/src/types.js";

declare global {
  interface Window {
    memberViewFixture: {
      state: Snapshot;
      calls: { name: string; args?: Record<string, unknown> }[];
      controls: { removeError: string; holdRemoval: boolean };
      releaseRemoval?: () => void;
    };
  }
}

/** One active project beside every inactive state the sidebar explains. */
export async function memberViewFixture(
  page: Page,
  options: { removeError?: string; holdRemoval?: boolean } = {},
) {
  await page.addInitScript((options) => {
    const inactive = [
      {
        id: "archived",
        name: "Archived notes",
        role: "member" as const,
        archivedAt: "2026-01-01T00:00:00Z",
        lifecycleRevision: 6,
      },
      {
        id: "deleted",
        name: "Deleted notes",
        role: "member" as const,
        deletedAt: "2026-01-01T00:00:00Z",
        purgeAfter: "2026-01-31T00:00:00Z",
        lifecycleRevision: 7,
      },
      {
        id: "purged",
        name: "Purged notes",
        role: "owner" as const,
        deletedAt: "2026-01-01T00:00:00Z",
        purged: true,
        lifecycleRevision: 8,
      },
      {
        id: "removed",
        name: "Removed notes",
        role: "member" as const,
        revoked: true,
        detachedAt: "2026-01-02T00:00:00Z",
        lifecycleRevision: 9,
      },
    ];
    const state: Snapshot = {
      user: "user",
      config: { apiUrl: "https://fixture.invalid", syncMinutes: 15 },
      projects: [
        {
          id: "one",
          name: "Product",
          path: "/synthetic/product",
          role: "owner",
          sources: [],
          lifecycleRevision: 1,
        },
      ],
      inactive,
      resources: [],
      bindings: [],
      drafts: [],
      conflicts: [],
      activity: [],
      outbox: [],
      errors: [],
      reviewRequests: [],
      sync: { online: true, lastSync: "2026-11-13T12:00:00Z" },
      daemon: { running: true },
      devices: [],
      deviceId: "device",
      background: true,
    };
    const fixture: Window["memberViewFixture"] = {
      state,
      calls: [],
      controls: {
        removeError: options.removeError ?? "",
        holdRemoval: options.holdRemoval ?? false,
      },
    };
    Object.assign(window, {
      memberViewFixture: fixture,
      isTauri: true,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: async (name: string, args?: Record<string, unknown>) => {
          if (name === "snapshot") return structuredClone(fixture.state);
          if (name === "sync_progress") return { user: "user", progress: null };
          fixture.calls.push({ name, args });
          if (name === "plugin:dialog|save") return "/tmp/orka-export.zip";
          if (name.startsWith("plugin:")) return null;
          if (name === "export_project") return null;
          if (name === "project_command" && args?.action === "remove") {
            if (fixture.controls.holdRemoval)
              await new Promise<void>((resolve) => {
                fixture.releaseRemoval = () => {
                  fixture.controls.holdRemoval = false;
                  fixture.releaseRemoval = undefined;
                  resolve();
                };
              });
            if (fixture.controls.removeError)
              throw new Error(fixture.controls.removeError);
            const input = args.input as { projectId?: string } | undefined;
            fixture.state.inactive = fixture.state.inactive?.filter(
              (project) => project.id !== input?.projectId,
            );
            return { ok: true };
          }
          return {};
        },
      },
    });
  }, options);
  await page.goto("/");
}

export const memberViewCalls = (page: Page) =>
  page.evaluate(() => window.memberViewFixture.calls);
