import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { App } from "./app.js";
import type { Snapshot } from "./types.js";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => false,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

function launch() {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  let resolve!: (value: Snapshot) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<Snapshot>((resolveSnapshot, rejectSnapshot) => {
    resolve = resolveSnapshot;
    reject = rejectSnapshot;
  });
  vi.mocked(invoke).mockImplementation((command) =>
    command === "snapshot" ? promise : Promise.resolve(null),
  );
  render(<App />);
  return { resolve, reject };
}
const signedOut: Snapshot = {
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
  deviceId: "",
  background: null,
};
const signIn = () =>
  screen.queryByRole("heading", { name: "Get started with Orka" });

test("a signed-in launch never shows sign-in before the snapshot resolves", async () => {
  const snapshot = launch();
  expect(signIn()).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("Loading");
  await act(async () =>
    snapshot.resolve({ ...signedOut, user: "user@example.com" }),
  );
  expect(signIn()).toBeNull();
  expect(screen.queryByText("Loading…")).toBeNull();
});

test("a signed-out snapshot shows the sign-in form", async () => {
  const snapshot = launch();
  await act(async () => snapshot.resolve(signedOut));
  expect(signIn()).toBeTruthy();
});

test("a failed first snapshot shows an error and can recover on retry", async () => {
  const snapshot = launch();
  await act(async () => snapshot.reject(new Error("Database unavailable")));
  expect(screen.getByRole("alert").textContent).toContain(
    "Database unavailable",
  );
  expect(signIn()).toBeNull();
  vi.mocked(invoke).mockResolvedValue(signedOut);
  await act(async () =>
    screen.getByRole("button", { name: "Try again" }).click(),
  );
  expect(signIn()).toBeTruthy();
});
