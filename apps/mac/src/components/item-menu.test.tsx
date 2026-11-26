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

const action = (label: string, extra: Partial<ItemMenuAction> = {}) => ({
  id: label,
  label,
  icon: BookOpenIcon,
  onSelect: vi.fn(),
  ...extra,
});

beforeEach(() => {
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
});

/** Renders a menu, opens it from the element named `target`, and returns it. */
async function open(element: React.ReactElement, target = "Item") {
  render(element);
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

const worstCaseMenus: [string, React.ReactElement, string][] = [
  ["resource menu", resourceMenu, "Item"],
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
