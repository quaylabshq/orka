import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
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
  sync: { online: true, lastSync: "2026-11-19T00:00:00Z" },
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

function menu(
  queue: SyncQueueEntry[],
  snapshot = state,
  onCancel = vi.fn(),
  review: ProjectAttention = attention,
) {
  return (
    <SyncMenu
      placement="header"
      state={snapshot}
      attention={review}
      busy={false}
      open
      queue={queue}
      onCancel={onCancel}
      onSync={vi.fn()}
      onRetry={vi.fn()}
      onSettings={vi.fn()}
      onConnect={vi.fn()}
      onOpen={vi.fn()}
    />
  );
}

function row(project: string) {
  const rows = Array.from(
    document.querySelectorAll<HTMLElement>(".sync-queue-row"),
  );
  const result = rows.find((element) => element.textContent?.includes(project));
  expect(result, `Queue row for ${project}`).toBeTruthy();
  return result!;
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

test("the panel identifies its scope and keeps an idle queue compact", () => {
  render(menu([]));
  expect(screen.getByText("All projects")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Sync now" })).toBeTruthy();
  expect(document.querySelector(".sync-queue-row")).toBeNull();
  expect(screen.queryByRole("progressbar")).toBeNull();
});

test("pending uploads cannot be presented as up to date", () => {
  const outbox: Snapshot["outbox"] = [
    { id: "pending", project: "one", error: null },
  ];
  render(menu([], { ...state, outbox }, vi.fn(), { ...attention, outbox }));
  expect(document.querySelector(".sync-menu-status")?.textContent).toContain(
    "Changes pending",
  );
  expect(document.querySelector(".sync-status")?.textContent).toBe("Pending");
  expect(screen.queryByText("Up to date", { exact: true })).toBeNull();
});

test("queued projects give the overview and trigger the same queued state", () => {
  render(menu([entry("two")]));
  expect(document.querySelector(".sync-menu-status")?.textContent).toContain(
    "Sync queued",
  );
  expect(document.querySelector(".sync-status")?.textContent).toBe("Queued");
  expect(screen.queryByText("Up to date", { exact: true })).toBeNull();
});

test("waiting retries give the overview and trigger the same waiting state", () => {
  render(
    menu([
      entry("three", {
        state: "waiting",
        attempts: 2,
        notBefore: new Date(Date.now() + 120_000).toISOString(),
      }),
    ]),
  );
  expect(document.querySelector(".sync-menu-status")?.textContent).toContain(
    "Waiting to retry",
  );
  expect(document.querySelector(".sync-status")?.textContent).toBe(
    "Waiting to retry",
  );
  expect(screen.queryByText("Up to date", { exact: true })).toBeNull();
});

test("active project progress belongs to its row above the waiting projects", () => {
  render(
    menu([entry("one", { state: "running" }), entry("two")], {
      ...state,
      syncProgress: {
        projectId: "one",
        label: "Uploading changes",
        detail: "Orka · AGENTS.md",
        completed: 2,
        total: 8,
      },
    }),
  );
  const active = row("Orka");
  expect(active.closest(".sync-menu-progress")).toBeTruthy();
  expect(
    within(active).getByRole("button", { name: "Cancel sync for Orka" }),
  ).toBeTruthy();
  expect(document.querySelector(".sync-menu-progress")?.textContent).toContain(
    "Uploading changes",
  );
  expect(document.querySelector(".sync-menu-progress")?.textContent).toContain(
    "AGENTS.md",
  );
  const bar = screen.getByRole("progressbar", { name: "Uploading changes" });
  expect(bar.getAttribute("aria-valuenow")).toBe("2");
  expect(bar.getAttribute("aria-valuemax")).toBe("8");
  expect(row("Docs").closest(".sync-menu-feed")).toBeTruthy();
  expect(document.querySelectorAll(".sync-queue-row")).toHaveLength(2);
});

test("waiting retries have a relative label, an exact retry time and Cancel", () => {
  const at = new Date(Date.now() + 120_000);
  const onCancel = vi.fn();
  render(
    menu(
      [
        entry("three", {
          state: "waiting",
          attempts: 2,
          notBefore: at.toISOString(),
        }),
      ],
      state,
      onCancel,
    ),
  );
  const waiting = row("Site");
  expect(waiting.textContent).toContain("Waiting to retry");
  expect(waiting.textContent).toMatch(/in 2 min/);
  expect(
    Array.from(waiting.querySelectorAll("[title]")).some((element) =>
      element.getAttribute("title")?.includes(at.toLocaleString()),
    ),
  ).toBe(true);
  fireEvent.click(
    within(waiting).getByRole("button", { name: "Cancel sync for Site" }),
  );
  expect(onCancel).toHaveBeenCalledExactlyOnceWith("three");
});

test("Cancel targets each running or queued project's identity", () => {
  const onCancel = vi.fn();
  render(
    menu([entry("one", { state: "running" }), entry("two")], state, onCancel),
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel sync for Docs" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel sync for Orka" }));
  expect(onCancel.mock.calls).toEqual([["two"], ["one"]]);
});

test("a cancelled active project stays visible as stopping until its worker settles", () => {
  const onCancel = vi.fn();
  const view = render(
    menu([entry("one", { state: "running" }), entry("two")], state, onCancel),
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel sync for Orka" }));
  view.rerender(
    menu(
      [entry("one", { state: "running", cancelRequested: true }), entry("two")],
      state,
      onCancel,
    ),
  );
  const stopping = row("Orka");
  expect(stopping.textContent).toContain("Stopping");
  const stop = within(stopping).getByRole("button");
  expect(stop.hasAttribute("disabled")).toBe(true);
  fireEvent.click(stop);
  expect(onCancel).toHaveBeenCalledExactlyOnceWith("one");
  view.rerender(menu([entry("two")], state, onCancel));
  expect(document.querySelector(".sync-menu-progress")).toBeNull();
  expect(document.querySelectorAll(".sync-queue-row")).toHaveLength(1);
  expect(row("Docs")).toBeTruthy();
});

test("a stale phase from a different project is not attributed to the active one", () => {
  render(
    menu([entry("one", { state: "running" })], {
      ...state,
      syncProgress: {
        projectId: "two",
        label: "Downloading updates",
        detail: "Docs-only private phase",
        completed: 4,
        total: 5,
      },
    }),
  );
  expect(row("Orka")).toBeTruthy();
  expect(screen.queryByText("Docs-only private phase")).toBeNull();
  expect(
    screen.queryByRole("progressbar", { name: "Downloading updates" }),
  ).toBeNull();
});

test("legacy and workspace progress remains readable without a project identity", () => {
  render(
    menu([], {
      ...state,
      syncProgress: {
        label: "Connecting to sync service",
        detail: "Refreshing devices",
        completed: 0,
        total: null,
      },
    }),
  );
  expect(document.querySelector(".sync-menu-progress")?.textContent).toContain(
    "Connecting to sync service",
  );
  expect(document.querySelector(".sync-menu-progress")?.textContent).toContain(
    "Refreshing devices",
  );
  expect(screen.queryByRole("progressbar")).toBeNull();
});

test("project activity precedes attention and technical diagnostics stay collapsed", () => {
  render(
    menu([entry("two")], state, vi.fn(), {
      ...attention,
      items: [
        {
          key: "file",
          title: "A changed file",
          messages: ["Review this file"],
          errors: [],
          paths: [],
          requests: [],
          conflicts: [],
          uploads: [],
        },
      ],
      accountIssues: [
        {
          source: "history:unattributed:fixture",
          error: "Some local history is unavailable",
        },
      ],
    }),
  );
  const heading = screen.getByRole("heading", { name: /attention/i });
  expect(
    Boolean(
      row("Docs").compareDocumentPosition(heading) &
      Node.DOCUMENT_POSITION_FOLLOWING,
    ),
  ).toBe(true);
  const details = document.querySelector(
    "[aria-label='Account diagnostics'] details",
  );
  expect(details).toBeTruthy();
  expect(details!.hasAttribute("open")).toBe(false);
  expect(
    Boolean(
      heading.compareDocumentPosition(details!) &
      Node.DOCUMENT_POSITION_FOLLOWING,
    ),
  ).toBe(true);
});
