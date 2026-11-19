import { Profiler } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { Project, ProjectMember, Snapshot } from "../../types.js";
import { LoadingProvider } from "../loading-region.js";
import { WorkspaceCache, WorkspaceCacheProvider } from "../workspace-cache.js";
import { SettingsMembers } from "./settings-members.js";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const project = { id: "project", name: "Project", role: "owner" } as Project;
const member = (id: string, name: string): ProjectMember => ({
  id,
  name,
  role: "member",
});
const catalog = (...members: ProjectMember[]) => ({
  owner: true,
  governed: false,
  policyRevision: 1,
  members,
});
const snapshot = (user: string, members?: ProjectMember[]) =>
  ({
    profile: "work",
    user,
    config: { apiUrl: "https://work.example", syncMinutes: 5 },
    projects: [project],
    governance: members
      ? [{ projectId: project.id, catalog: { access: {}, members } }]
      : [],
  }) as unknown as Snapshot;

let answer: (value: unknown) => void = () => {};
const reads = () =>
  vi
    .mocked(invoke)
    .mock.calls.filter(
      ([name, args]) =>
        name === "governance_command" &&
        (args as { action: string }).action === "catalog",
    );
const loading = () => screen.queryByText("Loading members…");

function Members({
  state,
  open = true,
  currentProject = project,
}: {
  state: Snapshot;
  open?: boolean;
  currentProject?: Project;
}) {
  return (
    <WorkspaceCacheProvider state={state}>
      <LoadingProvider scope={WorkspaceCache.scope(state)}>
        {open && (
          <SettingsMembers
            state={state}
            project={currentProject}
            onReviews={() => {}}
            onLogs={() => {}}
          />
        )}
      </LoadingProvider>
    </WorkspaceCacheProvider>
  );
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation((name) =>
    name === "governance_command"
      ? new Promise((resolve) => {
          answer = resolve;
        })
      : Promise.resolve({ enabled: false }),
  );
});
afterEach(cleanup);

test("Members counts only requests that need this user's decision", async () => {
  render(<Members state={snapshot("alice")} />);
  const request = (id: string, status: string, canReview: boolean) => ({
    id,
    projectId: project.id,
    status,
    canReview,
  });
  await act(async () =>
    answer({
      ...catalog(member("alice", "Alice")),
      requests: [
        request("approved", "approved", true),
        request("rejected", "rejected", true),
        request("waiting", "pending", false),
        request("review", "pending", true),
        { ...request("foreign", "pending", true), projectId: "other" },
        { ...request("env", "pending", true), requestedClass: "env" },
      ],
    }),
  );
  expect(
    await screen.findByRole("button", { name: "Review pending requests (1)" }),
  ).toBeTruthy();
});

test("Members does not offer pending review when all requests are complete or waiting", async () => {
  render(<Members state={snapshot("alice")} />);
  await act(async () =>
    answer({
      ...catalog(member("alice", "Alice")),
      requests: [
        { projectId: project.id, status: "approved", canReview: true },
        { projectId: project.id, status: "rejected", canReview: true },
        { projectId: project.id, status: "pending", canReview: false },
      ],
    }),
  );
  await screen.findByText("Alice");
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: /Review pending requests/ }),
    ).toBeNull(),
  );
});

function deferredCatalogs() {
  const requests: {
    projectId: string;
    resolve: (value: ReturnType<typeof catalog>) => void;
    reject: (error: Error) => void;
  }[] = [];
  vi.mocked(invoke).mockImplementation((name, args) => {
    const input = args as { action?: string; input?: { projectId: string } };
    return name === "governance_command" && input.action === "catalog"
      ? new Promise<ReturnType<typeof catalog>>((resolve, reject) => {
          requests.push({
            projectId: input.input!.projectId,
            resolve,
            reject,
          });
        })
      : Promise.resolve({ enabled: false });
  });
  return requests;
}

test("after a restart, members show from the catalog with no loading state", async () => {
  const stored = [member("alice", "Alice"), member("bob", "Bob")];
  const loadingCommits: boolean[] = [];
  const tree = (open: boolean) => (
    <Profiler id="members" onRender={() => loadingCommits.push(!!loading())}>
      <Members state={snapshot("alice", stored)} open={open} />
    </Profiler>
  );
  const { rerender } = render(tree(true));
  expect(screen.getByText("Alice")).toBeTruthy();
  expect(screen.getByText("Bob")).toBeTruthy();
  expect(reads()).toHaveLength(1);

  await act(async () => answer(catalog(...stored)));
  expect(screen.getByText("Bob")).toBeTruthy();

  expect(
    await screen.findByRole("button", { name: "Invite member" }),
  ).toBeTruthy();

  // Reopening the tab keeps the confirmed list and owner controls on screen
  // while the service is asked again.
  rerender(tree(false));
  rerender(tree(true));
  expect(screen.getByText("Bob")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Invite member" })).toBeTruthy();
  expect(reads()).toHaveLength(2);
  expect(loadingCommits).not.toContain(true);
});

test("the server's member list replaces the stored one", async () => {
  render(
    <Members
      state={snapshot("alice", [
        member("alice", "Alice"),
        member("bob", "Bob"),
      ])}
    />,
  );
  expect(screen.getByText("Bob")).toBeTruthy();

  await act(async () =>
    answer(catalog(member("alice", "Alice"), member("carol", "Carol"))),
  );
  expect(await screen.findByText("Carol")).toBeTruthy();
  expect(screen.queryByText("Bob")).toBeNull();
});

test("members from one user never show for another", async () => {
  const { rerender } = render(
    <Members state={snapshot("alice", [member("alice", "Alice")])} />,
  );
  await act(async () => answer(catalog(member("alice", "Alice"))));
  expect(screen.getByText("Alice")).toBeTruthy();

  rerender(<Members state={snapshot("bob")} />);
  expect(screen.queryByText("Alice")).toBeNull();
  expect(loading()).toBeTruthy();
  expect(reads()).toHaveLength(2);
});

test("a policy change during the initial read obtains the latest catalog", async () => {
  const requests = deferredCatalogs();
  const tree = (policyRevision: number) => (
    <Members
      state={snapshot("alice")}
      currentProject={{ ...project, policyRevision }}
    />
  );
  const { rerender } = render(tree(1));
  expect(requests).toHaveLength(1);
  rerender(tree(2));
  await waitFor(() => expect(requests).toHaveLength(2));

  await act(async () =>
    requests[0].resolve(catalog(member("old", "Old member"))),
  );
  expect(screen.queryByText("Old member")).toBeNull();
  await act(async () =>
    requests[1].resolve({
      ...catalog(member("latest", "Latest member")),
      policyRevision: 2,
    }),
  );
  expect(await screen.findByText("Latest member")).toBeTruthy();
  expect(screen.queryByText("Old member")).toBeNull();
});

test("rapid policy changes cannot replace the latest catalog with an older response", async () => {
  const requests = deferredCatalogs();
  const tree = (policyRevision: number) => (
    <Members
      state={snapshot("alice")}
      currentProject={{ ...project, policyRevision }}
    />
  );
  const { rerender } = render(tree(1));
  rerender(tree(2));
  await waitFor(() => expect(requests).toHaveLength(2));
  rerender(tree(3));
  await waitFor(() => expect(requests).toHaveLength(3));

  await act(async () =>
    requests[2].resolve({
      ...catalog(member("latest", "Latest member")),
      policyRevision: 3,
    }),
  );
  expect(await screen.findByText("Latest member")).toBeTruthy();
  await act(async () => {
    requests[1].resolve(catalog(member("older", "Older member")));
    requests[0].resolve(catalog(member("oldest", "Oldest member")));
  });
  expect(screen.queryByText("Older member")).toBeNull();
  expect(screen.queryByText("Oldest member")).toBeNull();
  expect(screen.getByText("Latest member")).toBeTruthy();
});

for (const dimension of ["user", "profile", "service", "project"] as const)
  test(`a queued policy refresh cannot cross a ${dimension} change`, async () => {
    const requests = deferredCatalogs();
    const original = snapshot("alice");
    const tree = (state: Snapshot, currentProject: Project) => (
      <Members state={state} currentProject={currentProject} />
    );
    const { rerender } = render(
      tree(original, { ...project, policyRevision: 1 }),
    );
    rerender(tree(original, { ...project, policyRevision: 2 }));
    const nextState = {
      ...original,
      ...(dimension === "user" && { user: "bob" }),
      ...(dimension === "profile" && { profile: "personal" }),
      ...(dimension === "service" && {
        config: { apiUrl: "https://personal.example", syncMinutes: 5 },
      }),
    };
    const nextProject = {
      ...project,
      id: dimension === "project" ? "other-project" : project.id,
      policyRevision: 3,
    };
    rerender(tree(nextState, nextProject));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1].projectId).toBe(nextProject.id);
    await act(async () =>
      requests[1].resolve(catalog(member("next", "Next workspace member"))),
    );
    expect(await screen.findByText("Next workspace member")).toBeTruthy();
    await act(async () =>
      requests[0].resolve(catalog(member("old", "Old workspace member"))),
    );
    expect(screen.queryByText("Old workspace member")).toBeNull();
    expect(screen.getByText("Next workspace member")).toBeTruthy();
    expect(requests).toHaveLength(2);
  });

test("a failed policy refresh keeps confirmed members and owner controls", async () => {
  const requests = deferredCatalogs();
  const tree = (policyRevision: number) => (
    <Members
      state={snapshot("alice")}
      currentProject={{ ...project, policyRevision }}
    />
  );
  const { rerender } = render(tree(1));
  await act(async () =>
    requests[0].resolve(catalog(member("alice", "Confirmed member"))),
  );
  expect(
    await screen.findByRole("button", { name: "Invite member" }),
  ).toBeTruthy();
  rerender(tree(2));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(screen.getByText("Confirmed member")).toBeTruthy();
  await act(async () => requests[1].reject(new Error("Service unavailable")));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Couldn’t refresh members.",
  );
  expect(screen.getByText("Confirmed member")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Invite member" })).toBeTruthy();
});
