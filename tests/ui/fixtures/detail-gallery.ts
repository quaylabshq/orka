import { mkdirSync, writeFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";

/** Where the states page reads its screenshots and captions from. */
export const galleryRoot = ".scratch/detail-layout/screenshots";

export type GalleryKind = "memories" | "plans" | "sessions" | "skills";

export const wide = { width: 1440, height: 900 };
export const compact = { width: 900, height: 640 };
export const extraWide = { width: 1920, height: 1000 };

/**
 * Captures one state. The name is `NN-kebab-title`; the caption beside it is
 * what the states page shows under the screenshot.
 */
export async function capture(
  page: Page,
  kind: GalleryKind,
  name: string,
  caption = "",
) {
  const directory = `${galleryRoot}/${kind}`;
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/${name}.png` });
  writeFileSync(`${directory}/${name}.json`, JSON.stringify({ caption }));
}

export type DetailGalleryOptions = {
  kind: "memory" | "plan" | "session";
  /** Only on this Mac, never shared. */
  local?: boolean;
  /** Shared, with newer edits on this Mac. */
  localChanges?: boolean;
  files?: string[];
  content?: string;
  previous?: "cached" | "equal" | "missing";
  /** hold waits for window.finishInspect(); missing reports file not found. */
  inspect?: "ok" | "hold" | "error" | "missing";
  offline?: boolean;
  disconnected?: boolean;
  repository?: string;
  /** Session only. */
  owner?: "me" | "teammate";
  fork?: boolean;
  conflict?: boolean;
  /** hold waits for window.finishMessages(). */
  /** paged serves 40 of 80 and holds the next page for finishMessages(). */
  messages?: "ok" | "hold" | "error" | "empty" | "long" | "paged";
  resumeError?: boolean;
  /** slow waits for window.finishLaunchOptions(). */
  launch?: "slow" | "error" | "none";
  /** A long title that wraps. */
  longTitle?: boolean;
  /** Opening the editor fails. */
  editorFailure?: boolean;
  /** A governed project where this member can only view. */
  viewOnly?: boolean;
};

const memory = [
  "# Design decisions",
  "",
  "The detail pages share one layout so a reader always finds the same things in the same place.",
  "",
  "## What we agreed",
  "",
  "- The title sits in a card at the top of the reading column.",
  "- Facts and actions live in the info panel on the right.",
  "- The panel folds away when the window is narrow.",
  "",
  "## Open questions",
  "",
  "- [x] Cap the reading column at 870px",
  "- [ ] Decide whether sessions need a message count",
  "",
  "```ts",
  "const COMPACT_WIDTH = 840;",
  "```",
  "",
].join("\n");
const plan = [
  "# Release plan",
  "",
  "Ship the shared detail layout behind the existing readers.",
  "",
  "## Steps",
  "",
  "- [x] Move memories and plans onto the shell",
  "- [x] Move sessions onto the shell",
  "- [ ] Rename the shared class names",
  "- [ ] Review every state",
  "",
  "## Verification",
  "",
  "Run the UI suite and compare each state against the review page.",
  "",
].join("\n");

export const titles = {
  memory: "Design decisions",
  plan: "Release plan",
  session: "Unify the detail layout",
} as const;
const collections = {
  memory: "Memories",
  plan: "Plans",
  session: "Sessions",
} as const;

const displayTitle = (options: DetailGalleryOptions) =>
  options.longTitle
    ? `${titles[options.kind]} across memories, plans, sessions, and skills so every reader finds the same things in the same place`
    : titles[options.kind];

/** One project holding a single memory, plan, or session in the chosen state. */
export async function detailGalleryFixture(
  page: Page,
  options: DetailGalleryOptions,
) {
  await page.addInitScript(
    ({ options, content, title }) => {
      const user = "user";
      const mode = { mode: "read", create: "read", governed: true };
      const access = {
        instructions: mode,
        memory: mode,
        plan: mode,
        session: mode,
        skill: mode,
        env: mode,
      };
      const teammate = "mira";
      const session = options.kind === "session";
      const paths = options.files ?? [session ? "session.jsonl" : "content.md"];
      const resource = {
        resourceId: `${options.kind}-a`,
        projectId: "one",
        kind: options.kind,
        title,
        source: session ? "claude" : "codex",
        logicalPath: `codex/${options.kind}-a`,
        sourceId: options.repository ? "repository" : undefined,
        files: paths.map((path) => ({ path, hash: `hash-${path}`, size: 10 })),
        deleted: false,
        hash: "hash",
        revision: options.local ? 0 : 3,
        owner: options.owner === "teammate" ? teammate : user,
        updatedBy: options.owner === "teammate" ? teammate : user,
        updatedAt: "2026-11-12T10:00:00Z",
        local: options.local || undefined,
        localChanges: options.localChanges || undefined,
        fork: options.fork
          ? {
              parentId: "session-parent",
              nativeId: "native-fork",
              destination: "desktop",
              createdAt: "2026-11-02T00:00:00Z",
            }
          : undefined,
      };
      const turns = (count: number) =>
        Array.from({ length: count }, (_, index) => ({
          index,
          role: index % 2 ? "assistant" : "user",
          text:
            index % 2
              ? "I moved the reader onto the shared shell and kept the conversation paging as it was.\n\n- Title card at the top\n- Info panel on the right\n- Launcher as the primary action"
              : index === 0
                ? "Move the session page onto the same layout as skills and memories."
                : "Keep going, and check the narrow window too.",
        }));
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async () => {} },
      });
      Object.assign(window, {
        isTauri: true,
        __TAURI_INTERNALS__: {
          transformCallback: () => 1,
          unregisterCallback: () => {},
          invoke: async (name: string, args: Record<string, unknown> = {}) => {
            if (name === "snapshot")
              return {
                user,
                governance: options.viewOnly
                  ? [{ projectId: "one", catalog: { access, members: [] } }]
                  : [],
                config: { apiUrl: "https://test.local", syncMinutes: 15 },
                projects: [
                  {
                    id: "one",
                    name: "Orka",
                    path: options.disconnected ? null : "/test/orka",
                    role: options.viewOnly ? "member" : "owner",
                    governed: options.viewOnly || undefined,
                    sources: options.repository
                      ? [
                          {
                            id: "repository",
                            name: options.repository,
                            path: "/test/orka",
                          },
                        ]
                      : undefined,
                  },
                ],
                resources: options.local ? [] : [resource],
                bindings: [],
                conflicts: options.conflict
                  ? [
                      {
                        id: "conflict-1",
                        resourceId: resource.resourceId,
                        author: teammate,
                        deviceId: "other-device",
                        candidate: resource,
                        revision: 3,
                      },
                    ]
                  : [],
                activity: [],
                outbox: [],
                errors: [],
                sync: options.offline
                  ? { online: false, error: "Service unavailable" }
                  : { online: true },
                daemon: { running: true },
                devices: [],
                deviceId: "device",
                background: true,
              };
            if (name === "local_resource_catalog")
              return {
                resources:
                  args.kind === options.kind &&
                  (options.local || options.localChanges)
                    ? [resource]
                    : [],
                errors: [],
              };
            if (name === "session_display_title") return title;
            if (name === "governance_command" && args.action === "catalog")
              return options.viewOnly
                ? { access, members: [], requests: [] }
                : {};
            if (name === "open_editor" && options.editorFailure)
              throw new Error("File unavailable");
            if (name === "session_launch_options") {
              if (options.launch === "error")
                throw new Error("App discovery unavailable");
              if (options.launch === "slow")
                await new Promise<void>((resolve) => {
                  (window as any).finishLaunchOptions = resolve;
                });
              if (options.launch === "none") return [];
              const tools = ["claude", "codex"];
              const result = tools.flatMap((tool) =>
                ["desktop", "terminal"].map((destination) => ({
                  tool,
                  destination,
                  label:
                    destination === "terminal"
                      ? "Terminal"
                      : tool === "claude"
                        ? "Claude Desktop"
                        : "Codex",
                  icon: null,
                  available: !options.disconnected,
                  reason: options.disconnected
                    ? "Connect this session's repository on this Mac"
                    : null,
                  isDefault: false,
                  mode:
                    tool === "claude"
                      ? options.fork
                        ? "resume"
                        : "fork"
                      : "handoff",
                  forkAvailable: !options.disconnected,
                })),
              );
              if (!options.disconnected) result[0].isDefault = true;
              return result;
            }
            if (name === "resume_session") {
              if (options.resumeError) throw "Could not launch destination";
              return { opened: true, instruction: "Opened native session." };
            }
            if (name === "session_messages" && options.messages === "paged") {
              const offset = Number(args.offset ?? 0);
              if (offset > 0)
                await new Promise<void>((resolve) => {
                  (window as any).finishMessages = resolve;
                });
              return {
                messages: turns(80).slice(offset, offset + 40),
                total: 80,
                offset,
              };
            }
            if (name === "session_messages") {
              if (options.messages === "hold")
                await new Promise<void>((resolve) => {
                  (window as any).finishMessages = resolve;
                });
              if (options.messages === "error")
                throw new Error("Couldn’t read this session’s messages.");
              const all = turns(
                options.messages === "empty"
                  ? 0
                  : options.messages === "long"
                    ? 24
                    : 4,
              );
              return { messages: all, total: all.length, offset: 0 };
            }
            if (name === "inspect_resource") {
              if (options.inspect === "hold")
                await new Promise<void>((resolve) => {
                  (window as any).finishInspect = resolve;
                });
              if (options.inspect === "error") throw new Error("Read failed");
              if (options.inspect === "missing")
                throw new Error("File not found");
              const file = String(args.file);
              const text = session
                ? '{"type":"user","text":"Move the session page onto the same layout."}\n{"type":"assistant","text":"I moved the reader onto the shared shell."}\n'
                : file.endsWith(".md")
                  ? (options.content ?? content)
                  : '#!/bin/sh\nset -eu\necho "checking detail states"\n';
              return {
                content: text,
                previous:
                  options.previous === "missing"
                    ? null
                    : options.previous === "equal"
                      ? text
                      : text
                          .replace("870px", "960px")
                          .replace(
                            "- [x] Move sessions",
                            "- [ ] Move sessions",
                          ),
                paths: [],
              };
            }
            if (name.startsWith("plugin:")) return null;
            return {};
          },
        },
      });
    },
    {
      options,
      content: options.kind === "plan" ? plan : memory,
      title: displayTitle(options),
    },
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: new RegExp(`^${collections[options.kind]}`) })
    .click();
  await page
    .getByRole("button", { name: displayTitle(options), exact: true })
    .click();
  const label =
    options.kind === "memory"
      ? "Memory"
      : options.kind === "plan"
        ? "Plan"
        : "Session";
  const view = page.getByRole("region", { name: `${label} details` });
  await expect(view).toBeVisible();
  return view;
}
