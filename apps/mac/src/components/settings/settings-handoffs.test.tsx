import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { Snapshot } from "../../types.js";
import { DesktopUsageProvider } from "../desktop-usage.js";
import { LoadingProvider } from "../loading-region.js";
import type { DesktopUpdates } from "../use-desktop-updates.js";
import { WorkspaceCache, WorkspaceCacheProvider } from "../workspace-cache.js";
import {
  SettingsHandoffs,
  type ActiveHandoff,
  type ListHandoffsResponse,
} from "./settings-handoffs.js";
import { SettingsModal } from "./settings-modal.js";

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));

vi.mock("@tauri-apps/api/core", () => native);
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

const sampleHandoffs: ActiveHandoff[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Investigate webhook retries",
    source: "claude",
    createdAt: "2026-11-24T10:00:00Z",
    expiresAt: "2026-12-01T10:00:00Z",
    includeToolCalls: true,
    messageCount: 14,
    toolCallCount: 5,
    memoryCount: 2,
    url: null,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    title: "",
    source: "pi",
    createdAt: "2026-11-25T10:00:00Z",
    expiresAt: "2026-12-02T10:00:00Z",
    includeToolCalls: false,
    messageCount: 1,
    memoryCount: 0,
    url: null,
  },
];

const makeSnapshot = (
  user: string | null = "alice",
  apiUrl = "https://api.example",
): Snapshot =>
  ({
    profile: "work",
    user,
    deviceId: "mac-1",
    config: apiUrl ? { apiUrl, mode: "cloud", syncMinutes: 15 } : undefined,
    projects: [],
    resources: [],
    bindings: [],
    conflicts: [],
    activity: [],
    outbox: [],
    errors: [],
    devices: [],
    background: true,
    sync: { online: true },
    daemon: { running: true },
  }) as unknown as Snapshot;

function renderHandoffs(state: Snapshot = makeSnapshot()) {
  return render(
    <WorkspaceCacheProvider state={state}>
      <LoadingProvider scope={WorkspaceCache.scope(state)}>
        <SettingsHandoffs state={state} />
      </LoadingProvider>
    </WorkspaceCacheProvider>,
  );
}

beforeEach(() => {
  native.invoke.mockReset();
  native.isTauri.mockReturnValue(true);
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("renders loading state, populated active links without copy buttons, and revokes via confirmation modal", async () => {
  let resolveList: (value: ListHandoffsResponse) => void = () => {};
  let revokeAttempt = 0;

  native.invoke.mockImplementation((command) => {
    if (command === "list_handoffs") {
      return new Promise<ListHandoffsResponse>((resolve) => {
        resolveList = resolve;
      });
    }
    if (command === "revoke_handoff") {
      revokeAttempt += 1;
      if (revokeAttempt === 1) {
        return Promise.reject(new Error("Service temporarily unavailable"));
      }
      return Promise.resolve({
        id: sampleHandoffs[0].id,
        revoked: true,
      });
    }
    return Promise.resolve({});
  });

  renderHandoffs();
  expect(screen.getByText("Loading handoff links…")).toBeTruthy();

  await act(async () => {
    resolveList({ supported: true, handoffs: sampleHandoffs });
  });

  expect(await screen.findByText("Investigate webhook retries")).toBeTruthy();
  expect(screen.getByText("Untitled session")).toBeTruthy();
  expect(screen.getByText("Claude Code")).toBeTruthy();
  expect(screen.getByText("Pi")).toBeTruthy();
  expect(
    screen.getByText(/14 messages · 2 memories · 5 tool calls/),
  ).toBeTruthy();
  // Must NOT render fake copy buttons since url is null on list
  expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();

  const rows = screen.getAllByRole("listitem");
  expect(rows).toHaveLength(2);

  // Open confirm modal and cancel
  fireEvent.click(within(rows[0]).getByRole("button", { name: "Revoke" }));
  const modal = await screen.findByRole("dialog", {
    name: "Revoke handoff link?",
  });
  fireEvent.click(within(modal).getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Revoke handoff link?" }),
    ).toBeNull(),
  );
  expect(screen.getAllByRole("listitem")).toHaveLength(2);

  // Open confirm modal, fail once, then retry and succeed
  fireEvent.click(within(rows[0]).getByRole("button", { name: "Revoke" }));
  const confirmModal = await screen.findByRole("dialog", {
    name: "Revoke handoff link?",
  });
  fireEvent.click(
    within(confirmModal).getByRole("button", { name: "Revoke link" }),
  );

  expect(
    (await within(confirmModal).findByRole("alert")).textContent,
  ).toContain("Service temporarily unavailable");

  fireEvent.click(
    within(confirmModal).getByRole("button", { name: "Revoke link" }),
  );

  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Revoke handoff link?" }),
    ).toBeNull(),
  );
  expect(screen.getAllByRole("listitem")).toHaveLength(1);
  expect(screen.queryByText("Investigate webhook retries")).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("Handoff link revoked.");

  expect(invoke).toHaveBeenCalledWith("revoke_handoff", {
    id: sampleHandoffs[0].id,
    accountId: "alice",
    serviceOrigin: "https://api.example",
  });
});

test("renders empty, unsupported, error+retry, and signed-out states cleanly", async () => {
  // 1. Signed out: never invokes list_handoffs
  const { rerender } = renderHandoffs(makeSnapshot(null, ""));
  expect(
    screen.getByText("Sign in to view and manage your active handoff links."),
  ).toBeTruthy();
  expect(invoke).not.toHaveBeenCalled();

  // 2. Unsupported service
  native.invoke.mockResolvedValueOnce({ supported: false, handoffs: [] });
  rerender(
    <WorkspaceCacheProvider state={makeSnapshot("alice")}>
      <LoadingProvider scope="work:alice:https://api.example">
        <SettingsHandoffs state={makeSnapshot("alice")} />
      </LoadingProvider>
    </WorkspaceCacheProvider>,
  );
  expect(
    await screen.findByText(/doesn’t support browser handoffs yet/i),
  ).toBeTruthy();

  // 3. Error + Retry -> Empty state
  native.invoke
    .mockRejectedValueOnce(new Error("Sign in required"))
    .mockResolvedValueOnce({ supported: true, handoffs: [] });
  rerender(
    <WorkspaceCacheProvider state={makeSnapshot("bob")}>
      <LoadingProvider scope="work:bob:https://api.example">
        <SettingsHandoffs state={makeSnapshot("bob")} />
      </LoadingProvider>
    </WorkspaceCacheProvider>,
  );

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(
    "Couldn’t load handoff links: Sign in required",
  );
  fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
  expect(await screen.findByText(/No active handoff links\./)).toBeTruthy();
});

test("refreshes the active list when revoke fails with a server error such as 404", async () => {
  let listCalls = 0;
  native.invoke.mockImplementation(async (command) => {
    if (command === "list_handoffs") {
      listCalls += 1;
      if (listCalls === 1) {
        return { supported: true, handoffs: sampleHandoffs };
      }
      // Background refresh after 404 reflects the already-expired/revoked link
      return { supported: true, handoffs: [sampleHandoffs[1]] };
    }
    if (command === "revoke_handoff") {
      throw new Error("404: Handoff not found");
    }
    return {};
  });

  renderHandoffs();
  expect(await screen.findByText("Investigate webhook retries")).toBeTruthy();

  fireEvent.click(
    within(screen.getAllByRole("listitem")[0]).getByRole("button", {
      name: "Revoke",
    }),
  );
  const modal = await screen.findByRole("dialog", {
    name: "Revoke handoff link?",
  });
  fireEvent.click(within(modal).getByRole("button", { name: "Revoke link" }));

  expect((await within(modal).findByRole("alert")).textContent).toContain(
    "404: Handoff not found",
  );
  await waitFor(() => expect(listCalls).toBe(2));
  fireEvent.click(within(modal).getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(screen.queryByText("Investigate webhook retries")).toBeNull(),
  );
  expect(screen.getAllByRole("listitem")).toHaveLength(1);
});

test("ignores stale revoke completion when account switches mid-revoke", async () => {
  let resolveRevoke: () => void = () => {};
  const bobHandoff: ActiveHandoff = {
    id: "33333333-3333-4333-8333-333333333333",
    title: "Bob’s active handoff",
    source: "codex",
    createdAt: "2026-11-26T10:00:00Z",
    expiresAt: "2026-12-03T10:00:00Z",
    messageCount: 4,
    memoryCount: 1,
    url: null,
  };

  native.invoke.mockImplementation((command, args) => {
    const input = args as { accountId?: string };
    if (command === "list_handoffs") {
      return Promise.resolve({
        supported: true,
        handoffs: input.accountId === "alice" ? sampleHandoffs : [bobHandoff],
      });
    }
    if (command === "revoke_handoff") {
      return new Promise((resolve) => {
        resolveRevoke = () =>
          resolve({ id: sampleHandoffs[0].id, revoked: true });
      });
    }
    return Promise.resolve({});
  });

  const ui = (user: string) => {
    const state = makeSnapshot(user);
    return (
      <WorkspaceCacheProvider state={state}>
        <LoadingProvider scope={WorkspaceCache.scope(state)}>
          <SettingsHandoffs state={state} />
        </LoadingProvider>
      </WorkspaceCacheProvider>
    );
  };

  const { rerender } = render(ui("alice"));
  expect(await screen.findByText("Investigate webhook retries")).toBeTruthy();

  fireEvent.click(
    within(screen.getAllByRole("listitem")[0]).getByRole("button", {
      name: "Revoke",
    }),
  );
  const modal = await screen.findByRole("dialog", {
    name: "Revoke handoff link?",
  });
  fireEvent.click(within(modal).getByRole("button", { name: "Revoke link" }));

  // Switch account to bob while alice's revoke is still in flight
  rerender(ui("bob"));
  expect(await screen.findByText("Bob’s active handoff")).toBeTruthy();
  expect(screen.queryByText("Investigate webhook retries")).toBeNull();
  expect(
    screen.queryByRole("dialog", { name: "Revoke handoff link?" }),
  ).toBeNull();

  // Complete alice's stale revoke -> must NOT clobber bob's list or show alice's notice
  await act(async () => {
    resolveRevoke();
  });
  expect(screen.getByText("Bob’s active handoff")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("");
});

test("SettingsModal on section=handoffs does not emit settings_section_viewed:handoffs", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);

  native.invoke.mockImplementation(async (command) => {
    if (command === "list_handoffs") return { supported: true, handoffs: [] };
    if (command === "settings_command") return [];
    return {};
  });

  const state = makeSnapshot("alice");
  const updates = {
    status: null,
    checking: false,
    installing: false,
    error: "",
    check: vi.fn(),
    install: vi.fn(),
  } as unknown as DesktopUpdates;

  render(
    <WorkspaceCacheProvider state={state}>
      <LoadingProvider scope={WorkspaceCache.scope(state)}>
        <DesktopUsageProvider state={state}>
          <SettingsModal
            state={state}
            updates={updates}
            initialProjectId=""
            initialSection="handoffs"
            busy={false}
            run={async (action) => {
              await action();
            }}
            onSignedOut={vi.fn()}
            onSyncActivity={vi.fn()}
            onManage={vi.fn()}
            onViewInactiveProject={vi.fn()}
            onClose={vi.fn()}
          />
        </DesktopUsageProvider>
      </LoadingProvider>
    </WorkspaceCacheProvider>,
  );

  await act(async () => {
    await vi.advanceTimersByTimeAsync(3_000);
  });

  const recordedEvents = native.invoke.mock.calls
    .filter(([command]) => command === "record_desktop_usage")
    .flatMap(([, args]) => (args as { events: string[] }).events);

  expect(recordedEvents).toContain("settings_viewed");
  expect(recordedEvents).not.toContain("settings_section_viewed:handoffs");

  // Navigating to Devices DOES emit settings_section_viewed:devices
  fireEvent.click(screen.getByRole("button", { name: "Devices" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3_000);
  });

  const afterEvents = native.invoke.mock.calls
    .filter(([command]) => command === "record_desktop_usage")
    .flatMap(([, args]) => (args as { events: string[] }).events);
  expect(afterEvents).toContain("settings_section_viewed:devices");
  expect(afterEvents).not.toContain("settings_section_viewed:handoffs");
});
