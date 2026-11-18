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
  expect(inactiveMessage(deleted)).toContain("restored until Jan 31, 2026");
  expect(inactiveMessage(project({ revoked: true }))).toContain(
    "Access to this project was removed",
  );
});

test("export writes the project to the path the user picks", async () => {
  mocks.save.mockResolvedValue("/tmp/orka.zip");
  mocks.invoke.mockResolvedValue(null);
  renderBanner(deleted);
  expect(screen.getByText(inactiveBadge(deleted)!)).toBeTruthy();
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

test("removing from this Mac warns that drafts do not survive a restore", async () => {
  mocks.invoke.mockResolvedValue({ ok: true });
  const run = renderBanner(archived);
  fireEvent.click(screen.getByRole("button", { name: "Remove from this Mac" }));
  expect(
    screen.getByRole("heading", { name: "Remove this project?" }),
  ).toBeTruthy();
  expect(screen.getByText(removalWarning(archived))).toBeTruthy();
  expect(removalWarning(archived)).toContain("local drafts");
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  expect(mocks.invoke).toHaveBeenCalledWith("project_command", {
    action: "remove",
    input: { projectId: "one" },
  });
});
