import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { Project } from "../../types.js";
import { restorableUntil, SettingsDanger } from "./settings-danger.js";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const project = {
  id: "project",
  name: "Orka",
  role: "owner",
  lifecycleRevision: 4,
  policyRevision: 4,
} as Project;
const memberProject = { ...project, role: "member" } as Project;
const deleted = {
  id: "deleted",
  name: "Old project",
  role: "owner",
  deletedAt: "2026-01-01T00:00:00Z",
  purgeAfter: "2026-02-14T12:00:00Z",
  lifecycleRevision: 6,
} as Project;
const run = (action: () => Promise<unknown>) => action();

const renderDanger = (
  options: {
    project?: Project;
    deletedProjects?: Project[];
    members?: number | null;
    command?: (name: string, args: unknown) => Promise<unknown>;
  } = {},
) => {
  vi.mocked(invoke).mockImplementation(async (name, args) => {
    if (options.command) return options.command(name, args);
    if (name === "governance_command")
      return {
        members: Array.from({ length: options.members ?? 0 }, (_, id) => ({
          id: String(id),
        })),
      };
    return { ok: true };
  });
  return render(
    <SettingsDanger
      project={options.project}
      deletedProjects={options.deletedProjects ?? []}
      members={options.members ?? null}
      busy={false}
      run={run}
    />,
  );
};

const openDelete = async (members = 3) => {
  renderDanger({ project, members });
  const danger = screen.getByRole("region", { name: "Danger zone" });
  within(danger).getByRole("button", { name: "Delete project" }).click();
  const dialog = await screen.findByRole("dialog");
  await screen.findByText(new RegExp(`The ${members} members`));
  return {
    dialog,
    field: within(dialog).getByRole("textbox", { name: "Project name" }),
    confirm: within(dialog).getByRole("button", { name: "Delete project" }),
  };
};

afterEach(cleanup);

test("delete requires the exact project name and shows the restore date", async () => {
  const { dialog, field, confirm } = await openDelete();
  expect(dialog.textContent).toContain(
    `It can be restored until ${restorableUntil()}.`,
  );
  expect((confirm as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(field, { target: { value: "Orka" } });
  await waitFor(() =>
    expect((confirm as HTMLButtonElement).disabled).toBe(false),
  );
});

test("owners get archive and delete but not leave", () => {
  renderDanger({ project });
  const danger = screen.getByRole("region", { name: "Danger zone" });
  expect(
    within(danger).getByRole("button", { name: "Archive project" }),
  ).toBeTruthy();
  expect(
    within(danger).getByRole("button", { name: "Delete project" }),
  ).toBeTruthy();
  expect(
    within(danger).queryByRole("button", { name: "Leave project" }),
  ).toBeNull();
});

test("members can leave without typing the name", async () => {
  renderDanger({ project: memberProject });
  const danger = screen.getByRole("region", { name: "Danger zone" });
  expect(
    within(danger).queryByRole("button", { name: "Delete project" }),
  ).toBeNull();
  within(danger).getByRole("button", { name: "Leave project" }).click();
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain("lose access");
  expect(dialog.textContent).toContain("other members stay");
  expect(within(dialog).queryByRole("textbox")).toBeNull();
  within(dialog).getByRole("button", { name: "Leave project" }).click();
  await waitFor(() =>
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("project_command", {
      action: "leave",
      input: { projectId: "project", expectedPolicyRevision: 4 },
    }),
  );
});

test("a refused leave keeps the message in the open dialog", async () => {
  renderDanger({
    project: memberProject,
    command: async (name, args) => {
      if (name === "governance_command")
        return { members: [], policyRevision: 4 };
      if (
        name === "project_command" &&
        (args as { action?: string }).action === "leave"
      )
        throw new Error(
          "Sync queued changes and finish pending ENV publications before leaving this project",
        );
      return { ok: true };
    },
  });
  const danger = screen.getByRole("region", { name: "Danger zone" });
  within(danger).getByRole("button", { name: "Leave project" }).click();
  const dialog = await screen.findByRole("dialog");
  within(dialog).getByRole("button", { name: "Leave project" }).click();
  expect(
    await within(dialog).findByText(/before leaving this project/),
  ).toBeTruthy();
  expect(screen.getByRole("dialog")).toBe(dialog);
});

test("an owner refusal points to transferring ownership from Members", async () => {
  renderDanger({
    project: memberProject,
    command: async (name, args) => {
      if (name === "governance_command")
        return { members: [], policyRevision: 4 };
      if (
        name === "project_command" &&
        (args as { action?: string }).action === "leave"
      )
        throw new Error("403: Transfer ownership before leaving");
      return { ok: true };
    },
  });
  const danger = screen.getByRole("region", { name: "Danger zone" });
  within(danger).getByRole("button", { name: "Leave project" }).click();
  const dialog = await screen.findByRole("dialog");
  within(dialog).getByRole("button", { name: "Leave project" }).click();
  expect(
    await within(dialog).findByText(
      /Transfer ownership to another member from Members first/,
    ),
  ).toBeTruthy();
});

test("a refused delete keeps the dialog open with the service message", async () => {
  const { dialog, field, confirm } = await openDelete();
  vi.mocked(invoke).mockRejectedValueOnce(
    new Error(
      "Sync queued changes and finish pending ENV publications before deleting this project",
    ),
  );
  fireEvent.change(field, { target: { value: "Orka" } });
  await waitFor(() =>
    expect((confirm as HTMLButtonElement).disabled).toBe(false),
  );
  confirm.click();
  expect(await within(dialog).findByText(/Sync queued changes/)).toBeTruthy();
  expect(screen.getByRole("dialog")).toBe(dialog);
});

test("recently deleted projects restore from the owner list", async () => {
  renderDanger({ deletedProjects: [deleted] });
  const list = screen.getByRole("region", { name: "Recently deleted" });
  expect(within(list).getByText("Old project")).toBeTruthy();
  expect(
    within(list).getByText(
      `Restorable until ${restorableUntil(deleted.purgeAfter)}`,
    ),
  ).toBeTruthy();
  within(list).getByRole("button", { name: "Restore" }).click();
  await waitFor(() =>
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("project_command", {
      action: "restore",
      input: {
        projectId: "deleted",
        requestId: expect.any(String),
        expectedRevision: 6,
      },
    }),
  );
});
