import { BookOpenIcon, CopyIcon, TrashIcon } from "lucide-react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectResource } from "../types.js";
import {
  ITEM_MENU_CAP,
  ItemContextMenu,
  ItemMenuButton,
  type ItemMenuAction,
} from "./item-menu.js";
import { MarkdownMarkIcon } from "./icons.js";
import { ResourceItemMenu, ResourceMenuProvider } from "./resource-menu.js";
import { MemberRows } from "./settings/settings-members.js";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
  Channel: class {},
}));

const action = (label: string, extra: Partial<ItemMenuAction> = {}) => ({
  id: label,
  label,
  icon: BookOpenIcon,
  onSelect: vi.fn(),
  ...extra,
});

beforeEach(() => {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "auth_capabilities") {
      return {
        artifactLibrary: 1,
        browserHandoffs: 1,
        auth: { browserOrigin: "https://dashboard.example" },
      };
    }
    return {};
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.mocked(invoke).mockReset();
});

/** Renders a menu, opens it from the element named `target`, and returns it. */
async function open(element: React.ReactElement, target = "Item") {
  render(element);
  // Let any mounted capability probe settle before opening the menu.
  await act(async () => {});
  const trigger =
    screen.queryByText(target) ?? screen.getByRole("button", { name: target });
  if (trigger.matches("[aria-haspopup=menu]"))
    fireEvent.keyDown(trigger, { key: "Enter" });
  else fireEvent.contextMenu(trigger);
  await act(() => new Promise((done) => setTimeout(done)));
  const menu = screen.getByRole("menu");
  // Each entry's icon slot and label, with "|" for a separator.
  const entries = Array.from(menu.children, (child) =>
    child.getAttribute("role") === "separator"
      ? "|"
      : `${child.querySelector(":scope > .item-menu-icon")?.localName ?? "-"} ${child.textContent}`,
  );
  return { menu, entries };
}

const menus = {
  "right-click menu": (actions: ItemMenuAction[]) => (
    <ItemContextMenu actions={actions} label="Item actions">
      <button type="button">Item</button>
    </ItemContextMenu>
  ),
  '"..." menu': (actions: ItemMenuAction[]) => (
    <ItemMenuButton actions={actions} label="Item" />
  ),
};

test.each(Object.entries(menus))(
  "the %s shows icons and separates groups",
  async (_, menu) => {
    const { entries } = await open(
      menu([
        action("Open", { group: "open" }),
        action("Copy link", { group: "copy", icon: CopyIcon }),
        // An action without a group stays with the group before it.
        action("Show Markdown", { icon: MarkdownMarkIcon }),
        action("Delete", { group: "remove", icon: TrashIcon }),
      ]),
    );
    expect(entries.join(", ")).toBe(
      "svg Open, |, svg Copy link, svg Show Markdown, |, svg Delete",
    );
  },
);

test("an explicit separator works without groups", async () => {
  const { entries } = await open(
    menus["right-click menu"]([
      action("One"),
      action("Two", { separator: true }),
    ]),
  );
  expect(entries).toEqual(["svg One", "|", "svg Two"]);
});

const fn = vi.fn();

const resource = {
  resourceId: "skill-a",
  projectId: "project",
  sourceId: "source",
  kind: "skill",
  revision: 3,
} as unknown as ProjectResource;

// A shared, connected skill in a governed project, owned by this user, with
// both reviews pending, opened from the reading view.
const state = {
  user: "me",
  projects: [
    {
      id: "project",
      name: "Project",
      role: "owner",
      governed: true,
      sources: [{ id: "source", name: "app", path: "/repo/app" }],
    },
  ],
  outbox: [],
  bindings: [
    {
      resourceId: "skill-a",
      installationState: "locally_modified",
      availableRevision: 4,
      base: { revision: 3 },
    },
  ],
} as never;

const resourceMenu = (
  <ResourceMenuProvider
    resources={[resource]}
    scope="test"
    state={state}
    busy={false}
    act={fn}
    onOpen={fn}
    onReview={fn}
    onOpenRequests={fn}
    onNotice={fn}
    onError={fn}
    onRefresh={fn}
  >
    <ResourceItemMenu
      resource={resource}
      extraActions={[action("Show Markdown", { icon: MarkdownMarkIcon })]}
    >
      {() => <button type="button">Item</button>}
    </ResourceItemMenu>
  </ResourceMenuProvider>
);

const sharedSession = {
  resourceId: "session-mira",
  projectId: "project",
  sourceId: "source",
  kind: "session",
  source: "codex",
  files: [{ path: "session.jsonl", hash: "h", size: 100, executable: false }],
  revision: 3,
  owner: "mira",
} as unknown as ProjectResource;

const sharedSessionState = {
  ...(state as Record<string, unknown>),
  config: { apiUrl: "https://api.example", mode: "cloud", syncMinutes: 5 },
  resources: [sharedSession],
} as never;

const sharedSessionMenu = (
  <ResourceMenuProvider
    resources={[sharedSession]}
    scope="test"
    state={sharedSessionState}
    busy={false}
    act={fn}
    onOpen={fn}
    onReview={fn}
    onOpenRequests={fn}
    onNotice={fn}
    onError={fn}
    onRefresh={fn}
  >
    <ResourceItemMenu
      resource={sharedSession}
      extraActions={[action("Show Markdown", { icon: MarkdownMarkIcon })]}
    >
      {() => <button type="button">Session item</button>}
    </ResourceItemMenu>
  </ResourceMenuProvider>
);

const worstCaseMenus: [string, React.ReactElement, string][] = [
  ["resource menu", resourceMenu, "Item"],
  ["shared session menu", sharedSessionMenu, "Session item"],
  [
    "member menu",
    <MemberRows
      members={[{ id: "other", role: "admin", name: "Sam" }]}
      user="me"
      owner
      admin={false}
      busy=""
      onRole={fn}
      onRemove={fn}
      onTransfer={fn}
    />,
    "Sam",
  ],
];

test.each(worstCaseMenus)(
  `the worst-case %s stays within ${ITEM_MENU_CAP} top-level items`,
  async (name, element, target) => {
    const { menu } = await open(element, target);
    const count = menu.querySelectorAll(":scope > [role=menuitem]").length;
    expect(count, name).toBeLessThanOrEqual(ITEM_MENU_CAP);
  },
);

test("shared session menu keeps top-level within cap and nests Share handoff link under More actions", async () => {
  const { menu } = await open(sharedSessionMenu, "Session item");
  const topLevelLabels = Array.from(
    menu.querySelectorAll(":scope > [role=menuitem]"),
    (item) => item.textContent,
  );
  expect(topLevelLabels.length).toBeLessThanOrEqual(ITEM_MENU_CAP);
  expect(topLevelLabels).toContain("Manage public link…");
  expect(topLevelLabels).not.toContain("Share handoff link…");

  const more = within(menu).getByRole("menuitem", { name: "More actions" });
  fireEvent.keyDown(more, { key: "ArrowRight" });
  const submenu = await screen.findByRole("menu", { name: "More actions" });
  expect(
    within(submenu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent),
  ).toContain("Share handoff link…");
});

test("a shared skill keeps everyday actions and deletion at the top level", async () => {
  const { menu, entries } = await open(resourceMenu);
  expect(entries).toEqual([
    "svg Open",
    "svg Open in editor",
    "svg Copy file content",
    "svg Compare with previous revision",
    "svg Copy link",
    "svg Show Markdown",
    "|",
    "svg More actions",
    "|",
    "svg Delete shared skill…",
  ]);
  const more = within(menu).getByRole("menuitem", { name: "More actions" });
  fireEvent.keyDown(more, { key: "ArrowRight" });
  const submenu = await screen.findByRole("menu", { name: "More actions" });
  expect(
    within(submenu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent),
  ).toEqual([
    "Export ZIP…",
    "Show in Finder",
    "Copy local path",
    "Review local update…",
    "Review local edits…",
  ]);
});
