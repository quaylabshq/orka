import { act, renderHook, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, expect, test, vi } from "vitest";
import { useProjectSetup } from "./use-project-setup.js";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    constructor(readonly onmessage: (value: unknown) => void) {}
  },
}));
vi.mock("./toasts.js", () => ({ useToastNotice: () => vi.fn() }));

const token = "ab".repeat(24);
const available = {
  status: "available",
  projectName: "Correct service",
  expiresAt: "2027-01-02T03:04:05.000Z",
};

afterEach(() => vi.resetAllMocks());

test("a legacy invite refreshes its preview when the configured service changes", async () => {
  let configuredService = "https://old.example";
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command !== "invite_preview") return {};
    const service =
      (args as { serviceUrl?: string }).serviceUrl ?? configuredService;
    return service === "https://old.example"
      ? { status: "unavailable" }
      : available;
  });
  const { result, rerender } = renderHook(
    ({ apiUrl }) => useProjectSetup(vi.fn(), vi.fn(), apiUrl),
    { initialProps: { apiUrl: "https://old.example" } },
  );
  await act(async () => result.current.show("join", `orka://join/${token}`));
  await waitFor(() => expect(result.current.invite?.unavailable).toBe(true));

  configuredService = "https://correct.example";
  rerender({ apiUrl: configuredService });
  await waitFor(() =>
    expect(result.current.invite?.title).toBe("Join Correct service"),
  );
  expect(result.current.invite?.unavailable).toBe(false);
  expect(invoke).toHaveBeenCalledWith("invite_preview", {
    token,
    serviceUrl: "https://correct.example",
  });
});

test("a service-bound invite keeps its own preview service when the configured service changes", async () => {
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "invite_preview" ? available : {},
  );
  const { result, rerender } = renderHook(
    ({ apiUrl }) => useProjectSetup(vi.fn(), vi.fn(), apiUrl),
    { initialProps: { apiUrl: "https://old.example" } },
  );
  await act(async () =>
    result.current.show("join", `https://invite.example/join/${token}`),
  );
  await waitFor(() => expect(result.current.invite?.unavailable).toBe(false));
  rerender({ apiUrl: "https://correct.example" });
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "invite_preview"),
  ).toEqual([
    ["invite_preview", { token, serviceUrl: "https://invite.example" }],
  ]);
});

type Progress = { onmessage: (value: { waiting: boolean }) => void };

/** Holds `cloud_action` like a busy workspace until the test releases it. */
function busyWorkspace() {
  let release: (outcome: { id: string } | Error) => void = () => {};
  let progress: Progress | undefined;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command !== "cloud_action") return {};
    progress = (args as { onProgress: Progress }).onProgress;
    progress.onmessage({ waiting: true });
    return new Promise((resolve, reject) => {
      release = (outcome) => {
        if (outcome instanceof Error) return reject(outcome);
        progress?.onmessage({ waiting: false });
        resolve(outcome);
      };
    });
  });
  return { release: (outcome: { id: string } | Error) => release(outcome) };
}

test("one Create click waits for sync and then opens the project", async () => {
  const workspace = busyWorkspace();
  const onProject = vi.fn();
  const { result } = renderHook(() => useProjectSetup(onProject, vi.fn()));
  await act(async () => result.current.show("create"));
  act(() => result.current.setInput("Atlas"));
  let submitted: Promise<void> = Promise.resolve();
  act(() => {
    submitted = result.current.submit();
  });
  await waitFor(() => expect(result.current.waiting).toBe(true));
  expect(result.current.dialog).toBe("create");
  expect(result.current.input).toBe("Atlas");

  await act(async () => {
    workspace.release({ id: "p1" });
    await submitted;
  });
  expect(onProject).toHaveBeenCalledWith("p1");
  expect(result.current.dialog).toBeNull();
  expect(result.current.waiting).toBe(false);
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "cloud_action"),
  ).toHaveLength(1);
});

test("cancelling while waiting for sync closes the dialog without an error", async () => {
  const workspace = busyWorkspace();
  const onProject = vi.fn();
  const onError = vi.fn();
  const { result } = renderHook(() => useProjectSetup(onProject, onError));
  await act(async () => result.current.show("create"));
  act(() => result.current.setInput("Atlas"));
  let submitted: Promise<void> = Promise.resolve();
  act(() => {
    submitted = result.current.submit();
  });
  await waitFor(() => expect(result.current.waiting).toBe(true));

  act(() => result.current.cancelWait());
  expect(result.current.cancelling).toBe(true);
  expect(invoke).toHaveBeenCalledWith("cancel_project_setup");
  await act(async () => {
    workspace.release(new Error("Cancelled while waiting for sync to finish."));
    await submitted;
  });
  expect(result.current.dialog).toBeNull();
  expect(onProject).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalledWith(
    expect.stringContaining("Cancelled"),
  );
});
