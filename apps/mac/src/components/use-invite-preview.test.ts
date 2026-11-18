import { act, renderHook, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, expect, test, vi } from "vitest";
import { inviteExpiredOrUsedMessage } from "./project-invite.js";
import { useInvitePreview } from "./use-invite-preview.js";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const token = "ab".repeat(24);

afterEach(() => {
  vi.resetAllMocks();
});

test("a usable invite names the project and when it expires", async () => {
  vi.mocked(invoke).mockResolvedValue({
    status: "available",
    projectName: "Acme",
    expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
  });
  const { result } = renderHook(() =>
    useInvitePreview(token, "https://acme.example"),
  );
  expect(result.current).toBeUndefined();
  await waitFor(() => expect(result.current?.title).toBe("Join Acme"));
  expect(result.current?.expires).toBe("Expires in 3 days.");
  expect(result.current?.unavailable).toBe(false);
  expect(invoke).toHaveBeenCalledWith("invite_preview", {
    token,
    serviceUrl: "https://acme.example",
  });
});

test("an unusable invite shows the expired or used line and blocks joining", async () => {
  vi.mocked(invoke).mockResolvedValue({ status: "unavailable" });
  const { result } = renderHook(() => useInvitePreview(token, ""));
  await waitFor(() => expect(result.current?.unavailable).toBe(true));
  expect(result.current?.title).toBe("Join project");
  expect(result.current?.error).toBe(inviteExpiredOrUsedMessage);
});

test("an older server or a network failure keeps today's dialog", async () => {
  for (const reply of [
    () => Promise.resolve({ status: "unsupported" }),
    () => Promise.reject(new Error("404: Not found")),
    () =>
      Promise.reject(new Error("Cloud unavailable; local work stays queued")),
    () => Promise.resolve({}),
  ]) {
    vi.mocked(invoke).mockImplementation(reply);
    const { result, unmount } = renderHook(() => useInvitePreview(token, ""));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(invoke).toHaveBeenCalledWith("invite_preview", { token });
    expect(result.current).toBeUndefined();
    unmount();
  }
});
