import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ProjectResource } from "../types.js";
import { ResourceMenuProvider } from "./resource-menu.js";
import { ResourceTable } from "./resource-table.js";
import { WorkspaceCacheProvider } from "./workspace-cache.js";

const session = (resourceId: string, title: string) =>
  ({
    resourceId,
    projectId: "project",
    kind: "session",
    title,
    logicalPath: `sessions/${resourceId}`,
    files: [],
    revision: 0,
    local: true,
    owner: "me",
    updatedAt: "2026-11-01T00:00:00Z",
  }) as unknown as ProjectResource;

const resources = [session("a", "Fix login"), session("b", "Write docs")];

function renderTable() {
  const onOpen = vi.fn();
  const state = {
    profile: "test",
    config: { apiUrl: "https://test.example", syncMinutes: 5 },
    user: "me",
    projects: [{ id: "project", name: "Project", role: "owner" }],
  } as never;
  render(
    <WorkspaceCacheProvider state={state}>
      <ResourceMenuProvider
        resources={resources}
        scope="test"
        state={state}
        busy={false}
        act={vi.fn()}
        onOpen={vi.fn()}
        onReview={vi.fn()}
        onNotice={vi.fn()}
        onError={vi.fn()}
        onRefresh={vi.fn()}
      >
        <ResourceTable
          resources={resources}
          label="Sessions"
          user="me"
          displayTitle={(resource) => resource.title}
          conflicted={new Set()}
          onOpen={onOpen}
        />
      </ResourceMenuProvider>
    </WorkspaceCacheProvider>,
  );
  return onOpen;
}

const row = (title: string) => screen.getByText(title).closest("tr")!;
const waitForMenu = () => act(() => new Promise((done) => setTimeout(done)));

/** A full left-button press, as WebKit dispatches it, on one element. */
async function press(element: Element) {
  fireEvent.pointerDown(element, { pointerType: "mouse" });
  fireEvent.mouseDown(element);
  await waitForMenu();
  fireEvent.pointerUp(element, { pointerType: "mouse" });
  fireEvent.mouseUp(element);
  fireEvent.click(element);
}

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

test("a left click on any part of a row opens it", () => {
  const onOpen = renderTable();
  fireEvent.click(screen.getByText("Fix login"));
  fireEvent.click(screen.getAllByText("Local Only")[0]);
  fireEvent.click(row("Fix login").cells[2]);
  expect(onOpen.mock.calls).toEqual([["a"], ["a"], ["a"]]);
});

test("a control-click anywhere on a row shows its menu and never opens it", async () => {
  const onOpen = renderTable();
  const targets = [
    screen.getByText("Fix login"),
    screen.getAllByText("Local Only")[0],
    row("Fix login").cells[0],
    row("Fix login").cells[2],
  ];
  for (const target of targets) {
    fireEvent.contextMenu(target, { ctrlKey: true });
    fireEvent.click(target, { ctrlKey: true });
    expect(screen.getByRole("menu", { name: "session actions" })).toBeTruthy();
    expect(row("Fix login").hasAttribute("data-item-menu-open")).toBe(true);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitForMenu();
  }
  expect(onOpen).not.toHaveBeenCalled();
});

test("clicking another row to dismiss a menu does not open that row", async () => {
  const onOpen = renderTable();
  fireEvent.contextMenu(screen.getByText("Fix login"));
  await waitForMenu();
  expect(screen.getByRole("menu")).toBeTruthy();
  // The rest of the window stays available to assistive technology.
  expect(row("Write docs").closest("[aria-hidden]")).toBeNull();

  await press(screen.getByText("Write docs"));
  expect(screen.queryByRole("menu")).toBeNull();
  expect(row("Fix login").hasAttribute("data-item-menu-open")).toBe(false);
  expect(onOpen).not.toHaveBeenCalled();

  await press(screen.getByText("Write docs"));
  expect(onOpen).toHaveBeenCalledWith("b");
});

const openMenu = {
  "right-click": () => fireEvent.contextMenu(screen.getByText("Fix login")),
  "…": () =>
    fireEvent.keyDown(
      screen.getByRole("button", { name: "Actions for Fix login" }),
      {
        key: "Enter",
      },
    ),
};

/** A secondary press on empty window chrome, in the order WebKit sends it. */
function rightClickChrome() {
  const chrome = document.body;
  fireEvent.pointerDown(chrome, { button: 2, pointerType: "mouse" });
  fireEvent.mouseDown(chrome, { button: 2 });
  fireEvent.contextMenu(chrome, { button: 2 });
  fireEvent.pointerUp(chrome, { button: 2, pointerType: "mouse" });
  fireEvent.mouseUp(chrome, { button: 2 });
}

// Enter sends keydown then click. A screen reader can send the click alone.
const activations = {
  Enter: (element: Element) => {
    fireEvent.keyDown(element, { key: "Enter" });
    fireEvent.click(element);
    fireEvent.keyUp(element, { key: "Enter" });
  },
  "a screen reader": (element: Element) => fireEvent.click(element),
};

for (const [menu, open] of Object.entries(openMenu))
  for (const [name, activate] of Object.entries(activations))
    test(`after a right-click dismisses the ${menu} menu, ${name} still opens a row`, async () => {
      const onOpen = renderTable();
      open();
      await waitForMenu();
      expect(screen.getByRole("menu")).toBeTruthy();

      rightClickChrome();
      await waitForMenu();
      expect(screen.queryByRole("menu")).toBeNull();

      const opener = screen.getByText("Write docs");
      opener.focus();
      activate(opener);
      expect(onOpen).toHaveBeenCalledWith("b");
    });
