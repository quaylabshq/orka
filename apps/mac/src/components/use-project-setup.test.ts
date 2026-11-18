import { act, renderHook, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, expect, test, vi } from "vitest";
import { useProjectSetup } from "./use-project-setup.js";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
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
