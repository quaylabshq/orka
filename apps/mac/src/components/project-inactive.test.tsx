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
  inactiveReason,
  inactiveMessage,
  removalWarning,
} from "./project-inactive.js";
import { ToastProvider, ToastViewport } from "./toasts.js";

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
const deadline = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
}).format(new Date(deleted.purgeAfter!));

function renderBanner(value: Project) {
  const run = vi.fn(async (action: () => Promise<unknown>) => {
    await action();
  });
  render(
    <ToastProvider scope="test">
      <InactiveProject project={value} busy={false} run={run} />
      <ToastViewport modal />
    </ToastProvider>,
  );
  return run;
}

test("each inactive state uses its current lifecycle status", () => {
  expect(inactiveReason(archived)).toBe("archived");
  expect(inactiveReason(deleted)).toBe("deleted");
  expect(
    inactiveReason(
      project({ deletedAt: "2026-01-01T00:00:00Z", purged: true }),
    ),
  ).toBe("purged");
  expect(
    inactiveReason(
      project({ revoked: true, detachedAt: "2026-01-02T00:00:00Z" }),
    ),
  ).toBe("removed");
  expect(inactiveReason(project({}))).toBeNull();
  expect(inactiveMessage(archived)).toContain("archived by its owner");
  expect(inactiveMessage(deleted)).toContain(
    `Sync can resume if the project is restored by ${deadline}.`,
  );
  expect(inactiveMessage({ ...deleted, heldChanges: 3 })).toContain(
    `3 changes are queued to sync if restored by ${deadline}.`,
  );
  expect(inactiveMessage({ ...deleted, heldChanges: 1 })).toContain(
    `1 change is queued to sync if restored by ${deadline}.`,
  );
  expect(inactiveMessage({ ...deleted, heldChanges: 0 })).not.toContain(
    "queued to sync",
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
    expect(inactiveReason({ ...previous, revoked: true })).toBe("removed");
    expect(
      inactiveMessage({ ...previous, detachedAt: "2026-02-01T00:00:00Z" }),
    ).toContain("Access to this project was removed");
  }
  expect(inactiveReason({ ...deleted, purged: true, revoked: true })).toBe(
    "purged",
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

test("a cached export warns that recent edits may be missing", async () => {
  mocks.save.mockResolvedValue("/tmp/orka.zip");
  mocks.invoke.mockResolvedValue(true);
  renderBanner(deleted);
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  expect(
    await screen.findByText(
      "Saved content exported. Recent edits may be missing.",
    ),
  ).toBeTruthy();
});

test("the removal warning counts all pending changes, not just restorable uploads", () => {
  renderBanner({
    ...deleted,
    heldChanges: 1,
    pendingChanges: 2,
    pendingEnvPublications: 1,
  });
  fireEvent.click(screen.getByRole("button", { name: "Remove from this Mac" }));
  expect(
    screen.getByRole("dialog", { name: "Remove from this Mac?" }),
  ).toBeTruthy();
  expect(screen.getByText(/2 pending changes on this Mac/)).toBeTruthy();
  expect(
    screen.getByText(/The export excludes 1 encrypted ENV publication/),
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
    "3 pending changes on this Mac.",
  );
  expect(removalWarning({ ...deleted, pendingChanges: 1 })).toContain(
    "1 pending change on this Mac.",
  );
  expect(removalWarning(deleted)).not.toContain("encrypted ENV");
  expect(removalWarning(archived)).not.toContain("encrypted ENV");
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  expect(mocks.invoke).toHaveBeenCalledWith("project_command", {
    action: "remove",
    input: { projectId: "one" },
  });
});
