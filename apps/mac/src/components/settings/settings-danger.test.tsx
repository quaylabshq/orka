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
    archivedProjects?: Project[];
    softDelete?: number;
    projectRestoreWindowDays?: number;
    members?: number | null;
    command?: (name: string, args: unknown) => Promise<unknown>;
  } = {},
) => {
  vi.mocked(invoke).mockImplementation(async (name, args) => {
    if (options.command) return options.command(name, args);
    if (
      name === "project_command" &&
      (args as { action?: string })?.action === "capabilities"
    )
      return {
        softDelete: options.softDelete ?? 1,
        projectRestoreWindowDays: options.projectRestoreWindowDays ?? 7,
      };
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
      archivedProjects={options.archivedProjects ?? []}
      members={options.members ?? null}
      busy={false}
      run={run}
    />,
  );
};

const openDelete = async (members = 3) => {
  renderDanger({ project, members });
  const danger = screen.getByRole("region", { name: "Danger zone" });
  const deleting = within(danger).getByRole("button", {
    name: "Delete project",
  });
  await waitFor(() =>
    expect((deleting as HTMLButtonElement).disabled).toBe(false),
  );
  deleting.click();
  const dialog = await screen.findByRole("dialog");
  await screen.findByText(new RegExp(`The ${members} members`));
  return {
    dialog,
    field: within(dialog).getByRole("textbox", { name: "Project name" }),
    confirm: within(dialog).getByRole("button", { name: "Delete project" }),
  };
};

afterEach(cleanup);

test("delete requires the exact project name and uses the server restore policy", async () => {
  const { dialog, field, confirm } = await openDelete();
  expect(dialog.textContent).toContain(
    "This service keeps deleted projects for 7 days.",
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
  expect(dialog.textContent).toContain("on all your devices");
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

test("restore progress belongs to its project and a failure keeps recovery available", async () => {
  let rejectRestore: (error: Error) => void = () => {};
  const restoring = new Promise((_, reject) => {
    rejectRestore = reject;
  });
  renderDanger({
    deletedProjects: [
      deleted,
      { ...deleted, id: "another", name: "Another project" },
    ],
    command: async (_, args) => {
      if ((args as { action: string }).action === "restore") return restoring;
      return { softDelete: 1, projectRestoreWindowDays: 7 };
    },
  });
  const buttons = within(
    screen.getByRole("region", { name: "Recently deleted" }),
  ).getAllByRole("button", { name: "Restore" });
  fireEvent.click(buttons[0]);
  await waitFor(() =>
    expect(buttons[0].getAttribute("aria-busy")).toBe("true"),
  );
  expect(buttons[1].getAttribute("aria-busy")).toBe("false");
  for (const button of buttons)
    expect((button as HTMLButtonElement).disabled).toBe(true);
  rejectRestore(new Error("Offline. Try restoring again when connected."));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Offline. Try restoring again when connected.",
  );
  await waitFor(() =>
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(false),
  );
  expect(buttons[0].getAttribute("aria-busy")).toBe("false");
});

test("an older service cannot offer recoverable deletion", async () => {
  renderDanger({ project, softDelete: 0 });
  await screen.findByText(/Update this service/);
  const deleting = screen.getByRole("button", { name: "Delete project" });
  expect((deleting as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(deleting);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("missing deadlines never fabricate a restore date", () => {
  expect(restorableUntil()).toBeNull();
  expect(restorableUntil("invalid")).toBeNull();
});

test("a failed member lookup keeps the account-wide consequence accurate", async () => {
  renderDanger({
    project,
    command: async (name) => {
      if (name === "governance_command") throw new Error("Offline");
      return { softDelete: 1, projectRestoreWindowDays: 7 };
    },
  });
  const deleting = screen.getByRole("button", { name: "Delete project" });
  await waitFor(() =>
    expect((deleting as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(deleting);
  const dialog = await screen.findByRole("dialog");
  await waitFor(() =>
    expect(dialog.textContent).toContain(
      "All members of this project will lose access.",
    ),
  );
  expect(dialog.textContent).not.toContain("The 1 member");
});

test("archived owner projects can be restored without an active project", async () => {
  renderDanger({
    archivedProjects: [{ ...project, archivedAt: "2026-01-01T00:00:00Z" }],
  });
  const region = screen.getByRole("region", { name: "Archived projects" });
  fireEvent.click(within(region).getByRole("button", { name: "Restore" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("project_command", {
      action: "restore",
      input: {
        projectId: "project",
        requestId: expect.any(String),
        expectedRevision: 4,
      },
    }),
  );
});

test("deletion stays disabled until the service confirms support", async () => {
  let confirmSupport: (value: unknown) => void = () => {};
  const capability = new Promise((resolve) => {
    confirmSupport = resolve;
  });
  renderDanger({ project, command: async () => capability });
  const deleting = screen.getByRole("button", { name: "Delete project" });
  expect((deleting as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Checking deletion support/)).toBeTruthy();
  confirmSupport({ softDelete: 1, projectRestoreWindowDays: 7 });
  await waitFor(() =>
    expect((deleting as HTMLButtonElement).disabled).toBe(false),
  );
});

test("failed capability checks can be retried before deletion", async () => {
  let attempts = 0;
  renderDanger({
    project,
    command: async () => {
      if (attempts++ === 0) throw new Error("Offline");
      return { softDelete: 1, projectRestoreWindowDays: 7 };
    },
  });
  const deleting = screen.getByRole("button", { name: "Delete project" });
  await screen.findByText(/Could not check project deletion support/);
  expect((deleting as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /^Retry$/ }));
  await waitFor(() =>
    expect((deleting as HTMLButtonElement).disabled).toBe(false),
  );
  expect(
    screen.queryByText(/Could not check project deletion support/),
  ).toBeNull();
});
