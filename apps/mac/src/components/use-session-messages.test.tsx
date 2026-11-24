import { Profiler, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectResource, SessionPage } from "../types.js";
import { ResourceIndex } from "./resource-index.js";
import { defaultIndexFilters } from "./index-pages.js";
import { ToastProvider } from "./toasts.js";
import { WorkspaceCacheProvider } from "./workspace-cache.js";
import { useSessionMessages } from "./use-session-messages.js";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const state = {
  profile: "work",
  user: "alice",
  config: { apiUrl: "https://work.example", syncMinutes: 5 },
};
const page = (...texts: string[]): SessionPage => ({
  messages: texts.map((text, index) => ({ index, role: "user", text })),
  total: texts.length,
  offset: 0,
});

function Sessions({
  contentKey,
  id = "session",
  conflict = "",
  refreshOnMount = false,
}: {
  contentKey: string;
  id?: string;
  conflict?: string;
  refreshOnMount?: boolean;
}) {
  const view = useSessionMessages(id, conflict, contentKey, refreshOnMount);
  if (view.pending && !view.error)
    return <p role="status">Loading messages…</p>;
  return (
    <section aria-busy={view.loading}>
      {view.error && (
        <p role="alert">
          {view.error} <button onClick={view.retry}>Retry</button>
        </p>
      )}
      {view.messages.map((message) => (
        <p key={message.index}>{message.text}</p>
      ))}
      {view.hasMore && <button onClick={view.loadMore}>Show more</button>}
    </section>
  );
}

const reads = () =>
  vi.mocked(invoke).mock.calls.filter(([name]) => name === "session_messages");

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  // The index table follows its list's size, which jsdom never lays out.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("a second visit renders cached turns without a loading state", async () => {
  vi.mocked(invoke).mockResolvedValue(page("First turn"));
  const loadingCommits: boolean[] = [];
  const tree = (visible: boolean, contentKey = "hash-a") => (
    <WorkspaceCacheProvider state={state}>
      <Profiler
        id="sessions"
        onRender={() =>
          loadingCommits.push(Boolean(screen.queryByRole("status")))
        }
      >
        {visible ? <Sessions contentKey={contentKey} /> : <p>Project home</p>}
      </Profiler>
    </WorkspaceCacheProvider>
  );
  const { rerender } = render(tree(true));
  expect(await screen.findByText("First turn")).toBeTruthy();
  expect(reads()).toHaveLength(1);

  rerender(tree(false));
  loadingCommits.length = 0;
  rerender(tree(true));
  expect(screen.getByText("First turn")).toBeTruthy();
  expect(loadingCommits).not.toContain(true);
  expect(reads()).toHaveLength(1);

  let finish: (value: SessionPage) => void = () => {};
  vi.mocked(invoke).mockReturnValueOnce(
    new Promise<SessionPage>((resolve) => {
      finish = resolve;
    }),
  );
  rerender(tree(true, "hash-b"));
  expect(reads()).toHaveLength(2);
  expect(screen.getByText("First turn")).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();

  await act(async () => finish(page("First turn", "Second turn")));
  expect(await screen.findByText("Second turn")).toBeTruthy();
  expect(loadingCommits).not.toContain(true);
});

const resource: ProjectResource = {
  resourceId: "session",
  projectId: "project",
  kind: "session",
  source: "codex",
  title: "Recent session",
  logicalPath: "codex/session",
  deleted: false,
  files: [
    { path: "session.jsonl", hash: "hash-a", size: 100, executable: false },
  ],
  hash: "hash-a",
  revision: 1,
  owner: "alice",
  updatedBy: "alice",
  updatedAt: "2026-01-01",
};

function SessionIndex({ local = false }: { local?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <ToastProvider scope="test">
      <ResourceIndex
        skillSummaries={{}}
        kind="session"
        resources={[{ ...resource, local: local ? true : undefined }]}
        filters={defaultIndexFilters}
        onFilters={() => {}}
        user="alice"
        displayTitle={(item) => item.title}
        connected
        onOpen={() => setOpen(true)}
      />
      {open && <Sessions contentKey="hash-a" refreshOnMount={local} />}
    </ToastProvider>
  );
}

test("opening a local session during prefetch obtains a current native answer", async () => {
  let finishEarlier: (value: SessionPage) => void = () => {};
  vi.mocked(invoke)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finishEarlier = resolve;
      }),
    )
    .mockResolvedValue(page("Latest native turn"));
  render(
    <WorkspaceCacheProvider state={state}>
      <SessionIndex local />
    </WorkspaceCacheProvider>,
  );
  fireEvent.pointerEnter(screen.getByRole("row", { name: /Recent session/ }));
  expect(reads()).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Recent session" }));
  expect(await screen.findByText("Latest native turn")).toBeTruthy();
  expect(reads()).toHaveLength(2);
  await act(async () => finishEarlier(page("Earlier native turn")));
  expect(screen.queryByText("Earlier native turn")).toBeNull();
});

for (const intent of ["pointerEnter", "focus"] as const) {
  test(`${intent} warms the row, deduplicates reads and isolates scopes`, async () => {
    vi.mocked(invoke).mockResolvedValue(page("Warmed turn"));
    const loadingCommits: boolean[] = [];
    const tree = (profile: string) => (
      <WorkspaceCacheProvider state={{ ...state, profile }}>
        <Profiler
          id="intent"
          onRender={() =>
            loadingCommits.push(Boolean(screen.queryByRole("status")))
          }
        >
          <SessionIndex />
        </Profiler>
      </WorkspaceCacheProvider>
    );
    const { rerender } = render(tree("work"));
    const row = screen.getByRole("row", { name: /Recent session/ });
    await act(async () =>
      fireEvent[intent](
        intent === "focus"
          ? screen.getByRole("button", { name: "Recent session" })
          : row,
      ),
    );
    await waitFor(() => expect(reads()).toHaveLength(1));
    await act(async () => fireEvent[intent](row));
    expect(reads()).toHaveLength(1);
    loadingCommits.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "Recent session" }));
    expect(screen.getByText("Warmed turn")).toBeTruthy();
    expect(loadingCommits).not.toContain(true);
    expect(reads()).toHaveLength(1);
    expect(reads()[0]?.[1]).toEqual({
      id: "session",
      conflictId: null,
      offset: 0,
      limit: 40,
    });

    vi.mocked(invoke).mockResolvedValue(page("Other scope turn"));
    rerender(tree("personal"));
    expect(screen.queryByText("Warmed turn")).toBeNull();
    expect(await screen.findByText("Other scope turn")).toBeTruthy();
    expect(reads()).toHaveLength(2);
  });
}

test("a content change refills as many turns as were showing", async () => {
  let version = "a";
  const turns = () =>
    Array.from({ length: 50 }, (_, index) => `Turn ${index}${version}`);
  vi.mocked(invoke).mockImplementation(async (_, args) => {
    const { offset, limit } = args as { offset: number; limit: number };
    return {
      messages: turns()
        .slice(offset, offset + limit)
        .map((text, index) => ({ index: offset + index, role: "user", text })),
      total: 50,
      offset,
    };
  });
  const tree = (contentKey: string) => (
    <WorkspaceCacheProvider state={state}>
      <Sessions contentKey={contentKey} />
    </WorkspaceCacheProvider>
  );
  const { rerender } = render(tree("hash-a"));
  expect(await screen.findByText("Turn 39a")).toBeTruthy();
  expect(screen.queryByText("Turn 40a")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  expect(await screen.findByText("Turn 49a")).toBeTruthy();

  version = "b";
  rerender(tree("hash-b"));
  expect(reads().at(-1)?.[1]).toMatchObject({ offset: 0, limit: 50 });
  expect(await screen.findByText("Turn 49b")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
});

test("a local session reopens cached turns and refreshes its native content", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(page("Earlier native turn"));
  const tree = (visible: boolean, conflict = "") => (
    <WorkspaceCacheProvider state={state}>
      {visible && (
        <Sessions
          contentKey="unchanged-catalog"
          conflict={conflict}
          refreshOnMount
        />
      )}
    </WorkspaceCacheProvider>
  );
  const { rerender } = render(tree(true));
  await screen.findByText("Earlier native turn");
  rerender(tree(false));
  let finish: (value: SessionPage) => void = () => {};
  vi.mocked(invoke).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  rerender(tree(true));
  expect(screen.getByText("Earlier native turn")).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
  expect(reads()).toHaveLength(2);
  await act(async () => finish(page("Earlier native turn", "New native turn")));
  expect(await screen.findByText("New native turn")).toBeTruthy();
});

test("a fixed conflict preview does not revalidate a local session on reopen", async () => {
  vi.mocked(invoke).mockResolvedValue(page("Conflict turn"));
  const tree = (visible: boolean) => (
    <WorkspaceCacheProvider state={state}>
      {visible && (
        <Sessions contentKey="hash" conflict="conflict" refreshOnMount />
      )}
    </WorkspaceCacheProvider>
  );
  const { rerender } = render(tree(true));
  await screen.findByText("Conflict turn");
  rerender(tree(false));
  rerender(tree(true));
  expect(screen.getByText("Conflict turn")).toBeTruthy();
  expect(reads()).toHaveLength(1);
});

test("reopening during an earlier local read obtains a current native answer", async () => {
  let finishEarlier: (value: SessionPage) => void = () => {};
  vi.mocked(invoke)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finishEarlier = resolve;
      }),
    )
    .mockResolvedValue(page("Latest native turn"));
  const tree = (visible: boolean) => (
    <WorkspaceCacheProvider state={state}>
      {visible && <Sessions contentKey="unchanged-catalog" refreshOnMount />}
    </WorkspaceCacheProvider>
  );
  const { rerender } = render(tree(true));
  expect(reads()).toHaveLength(1);
  rerender(tree(false));
  rerender(tree(true));
  expect(await screen.findByText("Latest native turn")).toBeTruthy();
  expect(reads()).toHaveLength(2);
  await act(async () => finishEarlier(page("Earlier native turn")));
  expect(screen.queryByText("Earlier native turn")).toBeNull();
  expect(screen.getByText("Latest native turn")).toBeTruthy();
});

test("reopening replaces an older background read even when turns are cached", async () => {
  let finishEarlier: (value: SessionPage) => void = () => {};
  vi.mocked(invoke)
    .mockResolvedValueOnce(page("Cached native turn"))
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finishEarlier = resolve;
      }),
    )
    .mockResolvedValue(page("Latest native turn"));
  const tree = (visible: boolean) => (
    <WorkspaceCacheProvider state={state}>
      {visible && <Sessions contentKey="unchanged-catalog" refreshOnMount />}
    </WorkspaceCacheProvider>
  );
  const { rerender } = render(tree(true));
  await screen.findByText("Cached native turn");
  rerender(tree(false));
  rerender(tree(true));
  expect(reads()).toHaveLength(2);
  rerender(tree(false));
  rerender(tree(true));
  expect(screen.getByText("Cached native turn")).toBeTruthy();
  expect(await screen.findByText("Latest native turn")).toBeTruthy();
  expect(reads()).toHaveLength(3);
  await act(async () => finishEarlier(page("Earlier background turn")));
  expect(screen.queryByText("Earlier background turn")).toBeNull();
  expect(screen.getByText("Latest native turn")).toBeTruthy();
});

test("a rejected content refresh retains confirmed turns and retries the new version", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(page("Confirmed turn"));
  const tree = (contentKey: string) => (
    <WorkspaceCacheProvider state={state}>
      <Sessions contentKey={contentKey} />
    </WorkspaceCacheProvider>
  );
  const { rerender } = render(tree("hash-a"));
  await screen.findByText("Confirmed turn");
  vi.mocked(invoke).mockRejectedValueOnce(new Error("Native read unavailable"));
  rerender(tree("hash-b"));
  await screen.findByRole("alert");
  expect(screen.getByText("Confirmed turn")).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
  vi.mocked(invoke).mockResolvedValueOnce(page("Updated turn"));
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Updated turn")).toBeTruthy();
  expect(screen.queryByText("Confirmed turn")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

for (const selection of ["session", "conflict", "user"] as const) {
  test(`a failed read never retains another ${selection}'s turns`, async () => {
    vi.mocked(invoke).mockResolvedValueOnce(page("Private earlier turn"));
    const tree = (changed: boolean) => (
      <WorkspaceCacheProvider
        state={{
          ...state,
          user: changed && selection === "user" ? "bob" : "alice",
        }}
      >
        <Sessions
          contentKey="hash"
          id={changed && selection === "session" ? "other-session" : "session"}
          conflict={changed && selection === "conflict" ? "other-conflict" : ""}
        />
      </WorkspaceCacheProvider>
    );
    const { rerender } = render(tree(false));
    await screen.findByText("Private earlier turn");
    vi.mocked(invoke).mockRejectedValueOnce(
      new Error("New selection unavailable"),
    );
    rerender(tree(true));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "New selection unavailable",
      ),
    );
    expect(screen.queryByText("Private earlier turn")).toBeNull();
  });
}
