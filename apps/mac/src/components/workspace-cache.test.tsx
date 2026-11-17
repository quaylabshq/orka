import { Profiler, StrictMode, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { Resource } from "@portable/protocol";
import type { Inspection } from "../types.js";
import { WorkspaceCache, WorkspaceCacheProvider } from "./workspace-cache.js";
import { useResourceView } from "./use-resource-view.js";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const state = {
  profile: "work",
  user: "alice",
  config: { apiUrl: "https://work.example", syncMinutes: 5 },
};
const resource: Resource = {
  resourceId: "resource",
  projectId: "project",
  kind: "skill",
  source: "shared",
  logicalPath: "skill",
  title: "Skill",
  files: [{ path: "SKILL.md", hash: "file-hash", size: 10, executable: false }],
  deleted: false,
  hash: "resource-hash",
  revision: 1,
  owner: "alice",
  updatedBy: "alice",
  updatedAt: "2026-01-01T00:00:00Z",
};
const inspection = (content: string): Inspection => ({
  content,
  previous: null,
  paths: null,
});

type WorkspaceState = Parameters<typeof WorkspaceCacheProvider>[0]["state"];

function Reader({ workspace = state }: { workspace?: WorkspaceState }) {
  const view = useResourceView(
    resource.resourceId,
    resource,
    [],
    WorkspaceCache.scope(workspace),
  );
  return view.inspection ? (
    <p>{view.inspection.content}</p>
  ) : (
    <p role="status">Loading inspection…</p>
  );
}

function WorkspacePage({ workspace }: { workspace: WorkspaceState }) {
  const [reading, setReading] = useState(false);
  return reading ? (
    <section role="dialog" aria-label="Skill reader">
      <Reader workspace={workspace} />
    </section>
  ) : (
    <button onClick={() => setReading(true)}>Read skill</button>
  );
}

test("keeps the selected page and open dialog while clearing workspace data", async () => {
  vi.mocked(invoke).mockResolvedValue(inspection("Alice's skill"));
  const tree = (workspace: WorkspaceState) => (
    <WorkspaceCacheProvider state={workspace}>
      <WorkspacePage workspace={workspace} />
    </WorkspaceCacheProvider>
  );
  const { rerender } = render(tree(state));
  fireEvent.click(screen.getByRole("button", { name: "Read skill" }));
  expect(await screen.findByText("Alice's skill")).toBeTruthy();

  vi.mocked(invoke).mockResolvedValue(inspection("Bob's skill"));
  rerender(tree({ ...state, user: "bob" }));
  expect(screen.getByRole("dialog", { name: "Skill reader" })).toBeTruthy();
  expect(screen.queryByText("Alice's skill")).toBeNull();
  expect(await screen.findByText("Bob's skill")).toBeTruthy();
});

test("discards an inspection that finishes after switching workspace", async () => {
  let finish: (value: Inspection) => void = () => {};
  vi.mocked(invoke).mockReturnValueOnce(
    new Promise<Inspection>((resolve) => {
      finish = resolve;
    }),
  );
  const tree = (user: string) => (
    <WorkspaceCacheProvider state={{ ...state, user }}>
      <Reader workspace={{ ...state, user }} />
    </WorkspaceCacheProvider>
  );
  const { rerender } = render(tree("alice"));
  expect(screen.getByRole("status")).toBeTruthy();

  vi.mocked(invoke).mockResolvedValue(inspection("Bob's skill"));
  rerender(tree("bob"));
  expect(await screen.findByText("Bob's skill")).toBeTruthy();
  await act(async () => finish(inspection("Alice's late skill")));
  expect(screen.queryByText("Alice's late skill")).toBeNull();
  expect(screen.getByText("Bob's skill")).toBeTruthy();

  vi.mocked(invoke).mockImplementation(() => new Promise(() => {}));
  rerender(tree("alice"));
  expect(screen.queryByText("Alice's late skill")).toBeNull();
  expect(screen.getByRole("status")).toBeTruthy();
});

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});
afterEach(cleanup);

test("shows cached inspection immediately on remount without a loading state", async () => {
  vi.mocked(invoke).mockResolvedValue(inspection("Saved skill"));
  const loadingCommits: boolean[] = [];
  const tree = (visible: boolean) => (
    <StrictMode>
      <WorkspaceCacheProvider state={state}>
        <Profiler
          id="inspection"
          onRender={() =>
            loadingCommits.push(Boolean(screen.queryByRole("status")))
          }
        >
          {visible && <Reader />}
        </Profiler>
      </WorkspaceCacheProvider>
    </StrictMode>
  );
  const { rerender } = render(tree(true));
  expect(await screen.findByText("Saved skill")).toBeTruthy();

  rerender(tree(false));
  loadingCommits.length = 0;
  vi.mocked(invoke).mockImplementation(() => new Promise(() => {}));
  rerender(tree(true));

  expect(screen.getByText("Saved skill")).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
  expect(loadingCommits).not.toContain(true);
});

test.each([
  ["profile", { ...state, profile: "personal" }],
  [
    "service",
    { ...state, config: { ...state.config, apiUrl: "https://other.example" } },
  ],
  ["user", { ...state, user: "bob" }],
  ["sign-out", { ...state, user: null }],
])(
  "clears cached inspection on %s change, including when returning",
  async (_, next) => {
    vi.mocked(invoke).mockResolvedValue(inspection("Alice's skill"));
    const tree = (workspace: typeof next) => (
      <WorkspaceCacheProvider state={workspace}>
        {workspace.user && <Reader workspace={workspace} />}
      </WorkspaceCacheProvider>
    );
    const { rerender } = render(tree(state));
    expect(await screen.findByText("Alice's skill")).toBeTruthy();

    vi.mocked(invoke).mockImplementation(() => new Promise(() => {}));
    rerender(tree(next));
    expect(screen.queryByText("Alice's skill")).toBeNull();
    if (next.user) expect(screen.getByRole("status")).toBeTruthy();

    rerender(tree(state));
    expect(screen.queryByText("Alice's skill")).toBeNull();
    expect(screen.getByRole("status")).toBeTruthy();
  },
);
