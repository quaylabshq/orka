import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Snapshot, WorkspaceResource } from "../types.js";
import {
  DesktopUsageProvider,
  DesktopUsageScreen,
  useDesktopFeature,
  type DesktopScreen,
} from "./desktop-usage.js";
import { useResourceActions } from "./use-resource-actions.js";
import { useConnectProject } from "./use-project-setup.js";

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
  open: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => native);
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: native.open }));

const origin = "https://api.tryorka.ai";
const alice = {
  user: "alice",
  config: { apiUrl: origin, syncMinutes: 5, mode: "cloud" },
} satisfies Pick<Snapshot, "user" | "config">;
let focused = true;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  focused = true;
  native.isTauri.mockReturnValue(true);
  native.invoke.mockImplementation(async () => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  native.invoke.mockReset();
  native.isTauri.mockReset();
  native.open.mockReset();
});

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function page(
  screen: DesktopScreen,
  state: Pick<Snapshot, "user" | "config"> = alice,
) {
  return (
    <DesktopUsageProvider state={state}>
      <DesktopUsageScreen screen={screen} />
    </DesktopUsageProvider>
  );
}

function batches() {
  return native.invoke.mock.calls
    .filter(([command]) => command === "record_desktop_usage")
    .map(([, args]) => args);
}

test("keeps meaningful foreground screen transitions and suppresses rapid or repeated visits", async () => {
  const app = render(page("screen:projects"));
  await advance(1_000);
  app.rerender(page("screen:projects"));
  await advance(2_000);
  app.rerender(page("screen:settings"));
  await advance(300);
  app.rerender(page("screen:sessions"));
  await advance(1_000);
  app.rerender(page("screen:projects"));
  await advance(3_000);

  expect(batches().flatMap(({ events }) => events)).toEqual([
    "screen:projects",
    "screen:sessions",
    "screen:projects",
  ]);
});

test("restarts dwell when foreground focus returns and discards a batch on account change", async () => {
  const app = render(page("screen:projects"));
  await advance(400);
  focused = false;
  fireEvent.blur(window);
  await advance(2_000);
  expect(batches()).toEqual([]);

  focused = true;
  fireEvent.focus(window);
  await advance(750);
  app.rerender(page("screen:members", { ...alice, user: "bob" }));
  await advance(2_500);

  expect(batches()).toEqual([
    { accountId: "bob", serviceOrigin: origin, events: ["screen:members"] },
  ]);
});

test("collects no usage for browser sessions or explicit self-hosted configurations", async () => {
  native.isTauri.mockReturnValue(false);
  const browser = render(page("screen:projects"));
  await advance(2_500);
  browser.unmount();

  native.isTauri.mockReturnValue(true);
  render(
    page("screen:projects", {
      ...alice,
      config: { ...alice.config, mode: "self-hosted" },
    }),
  );
  await advance(2_500);
  expect(batches()).toEqual([]);
});

test("keeps a single bounded batch and drops completed actions from an old account", async () => {
  const app = renderHook(() => useDesktopFeature(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <DesktopUsageProvider state={alice}>{children}</DesktopUsageProvider>
    ),
  });
  const actions = Array.from({ length: 50 }, () =>
    app.result.current("feature:skill_imported"),
  );
  actions.forEach((finish) => finish());
  actions[0]();
  await advance(1_000);
  expect(batches()).toEqual([]);
  await advance(1_000);
  expect(batches()).toEqual([
    {
      accountId: "alice",
      serviceOrigin: origin,
      events: Array.from({ length: 16 }, () => "feature:skill_imported"),
    },
  ]);

  const old = app.result.current("feature:memory_shared");
  app.unmount();
  old();
  await advance(3_000);
  expect(batches()).toHaveLength(1);
});

test("limits an account to 60 events across sign-outs and resets at UTC midnight", async () => {
  vi.setSystemTime(new Date("2030-06-15T12:00:00Z"));
  const state = { ...alice, user: "metered" };
  const trackAccount = () =>
    renderHook(() => useDesktopFeature(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <DesktopUsageProvider state={state}>{children}</DesktopUsageProvider>
      ),
    });
  const app = trackAccount();
  for (let batch = 0; batch < 4; batch += 1) {
    for (let event = 0; event < 16; event += 1)
      app.result.current("feature:skill_imported")();
    await advance(1_250);
  }
  expect(batches().map(({ events }) => events.length)).toEqual([
    16, 16, 16, 12,
  ]);
  app.unmount();

  const signedInAgain = trackAccount();
  signedInAgain.result.current("feature:memory_shared")();
  await advance(1_250);
  expect(batches()).toHaveLength(4);

  vi.setSystemTime(new Date("2030-06-16T00:00:00Z"));
  signedInAgain.result.current("feature:memory_shared")();
  await advance(1_250);
  expect(batches().at(-1)?.events).toEqual(["feature:memory_shared"]);
});

test("reserves room for successful actions after an account reaches its screen limit", async () => {
  const state = { ...alice, user: "frequent-navigation" };
  function Visit({ screen }: { screen: DesktopScreen }) {
    const startFeature = useDesktopFeature();
    return (
      <>
        <DesktopUsageScreen screen={screen} />
        <button
          type="button"
          onClick={() => startFeature("feature:settings_saved")()}
        >
          Save
        </button>
      </>
    );
  }
  const visit = (screen: DesktopScreen) => (
    <DesktopUsageProvider state={state}>
      <Visit screen={screen} />
    </DesktopUsageProvider>
  );
  const app = render(visit("screen:logs"));
  await advance(3_000);
  for (let i = 1; i < 50; i += 1) {
    app.rerender(visit(i % 2 ? "screen:envs" : "screen:logs"));
    await advance(3_000);
  }
  fireEvent.click(app.getByRole("button", { name: "Save" }));
  await advance(1_250);
  const events = batches().flatMap(({ events }) => events);
  expect(events).toHaveLength(46);
  expect(events.at(-1)).toBe("feature:settings_saved");
});

test("reports a source connection only after native confirms a new local binding", async () => {
  const app = renderHook(() => useConnectProject(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <DesktopUsageProvider state={alice}>{children}</DesktopUsageProvider>
    ),
  });
  native.open.mockResolvedValueOnce(null);
  expect(await app.result.current("private-project")).toBe(false);
  expect(native.invoke).not.toHaveBeenCalled();

  native.open.mockResolvedValue("/private/folder");
  native.invoke
    .mockResolvedValueOnce(false)
    .mockRejectedValueOnce(new Error("Rejected source path"))
    .mockResolvedValueOnce(true);
  expect(await app.result.current("private-project")).toBe(true);
  await expect(app.result.current("private-project")).rejects.toThrow(
    "Rejected source path",
  );
  expect(await app.result.current("private-project")).toBe(true);
  await advance(1_250);
  expect(batches()).toEqual([
    {
      accountId: "alice",
      serviceOrigin: origin,
      events: ["feature:source_connected"],
    },
  ]);
});

const resource = {
  kind: "session",
  resourceId: "private-session",
  source: "codex",
  owner: "alice",
  title: "Private title",
  revision: 1,
  hash: "private-hash",
} as WorkspaceResource;

test("records a confirmed launch when the reader changes before it finishes", async () => {
  let finish = () => {};
  const launched = new Promise((resolve) => {
    finish = () => resolve({ opened: true });
  });
  native.invoke.mockImplementation(async (command) => {
    if (command === "resume_session") return launched;
  });
  const onNotice = vi.fn();
  const actions = renderHook(
    ({ revision }) =>
      useResourceActions({
        act: async (action) => {
          await action();
        },
        resource: { ...resource, revision },
        user: "alice",
        onNotice,
        scope: "private-project",
      }),
    {
      initialProps: { revision: 1 },
      wrapper: ({ children }: { children: ReactNode }) => (
        <DesktopUsageProvider state={alice}>{children}</DesktopUsageProvider>
      ),
    },
  );
  let resume = Promise.resolve();
  act(() => {
    resume = actions.result.current.resume();
  });
  actions.rerender({ revision: 2 });
  await act(async () => {
    finish();
    await resume;
  });
  await advance(1_250);
  expect(onNotice).not.toHaveBeenCalled();
  expect(batches().flatMap(({ events }) => events)).toEqual([
    "feature:session_resumed",
  ]);
});

test.each([
  [{ opened: true }, undefined, false, "feature:session_resumed"],
  [
    { opened: false, manualCommand: "private command" },
    undefined,
    false,
    false,
  ],
  [{ opened: true, handoff: "private path" }, undefined, false, false],
  [{ opened: true }, "iterm2", false, false],
  [{ opened: true }, undefined, true, false],
  [{ opened: true, forked: true }, undefined, true, "feature:session_forked"],
  [{ opened: true, forked: true }, undefined, false, "feature:session_resumed"],
] as const)(
  "only reports a confirmed session resume or explicit fork from the foreground",
  async (reply, destination, fork, reported) => {
    native.invoke.mockImplementation(async (command) => {
      if (command === "resume_session") {
        // A real app launch can transfer focus before native confirms it.
        focused = false;
        return reply;
      }
    });
    const actions = renderHook(
      () =>
        useResourceActions({
          act: async (action) => {
            await action();
          },
          resource,
          user: "alice",
          onNotice: () => {},
          scope: "private-project",
        }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <DesktopUsageProvider state={alice}>{children}</DesktopUsageProvider>
        ),
      },
    );
    const target = destination
      ? { tool: "codex" as const, destination }
      : undefined;
    await act(async () => {
      await actions.result.current.resume(target, fork);
    });
    await advance(2_000);
    expect(batches()).toEqual(
      reported
        ? [
            {
              accountId: "alice",
              serviceOrigin: origin,
              events: [reported],
            },
          ]
        : [],
    );
  },
);
