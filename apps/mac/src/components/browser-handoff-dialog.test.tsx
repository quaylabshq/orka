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
import type { ProjectResource, Snapshot } from "../types.js";
import {
  BrowserHandoffDialog,
  type CreateHandoffReceipt,
  type HandoffCandidates,
} from "./browser-handoff-dialog.js";
import { ResourceItemMenu, ResourceMenuProvider } from "./resource-menu.js";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
  Channel: class {},
}));

const sessionResource = {
  resourceId: "11111111-1111-4111-8111-111111111111",
  projectId: "project-1",
  sourceId: "source-1",
  kind: "session",
  source: "claude",
  logicalPath: "claude/session-1",
  title: "Investigate flaky webhook retries",
  files: [{ path: "session.jsonl", hash: "h1", size: 2048, executable: false }],
  deleted: false,
  hash: "h1",
  revision: 0,
  local: true,
  owner: "alice",
  updatedBy: "alice",
  updatedAt: "2026-11-20T12:00:00Z",
} as ProjectResource;

const validToken = "a".repeat(64);
const validUrl = `https://dashboard.example/handoff/${validToken}`;

const defaultCandidates: HandoffCandidates = {
  session: {
    id: sessionResource.resourceId,
    title: "Investigate flaky webhook retries",
    source: "claude",
    messageCount: 14,
    toolCallCount: 6,
  },
  memories: [
    {
      id: "mem-1",
      slug: "claude-md",
      title: "CLAUDE.md",
      scope: "shared",
      preselected: true,
      byteSize: 2400,
      redactionCount: 0,
    },
    {
      id: "mem-2",
      slug: "webhook-notes",
      title: "Webhook retry architecture notes",
      scope: "local",
      preselected: false,
      byteSize: 4800,
      redactionCount: 2,
    },
  ],
};

const defaultReceipt = (
  requestId: string,
  overrides: Partial<CreateHandoffReceipt> = {},
): CreateHandoffReceipt => ({
  id: "22222222-2222-4222-8222-222222222222",
  url: validUrl,
  createdAt: "2026-11-28T00:00:00Z",
  expiresAt: "2026-12-05T00:00:00Z",
  requestId,
  redactionCount: 3,
  messageCount: 14,
  toolCallCount: 0,
  memoryCount: 1,
  ...overrides,
});

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn().mockResolvedValue(undefined),
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("loads candidates, preselects recommended memories, toggles bulk actions, and submits trimmed note", async () => {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "handoff_candidates") return defaultCandidates;
    if (command === "create_handoff") {
      const input = (args as { input: Record<string, unknown> }).input;
      return defaultReceipt(String(input.requestId), {
        toolCallCount: input.includeToolCalls ? 6 : 0,
        memoryCount: (input.memoryIds as string[]).length,
      });
    }
    return {};
  });

  render(
    <BrowserHandoffDialog
      resource={sessionResource}
      accountId="alice"
      serviceOrigin="https://api.example"
      linkOrigin="https://dashboard.example"
      stale={false}
      onClose={vi.fn()}
    />,
  );

  expect(screen.getByText("Loading handoff options…")).toBeTruthy();

  const claudeBox = (await screen.findByLabelText(
    /CLAUDE\.md/,
  )) as HTMLInputElement;
  const webhookBox = screen.getByLabelText(
    /Webhook retry architecture notes/,
  ) as HTMLInputElement;
  expect(claudeBox.checked).toBe(true);
  expect(webhookBox.checked).toBe(false);
  expect(screen.getByText("1 of 2 selected")).toBeTruthy();
  expect(screen.getByText("2 redacted")).toBeTruthy();

  const toolSwitch = screen.getByRole("switch", {
    name: "Include tool calls",
  }) as HTMLInputElement;
  expect(toolSwitch.checked).toBe(false);

  // Select all, then Clear, then toggle Webhook notes on.
  fireEvent.click(screen.getByRole("button", { name: "Select all" }));
  expect(claudeBox.checked).toBe(true);
  expect(webhookBox.checked).toBe(true);
  expect(screen.getByText("2 of 2 selected")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  expect(claudeBox.checked).toBe(false);
  expect(webhookBox.checked).toBe(false);
  expect(screen.getByText("0 of 2 selected")).toBeTruthy();

  fireEvent.click(webhookBox);
  fireEvent.click(toolSwitch);
  fireEvent.change(screen.getByLabelText("Handoff note (optional)"), {
    target: { value: "  Check the backoff loop first.  " },
  });

  fireEvent.click(screen.getByRole("button", { name: "Create handoff link" }));

  const urlField = (await screen.findByLabelText(
    "Handoff link",
  )) as HTMLInputElement;
  expect(urlField.value).toBe(validUrl);

  const copyBtn = screen.getByRole("button", { name: "Copy link" });
  expect(document.activeElement).toBe(copyBtn);
  expect(screen.getByRole("status").textContent).toBe(
    "Copy this link before closing. Orka cannot show it again.",
  );

  fireEvent.click(copyBtn);
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe("Link copied."),
  );
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith(validUrl);

  const createCall = vi
    .mocked(invoke)
    .mock.calls.find(([command]) => command === "create_handoff");
  expect(createCall?.[1]).toEqual({
    input: {
      sessionId: sessionResource.resourceId,
      memoryIds: ["mem-2"],
      handoffNote: "Check the backoff loop first.",
      includeToolCalls: true,
      requestId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      ),
      accountId: "alice",
      serviceOrigin: "https://api.example",
    },
  });
});

test("reuses exact requestId on UNCONFIRMED retry and mints a fresh requestId after selection changes", async () => {
  const seenRequestIds: string[] = [];
  let attempt = 0;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "handoff_candidates") return defaultCandidates;
    if (command === "create_handoff") {
      const input = (args as { input: Record<string, unknown> }).input;
      seenRequestIds.push(String(input.requestId));
      attempt += 1;
      if (attempt <= 2) {
        throw new Error(
          "Your Orka service didn’t confirm this handoff. Try again to get its link.",
        );
      }
      return defaultReceipt(String(input.requestId));
    }
    return {};
  });

  render(
    <BrowserHandoffDialog
      resource={sessionResource}
      accountId="alice"
      serviceOrigin="https://api.example"
      linkOrigin="https://dashboard.example"
      stale={false}
      onClose={vi.fn()}
    />,
  );

  await screen.findByLabelText(/CLAUDE\.md/);

  // First attempt fails with UNCONFIRMED
  fireEvent.click(screen.getByRole("button", { name: "Create handoff link" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("alert").textContent).toContain("didn’t confirm");

  // Retry with unchanged selection MUST reuse exact requestId
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(seenRequestIds).toHaveLength(2));
  expect(seenRequestIds[1]).toBe(seenRequestIds[0]);

  // Change selection -> MUST mint a fresh requestId
  fireEvent.click(screen.getByLabelText(/Webhook retry architecture notes/));
  fireEvent.click(screen.getByRole("button", { name: "Create handoff link" }));
  await screen.findByLabelText("Handoff link");
  expect(seenRequestIds).toHaveLength(3);
  expect(seenRequestIds[2]).not.toBe(seenRequestIds[0]);
});

test("renders distinct secret-blocked alert for HANDOFF_SECRET errors", async () => {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "handoff_candidates") return defaultCandidates;
    if (command === "create_handoff") {
      throw "HANDOFF_SECRET: Orka found a secret it couldn’t remove from this handoff, so nothing was sent.";
    }
    return {};
  });

  render(
    <BrowserHandoffDialog
      resource={sessionResource}
      accountId="alice"
      serviceOrigin="https://api.example"
      linkOrigin="https://dashboard.example"
      stale={false}
      onClose={vi.fn()}
    />,
  );

  await screen.findByLabelText(/CLAUDE\.md/);
  fireEvent.click(screen.getByRole("button", { name: "Create handoff link" }));

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Secret blocked this handoff");
  expect(alert.textContent).toContain("nothing was sent");
  expect(alert.textContent).toContain(
    "Uncheck a memory or turn off tool calls",
  );
  expect(alert.textContent).not.toContain("HANDOFF_SECRET:");
});

test("handles zero messages, zero tool calls, empty memories, and load retry", async () => {
  let loadAttempts = 0;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "handoff_candidates") {
      loadAttempts += 1;
      if (loadAttempts === 1) throw new Error("Could not read local session.");
      return {
        session: {
          id: sessionResource.resourceId,
          title: "Empty session",
          source: "pi",
          messageCount: 0,
          toolCallCount: 0,
        },
        memories: [],
      } satisfies HandoffCandidates;
    }
    return {};
  });

  render(
    <BrowserHandoffDialog
      resource={sessionResource}
      accountId="alice"
      serviceOrigin="https://api.example"
      linkOrigin="https://dashboard.example"
      stale={false}
      onClose={vi.fn()}
    />,
  );

  expect((await screen.findByRole("alert")).textContent).toContain(
    "Could not read local session.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));

  expect(
    await screen.findByText("No project memories available to attach."),
  ).toBeTruthy();
  expect(screen.getByText("This session has no tool calls.")).toBeTruthy();
  expect(
    (
      screen.getByRole("switch", {
        name: "Include tool calls",
      }) as HTMLInputElement
    ).disabled,
  ).toBe(true);
  expect(
    (
      screen.getByRole("button", {
        name: "Create handoff link",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

test("rejects malformed receipt URLs and handles clipboard copy failure gracefully", async () => {
  let callCount = 0;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "handoff_candidates") return defaultCandidates;
    if (command === "create_handoff") {
      callCount += 1;
      const requestId = String(
        (args as { input: { requestId: string } }).input.requestId,
      );
      if (callCount === 1) {
        return defaultReceipt(requestId, {
          url: `https://evil.example/handoff/${validToken}`,
        });
      }
      return defaultReceipt(requestId, { url: validUrl });
    }
    return {};
  });

  vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(
    new Error("Denied"),
  );

  render(
    <BrowserHandoffDialog
      resource={sessionResource}
      accountId="alice"
      serviceOrigin="https://api.example"
      linkOrigin="https://dashboard.example"
      stale={false}
      onClose={vi.fn()}
    />,
  );

  await screen.findByLabelText(/CLAUDE\.md/);
  fireEvent.click(screen.getByRole("button", { name: "Create handoff link" }));

  expect((await screen.findByRole("alert")).textContent).toContain(
    "unexpected handoff link",
  );

  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByLabelText("Handoff link");

  fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Couldn’t copy the link",
  );
});

test("shows stale alert when account changes mid-dialog", async () => {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "handoff_candidates") return defaultCandidates;
    return {};
  });

  const { rerender } = render(
    <BrowserHandoffDialog
      resource={sessionResource}
      accountId="alice"
      serviceOrigin="https://api.example"
      linkOrigin="https://dashboard.example"
      stale={false}
      onClose={vi.fn()}
    />,
  );

  await screen.findByLabelText(/CLAUDE\.md/);

  rerender(
    <BrowserHandoffDialog
      resource={sessionResource}
      accountId="bob"
      serviceOrigin="https://api.example"
      linkOrigin="https://dashboard.example"
      stale={false}
      onClose={vi.fn()}
    />,
  );

  expect((await screen.findByRole("alert")).textContent).toContain(
    "Account or service changed",
  );
  expect(
    screen.queryByRole("button", { name: "Create handoff link" }),
  ).toBeNull();
});

test("ResourceMenuProvider gates Share handoff link on browserHandoffs capability across cloud and self-hosted", async () => {
  const fn = vi.fn();
  const memoryResource = {
    ...sessionResource,
    resourceId: "mem-1",
    kind: "memory",
    title: "Project notes",
  } as ProjectResource;

  const makeState = (
    user: string | null,
    mode: "cloud" | "self-hosted" = "self-hosted",
  ) =>
    ({
      user,
      config: { apiUrl: "https://selfhost.example", mode, syncMinutes: 5 },
      projects: [
        {
          id: "project-1",
          name: "Project",
          role: "owner",
          governed: false,
          sources: [],
        },
      ],
      resources: [sessionResource, memoryResource],
      outbox: [],
      bindings: [],
      sync: { online: true },
    }) as unknown as Snapshot;

  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "auth_capabilities") {
      return {
        browserHandoffs: 1,
        auth: { browserOrigin: "https://handoffs.selfhost.example" },
      };
    }
    return {};
  });

  const ui = (state: Snapshot) => (
    <ResourceMenuProvider
      resources={[sessionResource, memoryResource]}
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
      <ResourceItemMenu resource={sessionResource}>
        {() => <button type="button">Session row</button>}
      </ResourceItemMenu>
      <ResourceItemMenu resource={memoryResource}>
        {() => <button type="button">Memory row</button>}
      </ResourceItemMenu>
    </ResourceMenuProvider>
  );

  const { rerender } = render(ui(makeState("alice", "self-hosted")));

  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("auth_capabilities", {
      apiUrl: "https://selfhost.example",
    }),
  );

  // Open session menu -> should place Share handoff link… inside More actions even when self-hosted and local/unconnected
  fireEvent.contextMenu(screen.getByRole("button", { name: "Session row" }));
  await act(() => new Promise((done) => setTimeout(done)));
  const sessionMenu = screen.getByRole("menu");
  expect(
    within(sessionMenu).queryByRole("menuitem", {
      name: "Share handoff link…",
    }),
  ).toBeNull();
  const more = within(sessionMenu).getByRole("menuitem", {
    name: "More actions",
  });
  fireEvent.keyDown(more, { key: "ArrowRight" });
  const submenu = await screen.findByRole("menu", { name: "More actions" });
  expect(
    within(submenu).getByRole("menuitem", { name: "Share handoff link…" }),
  ).toBeTruthy();
  fireEvent.keyDown(submenu, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

  // Open memory menu -> must NOT include Share handoff link…
  fireEvent.contextMenu(screen.getByRole("button", { name: "Memory row" }));
  await act(() => new Promise((done) => setTimeout(done)));
  const memoryMenu = screen.getByRole("menu");
  expect(
    within(memoryMenu).queryByRole("menuitem", { name: "Share handoff link…" }),
  ).toBeNull();
  expect(
    within(memoryMenu).queryByRole("menuitem", { name: "More actions" }),
  ).toBeNull();
  fireEvent.keyDown(memoryMenu, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

  // Switch account to bob where service does NOT support browserHandoffs
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "auth_capabilities") return {};
    return {};
  });
  rerender(ui(makeState("bob", "cloud")));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("auth_capabilities", {
      apiUrl: "https://selfhost.example",
    }),
  );

  fireEvent.contextMenu(screen.getByRole("button", { name: "Session row" }));
  await act(() => new Promise((done) => setTimeout(done)));
  const bobMenu = screen.getByRole("menu");
  expect(
    within(bobMenu).queryByRole("menuitem", { name: "Share handoff link…" }),
  ).toBeNull();
  const bobMore = within(bobMenu).queryByRole("menuitem", {
    name: "More actions",
  });
  if (bobMore) {
    fireEvent.keyDown(bobMore, { key: "ArrowRight" });
    const bobSubmenu = await screen.findByRole("menu", {
      name: "More actions",
    });
    expect(
      within(bobSubmenu).queryByRole("menuitem", {
        name: "Share handoff link…",
      }),
    ).toBeNull();
  }
});

test("enforces 500-character scalar note limit (including emojis) and disables submit when exceeded", async () => {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "handoff_candidates") return defaultCandidates;
    if (command === "create_handoff") {
      const input = (args as { input: { requestId: string } }).input;
      return defaultReceipt(input.requestId);
    }
    return {};
  });

  render(
    <BrowserHandoffDialog
      resource={sessionResource}
      accountId="alice"
      serviceOrigin="https://api.example"
      linkOrigin="https://dashboard.example"
      stale={false}
      onClose={vi.fn()}
    />,
  );

  await screen.findByLabelText(/CLAUDE\.md/);
  const noteInput = screen.getByLabelText("Handoff note (optional)");

  // 501 emojis (> 500 scalar chars) shows inline error and disables submit
  fireEvent.change(noteInput, { target: { value: "😀".repeat(501) } });
  expect((await screen.findByRole("alert")).textContent).toContain(
    "500 characters or fewer",
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Create handoff link",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);

  // 500 emojis (1000 UTF-16 code units, 500 scalars) is valid and submits
  fireEvent.change(noteInput, { target: { value: "😀".repeat(500) } });
  expect(screen.getByText("500 / 500 characters")).toBeTruthy();
  const submitButton = screen.getByRole("button", {
    name: "Create handoff link",
  }) as HTMLButtonElement;
  expect(submitButton.disabled).toBe(false);
  fireEvent.click(submitButton);
  await screen.findByLabelText("Handoff link");
});

test("reuses requestId if memory is toggled off and back on, but mints fresh requestId after terminal 409 or secret error", async () => {
  const seenRequestIds: string[] = [];
  let attempt = 0;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "handoff_candidates") return defaultCandidates;
    if (command === "create_handoff") {
      const input = (args as { input: Record<string, unknown> }).input;
      seenRequestIds.push(String(input.requestId));
      attempt += 1;
      if (attempt === 1) {
        throw new Error(
          "Your Orka service didn’t confirm this handoff. Try again to get its link.",
        );
      }
      if (attempt === 2) {
        throw new Error("409: Request ID already used for another handoff.");
      }
      if (attempt === 3) {
        throw new Error("HANDOFF_SECRET: Secret detected in handoff.");
      }
      return defaultReceipt(String(input.requestId));
    }
    return {};
  });

  render(
    <BrowserHandoffDialog
      resource={sessionResource}
      accountId="alice"
      serviceOrigin="https://api.example"
      linkOrigin="https://dashboard.example"
      stale={false}
      onClose={vi.fn()}
    />,
  );

  const claudeBox = await screen.findByLabelText(/CLAUDE\.md/);

  // Attempt 1 -> UNCONFIRMED
  fireEvent.click(screen.getByRole("button", { name: "Create handoff link" }));
  await screen.findByRole("alert");

  // Toggle CLAUDE.md off and back on -> selection signature matches again, so requestId[1] === requestId[0]
  fireEvent.click(claudeBox);
  fireEvent.click(claudeBox);
  fireEvent.click(screen.getByRole("button", { name: "Create handoff link" }));
  await screen.findByRole("alert");
  expect(seenRequestIds).toHaveLength(2);
  expect(seenRequestIds[1]).toBe(seenRequestIds[0]);

  // Attempt 2 hit terminal 409 -> retrying without editing MUST mint fresh requestId
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByText("Secret blocked this handoff");
  expect(seenRequestIds).toHaveLength(3);
  expect(seenRequestIds[2]).not.toBe(seenRequestIds[1]);

  // Attempt 3 hit HANDOFF_SECRET -> retrying without editing MUST mint fresh requestId
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByLabelText("Handoff link");
  expect(seenRequestIds).toHaveLength(4);
  expect(seenRequestIds[3]).not.toBe(seenRequestIds[2]);
});

test("live session hash or revision updates keep an open handoff dialog active, and in-flight submit still delivers its one-time receipt", async () => {
  const fn = vi.fn();
  let finishCreate: (value: CreateHandoffReceipt) => void = () => {};

  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "auth_capabilities") {
      return Promise.resolve({
        browserHandoffs: 1,
        auth: { browserOrigin: "https://dashboard.example" },
      });
    }
    if (command === "handoff_candidates") {
      return Promise.resolve(defaultCandidates);
    }
    if (command === "create_handoff") {
      const requestId = String(
        (args as { input: { requestId: string } }).input.requestId,
      );
      return new Promise<CreateHandoffReceipt>((resolve) => {
        finishCreate = () => resolve(defaultReceipt(requestId));
      });
    }
    return Promise.resolve({});
  });

  const makeResource = (hash: string, deleted = false) =>
    ({
      ...sessionResource,
      hash,
      deleted,
      files: [{ path: "session.jsonl", hash, size: 4096, executable: false }],
    }) as ProjectResource;

  const makeState = (resource: ProjectResource) =>
    ({
      user: "alice",
      config: { apiUrl: "https://api.example", mode: "cloud", syncMinutes: 5 },
      projects: [
        {
          id: "project-1",
          name: "Project",
          role: "owner",
          governed: false,
          sources: [],
        },
      ],
      resources: [resource],
      outbox: [],
      bindings: [],
      sync: { online: true },
    }) as unknown as Snapshot;

  const ui = (resource: ProjectResource) => (
    <ResourceMenuProvider
      resources={[resource]}
      scope="test"
      state={makeState(resource)}
      busy={false}
      act={fn}
      onOpen={fn}
      onReview={fn}
      onOpenRequests={fn}
      onNotice={fn}
      onError={fn}
      onRefresh={fn}
    >
      <ResourceItemMenu resource={resource}>
        {() => <button type="button">Session row</button>}
      </ResourceItemMenu>
    </ResourceMenuProvider>
  );

  const initial = makeResource("h1");
  const { rerender } = render(ui(initial));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("auth_capabilities", {
      apiUrl: "https://api.example",
    }),
  );

  fireEvent.contextMenu(screen.getByRole("button", { name: "Session row" }));
  await act(() => new Promise((done) => setTimeout(done)));
  fireEvent.keyDown(screen.getByRole("menuitem", { name: "More actions" }), {
    key: "ArrowRight",
  });
  const submenu = await screen.findByRole("menu", { name: "More actions" });
  fireEvent.click(
    within(submenu).getByRole("menuitem", { name: "Share handoff link…" }),
  );

  await screen.findByLabelText(/CLAUDE\.md/);
  const noteInput = screen.getByLabelText("Handoff note (optional)");
  fireEvent.change(noteInput, { target: { value: "Keep working draft" } });

  // Live session update bumps hash & files -> dialog stays open with user's draft intact
  rerender(ui(makeResource("h2")));
  expect(
    (screen.getByLabelText("Handoff note (optional)") as HTMLInputElement)
      .value,
  ).toBe("Keep working draft");
  expect(
    screen.queryByText(/no longer available|Account or service changed/),
  ).toBeNull();

  // Start create, then mark session deleted while create_handoff is still in flight
  fireEvent.click(screen.getByRole("button", { name: "Create handoff link" }));
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Creating link…",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true),
  );
  rerender(ui(makeResource("h2", true)));

  // In-flight create must not be hidden behind an enabled Close button or stale screen
  expect(
    screen
      .getAllByRole("button", { name: /^Close$/ })
      .every((button) => (button as HTMLButtonElement).disabled),
  ).toBe(true);
  expect(screen.queryByText(/no longer available/)).toBeNull();
  expect(screen.getByRole("button", { name: "Creating link…" })).toBeTruthy();

  // Resolving create_handoff delivers the one-time receipt cleanly
  await act(async () => {
    finishCreate(defaultReceipt("ignored"));
  });
  expect(
    ((await screen.findByLabelText("Handoff link")) as HTMLInputElement).value,
  ).toBe(validUrl);
});

test("uses explicit bridge retry disposition and preserves requestId for retryable/unconfirmed failures", async () => {
  const seenRequestIds: string[] = [];
  let attempt = 0;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "handoff_candidates") return defaultCandidates;
    if (command === "create_handoff") {
      attempt += 1;
      const input = (args as { input: { requestId: string } }).input;
      seenRequestIds.push(input.requestId);
      if (attempt === 1) {
        throw {
          kind: "general",
          message:
            "You reached the hourly limit for new handoffs. Try again later.",
          preserveRequestId: true,
        };
      }
      if (attempt === 2) {
        throw {
          kind: "general",
          message:
            "The Orka service returned an unexpected handoff link. Nothing was opened.",
          preserveRequestId: true,
        };
      }
      if (attempt === 3) {
        throw "You reached the hourly limit for new handoffs. Try again later.";
      }
      if (attempt === 4) {
        throw "The Orka service returned an unexpected handoff link. Nothing was opened.";
      }
      if (attempt === 5) {
        // Invalid client receipt URL after invoke resolves must also preserve requestId
        return defaultReceipt(input.requestId, {
          url: "https://other.example/handoff/" + "a".repeat(64),
        });
      }
      if (attempt === 6) {
        // Explicit terminal conflict clears requestId on next submission
        throw {
          kind: "general",
          message: "This request ID was already used for a different handoff",
          preserveRequestId: false,
        };
      }
      if (attempt === 7) {
        // Explicit secret error renders secret alert cleanly & clears requestId
        throw {
          kind: "secret",
          message:
            "This handoff still contains a recognized secret. Nothing was shared.",
          preserveRequestId: false,
        };
      }
      return defaultReceipt(input.requestId);
    }
    return {};
  });

  render(
    <BrowserHandoffDialog
      resource={sessionResource}
      accountId="alice"
      serviceOrigin="https://api.example"
      linkOrigin="https://dashboard.example"
      stale={false}
      onClose={vi.fn()}
    />,
  );

  await screen.findByLabelText(/CLAUDE\.md/);

  fireEvent.click(screen.getByRole("button", { name: "Create handoff link" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "hourly limit",
  );

  // Attempts 2-6 share exact requestId with attempt 1
  for (const fragment of [
    "unexpected handoff link",
    "hourly limit",
    "unexpected handoff link",
    "unexpected handoff link",
    "already used for a different handoff",
  ]) {
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect((await screen.findByRole("alert")).textContent).toContain(fragment);
  }

  // Attempt 7 after terminal 409 conflict mints fresh requestId, hits secret alert
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  const secretAlert = await screen.findByRole("alert");
  expect(secretAlert.textContent).toContain("Secret blocked this handoff");
  expect(secretAlert.textContent).toContain("recognized secret");
  expect(secretAlert.textContent).not.toContain("HANDOFF_SECRET:");

  // Attempt 8 after secret alert also mints fresh requestId & succeeds
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByLabelText("Handoff link");

  expect(seenRequestIds).toHaveLength(8);
  expect(new Set(seenRequestIds.slice(0, 6)).size).toBe(1);
  expect(seenRequestIds[6]).not.toBe(seenRequestIds[0]);
  expect(seenRequestIds[7]).not.toBe(seenRequestIds[6]);
  expect(seenRequestIds[7]).not.toBe(seenRequestIds[0]);
});

test("classifies legacy stripped 400 strings and plain message objects without rendering [object Object]", async () => {
  const seenRequestIds: string[] = [];
  let attempt = 0;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "handoff_candidates") return defaultCandidates;
    if (command === "create_handoff") {
      attempt += 1;
      const input = (args as { input: { requestId: string } }).input;
      seenRequestIds.push(input.requestId);
      if (attempt === 1) throw "Invalid request";
      if (attempt === 2) throw "Invalid handoff title";
      if (attempt === 3) throw { message: "400: Bad payload" };
      if (attempt === 4) {
        throw {
          message:
            "The Orka service returned an unexpected handoff link. Nothing was opened.",
        };
      }
      return defaultReceipt(input.requestId);
    }
    return {};
  });

  render(
    <BrowserHandoffDialog
      resource={sessionResource}
      accountId="alice"
      serviceOrigin="https://api.example"
      linkOrigin="https://dashboard.example"
      stale={false}
      onClose={vi.fn()}
    />,
  );

  await screen.findByLabelText(/CLAUDE\.md/);

  fireEvent.click(screen.getByRole("button", { name: "Create handoff link" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Invalid request",
  );

  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Invalid handoff title",
  );

  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  const badPayloadAlert = await screen.findByRole("alert");
  expect(badPayloadAlert.textContent).toContain("400: Bad payload");
  expect(badPayloadAlert.textContent).not.toContain("[object Object]");

  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  const unexpectedAlert = await screen.findByRole("alert");
  expect(unexpectedAlert.textContent).toContain("unexpected handoff link");
  expect(unexpectedAlert.textContent).not.toContain("[object Object]");

  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByLabelText("Handoff link");

  expect(seenRequestIds).toHaveLength(5);
  // Each terminal 400 minted a fresh requestId on the following retry, while attempt 4 preserved for attempt 5.
  expect(seenRequestIds[1]).not.toBe(seenRequestIds[0]);
  expect(seenRequestIds[2]).not.toBe(seenRequestIds[1]);
  expect(seenRequestIds[3]).not.toBe(seenRequestIds[2]);
  expect(seenRequestIds[4]).toBe(seenRequestIds[3]);
});
