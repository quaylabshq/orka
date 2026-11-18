import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Snapshot, SyncQueueEntry } from "../types.js";
import type { ProjectAttention } from "./sync-attention.js";
import { SyncMenu } from "./sync-menu.js";

const state: Snapshot = {
  user: "user",
  config: { apiUrl: "https://test.local", syncMinutes: 15 },
  projects: [
    { id: "one", name: "Orka", role: "owner" },
    { id: "two", name: "Docs", role: "member" },
    { id: "three", name: "Site", role: "owner" },
  ],
  resources: [],
  bindings: [],
  conflicts: [],
  activity: [],
  outbox: [],
  errors: [],
  sync: { online: true },
  daemon: { running: true },
  devices: [],
  deviceId: "device",
  background: true,
};

const attention: ProjectAttention = {
  items: [],
  outbox: [],
  waitingRequests: [],
  historyRequests: [],
  historyDrafts: [],
  activity: [],
  accountIssues: [],
};

const entry = (
  projectId: string,
  extra: Partial<SyncQueueEntry> = {},
): SyncQueueEntry => ({
  projectId,
  state: "queued",
  reason: "timer",
  attempts: 0,
  notBefore: null,
  ...extra,
});

function show(queue: SyncQueueEntry[], onCancel = vi.fn()) {
  render(
    <SyncMenu
      state={state}
      attention={attention}
      busy={false}
      open
      queue={queue}
      onCancel={onCancel}
      onSync={vi.fn()}
      onRetry={vi.fn()}
      onSettings={vi.fn()}
      onConnect={vi.fn()}
      onOpen={vi.fn()}
    />,
  );
  return onCancel;
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

test("each queued project shows its own state", () => {
  const notBefore = new Date();
  notBefore.setHours(14, 35, 0, 0);
  show([
    entry("one", { state: "running" }),
    entry("two"),
    entry("three", {
      state: "waiting",
      attempts: 2,
      notBefore: notBefore.toISOString(),
    }),
  ]);
  expect(screen.getByText("Orka")).toBeTruthy();
  expect(screen.getByText("Syncing")).toBeTruthy();
  expect(screen.getByText("Docs")).toBeTruthy();
  expect(screen.getByText("Queued")).toBeTruthy();
  expect(screen.getByText("Site")).toBeTruthy();
  const label = notBefore.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  expect(screen.getByText(`Retrying at ${label}`)).toBeTruthy();
});

test("Cancel calls the command's project and a waiting job offers none", () => {
  const onCancel = show([
    entry("one", { state: "running" }),
    entry("two"),
    entry("three", {
      state: "waiting",
      attempts: 1,
      notBefore: new Date().toISOString(),
    }),
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Cancel sync for Docs" }));
  expect(onCancel).toHaveBeenCalledWith("two");
  expect(
    screen.queryByRole("button", { name: "Cancel sync for Site" }),
  ).toBeNull();
  expect(
    screen.getByRole("button", { name: "Cancel sync for Orka" }),
  ).toBeTruthy();
});

test("an idle queue adds nothing to the panel", () => {
  show([]);
  expect(screen.queryByText("Queue")).toBeNull();
});
