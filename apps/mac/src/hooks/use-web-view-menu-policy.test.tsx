import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { BookOpenIcon } from "lucide-react";
import { ItemContextMenu } from "../components/item-menu.js";
import { Switch } from "../components/switch.js";
import { useWebViewMenuPolicy } from "./use-web-view-menu-policy.js";

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
});

function Policy({ children }: { children: React.ReactNode }) {
  useWebViewMenuPolicy();
  return <>{children}</>;
}

/** fireEvent returns false when a listener cancelled the WebView menu. */
const keepsNativeMenu = (element: Element) => fireEvent.contextMenu(element);

test("keeps the native menu for text fields, links and selected text", () => {
  render(
    <Policy>
      <input aria-label="Name" />
      <input aria-label="Search" type="search" />
      <input aria-label="Email" type="email" />
      <input aria-label="Count" type="number" />
      <textarea aria-label="Notes" />
      <a href="https://example.com">Docs</a>
      <div contentEditable suppressContentEditableWarning>
        Draft
      </div>
      <div data-native-context-menu>Code</div>
      <p>Selected words</p>
    </Policy>,
  );
  for (const name of ["Name", "Search", "Email", "Count", "Notes"])
    expect(keepsNativeMenu(screen.getByLabelText(name))).toBe(true);
  expect(keepsNativeMenu(screen.getByRole("link"))).toBe(true);
  expect(keepsNativeMenu(screen.getByText("Draft"))).toBe(true);
  expect(keepsNativeMenu(screen.getByText("Code"))).toBe(true);

  const paragraph = screen.getByText("Selected words");
  window.getSelection()!.selectAllChildren(paragraph);
  expect(keepsNativeMenu(paragraph)).toBe(true);
});

test("hides the native menu for toggles, buttons and plain content", () => {
  render(
    <Policy>
      <input aria-label="Pick" type="checkbox" />
      <Switch aria-label="Sync" />
      <input aria-label="Choose" type="radio" />
      <input aria-label="Level" type="range" />
      <input aria-label="Go" type="button" value="Go" />
      <div contentEditable={false}>Locked</div>
      <p>Plain text</p>
    </Policy>,
  );
  for (const name of ["Pick", "Choose", "Level", "Go"])
    expect(keepsNativeMenu(screen.getByLabelText(name))).toBe(false);
  expect(keepsNativeMenu(screen.getByRole("switch"))).toBe(false);
  expect(keepsNativeMenu(screen.getByText("Locked"))).toBe(false);
  expect(keepsNativeMenu(screen.getByText("Plain text"))).toBe(false);
});

test("stops hiding the native menu after unmount", () => {
  const { unmount } = render(
    <Policy>
      <p>Plain text</p>
    </Policy>,
  );
  unmount();
  const paragraph = document.body.appendChild(document.createElement("p"));
  expect(keepsNativeMenu(paragraph)).toBe(true);
  paragraph.remove();
});

test("item menus still open on rows and yield to text fields inside them", () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const onSelect = vi.fn();
  render(
    <Policy>
      <ItemContextMenu
        actions={[{ id: "open", label: "Open", icon: BookOpenIcon, onSelect }]}
        label="Row actions"
      >
        <div>
          <span>Row title</span>
          <input aria-label="Rename" />
        </div>
      </ItemContextMenu>
    </Policy>,
  );

  expect(keepsNativeMenu(screen.getByLabelText("Rename"))).toBe(true);
  expect(screen.queryByRole("menu")).toBeNull();

  expect(keepsNativeMenu(screen.getByText("Row title"))).toBe(false);
  expect(screen.getByRole("menuitem", { name: "Open" })).toBeTruthy();
  expect(onSelect).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
