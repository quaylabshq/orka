import { act, cleanup, renderHook } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Snapshot, SyncQueueEntry } from "../types.js";
import { useWorkspace } from "./use-workspace.js";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

const entry = (projectId: string): SyncQueueEntry => ({
  projectId,
  state: "queued",
  reason: "local",
  attempts: 0,
  notBefore: null,
});

function bridge() {
  let snapshot: Snapshot = {
    profile: "work",
    user: "alice",
    config: { apiUrl: "https://work.example", syncMinutes: 15 },
    projects: [],
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
  const reads: ReturnType<typeof deferred<SyncQueueEntry[]>>[] = [];
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "snapshot") return Promise.resolve(snapshot);
    if (command === "sync_progress")
      return Promise.resolve({ user: snapshot.user, progress: null });
    if (command === "sync_queue_state") {
      const read = deferred<SyncQueueEntry[]>();
      reads.push(read);
      return read.promise;
    }
    return Promise.resolve({});
  });
  return {
    reads,
    switch: (change: Partial<Snapshot>) => {
      snapshot = { ...snapshot, ...change };
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(invoke).mockReset();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

for (const change of [
  { user: "bob" },
  { config: { apiUrl: "https://other.example", syncMinutes: 15 } },
  { profile: "personal" },
] satisfies Partial<Snapshot>[]) {
  test(`queue replies stay in their account, service and profile scope: ${JSON.stringify(change)}`, async () => {
    const native = bridge();
    const observations: {
      scope: string;
      projects: string[];
    }[] = [];
    const { result } = renderHook(() => {
      const workspace = useWorkspace();
      observations.push({
        scope: JSON.stringify([
          workspace.state.profile,
          workspace.state.user,
          workspace.state.config?.apiUrl,
        ]),
        projects: workspace.queue.map((job) => job.projectId),
      });
      return workspace;
    });
    await act(async () => {});
    expect(native.reads).toHaveLength(1);
    await act(async () => native.reads[0].resolve([entry("alice-project")]));
    expect(result.current.queue).toEqual([entry("alice-project")]);

    let earlier: Promise<void> = Promise.resolve();
    act(() => {
      earlier = result.current.refreshQueue();
    });
    const oldRefresh = result.current.refreshQueue;
    expect(native.reads).toHaveLength(2);
    native.switch(change);
    await act(async () => result.current.refresh());
    expect(native.reads).toHaveLength(3);
    expect(result.current.queue).toEqual([]);
    const changedScope = observations.at(-1)?.scope;
    expect(
      observations
        .filter((observation) => observation.scope === changedScope)
        .every(
          (observation) => !observation.projects.includes("alice-project"),
        ),
    ).toBe(true);

    await act(async () => native.reads[2].resolve([entry("current-project")]));
    await act(async () => {
      native.reads[1].resolve([entry("alice-late-project")]);
      await earlier;
    });
    expect(result.current.queue).toEqual([entry("current-project")]);
    await act(async () => oldRefresh());
    expect(native.reads).toHaveLength(3);
  });
}

test("an explicit refresh after Cancel wins over an earlier queue poll", async () => {
  const native = bridge();
  const { result } = renderHook(useWorkspace);
  await act(async () => {});
  expect(native.reads).toHaveLength(1);
  let refresh: Promise<void> = Promise.resolve();
  act(() => {
    refresh = result.current.refreshQueue();
  });
  expect(native.reads).toHaveLength(2);
  await act(async () => {
    native.reads[1].resolve([entry("remaining-project")]);
    await refresh;
  });
  await act(async () => native.reads[0].resolve([entry("cancelled-project")]));
  expect(result.current.queue).toEqual([entry("remaining-project")]);
});

test("unmount invalidates delayed queue replies and stops later refreshes", async () => {
  const native = bridge();
  const { result, unmount } = renderHook(useWorkspace);
  await act(async () => {});
  const refresh = result.current.refreshQueue;
  expect(native.reads).toHaveLength(1);
  unmount();
  const afterUnmount = refresh();
  expect(native.reads).toHaveLength(1);
  await act(async () => native.reads[0].resolve([entry("late-project")]));
  await afterUnmount;
  expect(native.reads).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

test("a post-action snapshot supersedes a delayed read from the previous account", async () => {
  const native = bridge();
  const { result } = renderHook(useWorkspace);
  await act(async () => {});
  const oldSnapshot = result.current.state;
  const pending = deferred<Snapshot>();
  vi.mocked(invoke).mockImplementationOnce(() => pending.promise);
  const oldRead = result.current.refreshSnapshot();
  await act(async () =>
    result.current.run(async () => native.switch({ user: "bob" })),
  );
  expect(result.current.state.user).toBe("bob");
  await act(async () => {
    pending.resolve(oldSnapshot);
    expect(await oldRead).toBeUndefined();
  });
  expect(result.current.state.user).toBe("bob");
});
