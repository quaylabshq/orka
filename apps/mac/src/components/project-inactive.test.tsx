import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Project } from "../types.js";
import { InactiveProject } from "./inactive-project.js";
import {
  inactiveBadge,
  inactiveMessage,
  removalWarning,
} from "./project-inactive.js";
import { ToastProvider } from "./toasts.js";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: mocks.save }));

afterEach(() => {
  cleanup();
  mocks.invoke.mockReset();
  mocks.save.mockReset();
});

function project(extra: Partial<Project>): Project {
  return { id: "one", name: "Orka", role: "member", ...extra };
}
const archived = project({ archivedAt: "2026-01-01T00:00:00Z" });
const deleted = project({
  deletedAt: "2026-01-01T00:00:00Z",
  purgeAfter: "2026-01-31T00:00:00Z",
});

function renderBanner(value: Project) {
  const run = vi.fn(async (action: () => Promise<unknown>) => {
    await action();
  });
  render(
    <ToastProvider scope="test">
      <InactiveProject project={value} busy={false} run={run} />
    </ToastProvider>,
  );
  return run;
}

test("each inactive state gets its own sidebar badge", () => {
  expect(inactiveBadge(archived)).toBe("Archived by owner");
  expect(inactiveBadge(deleted)).toBe(
    "Deleted by owner, restorable until Jan 31, 2026",
  );
  expect(
    inactiveBadge(project({ deletedAt: "2026-01-01T00:00:00Z", purged: true })),
  ).toBe("Deleted");
  expect(
    inactiveBadge(
      project({ revoked: true, detachedAt: "2026-01-02T00:00:00Z" }),
    ),
  ).toBe("Access removed");
  expect(inactiveBadge(project({}))).toBeNull();
  expect(inactiveBadge(project({ deletedAt: "2026-01-01T00:00:00Z" }))).toBe(
    "Deleted by owner",
  );
  expect(inactiveMessage(archived)).toContain("archived by its owner");
  expect(inactiveMessage(deleted)).toBe(
    "This project is deleted by its owner. Orka keeps capturing your changes on this Mac. Changes are uploaded if restored by Jan 31, 2026, kept as local drafts if not.",
  );
  expect(inactiveMessage({ ...deleted, heldChanges: 3 })).toContain(
    "3 held, uploaded if restored by Jan 31, 2026, kept as local drafts if not.",
  );
  expect(inactiveMessage({ ...deleted, heldChanges: 1 })).toContain(
    "1 held, uploaded if restored by Jan 31, 2026",
  );
  expect(inactiveMessage({ ...deleted, heldChanges: 0 })).toContain(
    "Changes are uploaded if restored by Jan 31, 2026",
  );
  // A server before 0.7.4 sends no purgeAfter, so capture is off and the old
  // sentence stays.
  expect(inactiveMessage(project({ deletedAt: "2026-01-01T00:00:00Z" }))).toBe(
    "This project is deleted by its owner.",
  );
  expect(inactiveMessage(project({ revoked: true }))).toContain(
    "Access to this project was removed",
  );
  for (const previous of [archived, deleted]) {
    expect(inactiveBadge({ ...previous, revoked: true })).toBe(
      "Access removed",
    );
    expect(
      inactiveMessage({ ...previous, detachedAt: "2026-02-01T00:00:00Z" }),
    ).toContain("Access to this project was removed");
  }
  expect(inactiveBadge({ ...deleted, purged: true, revoked: true })).toBe(
    "Deleted",
  );
});

test("export writes the project to the path the user picks", async () => {
  mocks.save.mockResolvedValue("/tmp/orka.zip");
  mocks.invoke.mockResolvedValue(null);
  renderBanner(deleted);
  expect(screen.getByRole("heading", { name: "Sync paused" })).toBeTruthy();
  expect(screen.getByText(inactiveMessage(deleted))).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("export_project", {
      projectId: "one",
      destination: "/tmp/orka.zip",
    }),
  );
  // A dismissed save dialog keeps the project where it is.
  mocks.save.mockResolvedValue(null);
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2));
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
});

test("the removal warning counts all pending changes, not just restorable uploads", () => {
  renderBanner({ ...deleted, heldChanges: 1, pendingChanges: 2 });
  fireEvent.click(screen.getByRole("button", { name: "Remove from this Mac" }));
  expect(
    screen.getByRole("dialog", { name: "Remove from this Mac?" }),
  ).toBeTruthy();
  expect(
    screen.getByText(/2 changes held on this Mac will be lost\./),
  ).toBeTruthy();
});

test("removing from this Mac explains export and retained local drafts", async () => {
  mocks.invoke.mockResolvedValue({ ok: true });
  const run = renderBanner(archived);
  fireEvent.click(screen.getByRole("button", { name: "Remove from this Mac" }));
  expect(
    screen.getByRole("dialog", { name: "Remove from this Mac?" }),
  ).toBeTruthy();
  expect(screen.getByText(removalWarning(deleted))).toBeTruthy();
  expect(removalWarning(deleted)).toContain("Export first");
  expect(removalWarning(deleted)).toContain(
    "Saved local drafts and your project folders stay on disk",
  );
  expect(removalWarning({ ...deleted, pendingChanges: 3 })).toContain(
    "3 changes held on this Mac will be lost.",
  );
  expect(removalWarning({ ...deleted, pendingChanges: 1 })).toContain(
    "1 change held on this Mac will be lost.",
  );
  expect(removalWarning(deleted)).not.toContain("will be lost");
  expect(removalWarning(archived)).not.toContain("will be lost");
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  expect(mocks.invoke).toHaveBeenCalledWith("project_command", {
    action: "remove",
    input: { projectId: "one" },
  });
});
