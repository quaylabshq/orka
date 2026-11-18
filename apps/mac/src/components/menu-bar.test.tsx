import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MenuBar } from "./menu-bar.js";

vi.mock("@tauri-apps/api/core", () => ({
  // The panel polls the native snapshot; leave it pending for this test.
  invoke: vi.fn(() => new Promise(() => {})),
}));

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

test("the menu-bar window hides the WebView menu", () => {
  const { container } = render(<MenuBar />);
  expect(fireEvent.contextMenu(container.firstElementChild!)).toBe(false);
  for (const button of screen.getAllByRole("button"))
    expect(fireEvent.contextMenu(button)).toBe(false);
});
