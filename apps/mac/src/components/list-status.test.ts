import { describe, expect, it } from "vitest";
import type { Binding, ProjectResource, Snapshot } from "../types.js";
import {
  listStatus,
  listStatuses,
  type ListKind,
  type ListStatusInput,
  type ListStatusKey,
} from "./list-status.js";
import { projectAttention, type AttentionItem } from "./sync-attention.js";

const paths: Record<ListKind, string> = {
  session: "claude/sessions/s1.jsonl",
  plan: "claude/files/rollout.md",
  memory: "instructions/AGENTS.md",
};
const item = (
  kind: ListKind,
  extra: Partial<ProjectResource> = {},
): ProjectResource =>
  ({
    resourceId: "a",
    projectId: "p",
    sourceId: "repo",
    kind,
    source: kind === "memory" ? "shared" : "claude",
    title: "a",
    logicalPath: paths[kind],
    owner: "me",
    updatedBy: "me",
    updatedAt: "2026-11-01T00:00:00Z",
    revision: 3,
    ...extra,
  }) as ProjectResource;
const upload = (
  error: string | null,
  extra: Partial<Snapshot["outbox"][number]> = {},
): Snapshot["outbox"][number] => ({
  id: `upload-${error}`,
  project: "p",
  resourceId: "a",
  error,
  ...extra,
});
const attention = (extra: Partial<AttentionItem>): AttentionItem => ({
  key: "a",
  resourceId: "a",
  title: "a",
  messages: [],
  errors: [],
  paths: [],
  requests: [],
  conflicts: [],
  uploads: [],
  ...extra,
});
const readFailure = {
  source: "p:repo:scan:/work/repo/.claude/a",
  error: "Permission denied (os error 13)",
};
const stale =
  "409: Resource changed; refresh and review the exact version again";

/** The parts of an item's data that each make one status hold. */
interface Part {
  resource?: Partial<ProjectResource>;
  conflicted?: boolean;
  uploads?: Snapshot["outbox"];
  errors?: Snapshot["errors"];
  binding?: Binding;
  governed?: boolean;
}
const produces: Record<ListStatusKey, (kind: ListKind) => Part> = {
  conflict: () => ({ conflicted: true }),
  "upload-failed": () => ({ uploads: [upload("503: Service unavailable")] }),
  "could-not-read": () => ({ errors: [readFailure] }),
  "upload-refused": () => ({ uploads: [upload("403: Sharing is disabled")] }),
  "needs-review": (kind) =>
    kind === "plan"
      ? { uploads: [upload(stale, { reviewable: true })] }
      : { governed: true, binding: { installationState: "review_pending" } },
  "waiting-to-sync": () => ({ uploads: [upload(null)] }),
  "local-edits": () => ({ resource: { localChanges: true } }),
};
const input = (kind: ListKind, ...parts: Part[]): ListStatusInput => {
  const errors = parts.flatMap((part) => part.errors ?? []);
  const binding = parts.find((part) => part.binding)?.binding;
  return {
    resource: item(
      kind,
      Object.assign({}, ...parts.map((part) => part.resource)),
    ),
    conflicted: parts.some((part) => part.conflicted),
    uploads: parts.flatMap((part) => part.uploads ?? []),
    attention:
      errors.length || binding ? attention({ errors, binding }) : undefined,
    governed: parts.some((part) => part.governed),
  };
};
const keyOf = (kind: ListKind, ...parts: Part[]) =>
  listStatus(input(kind, ...parts))?.key ?? null;
const kinds: ListKind[] = ["session", "plan", "memory"];

describe("listStatuses", () => {
  it("offers six statuses on Sessions and seven on Plans and Memories, failures first", () => {
    const seven = [
      ["Conflict", "red"],
      ["Upload failed", "red"],
      ["Couldn’t read", "red"],
      ["Upload refused", "amber"],
      ["Needs review", "amber"],
      ["Waiting to sync", "neutral"],
      ["Local edits", "neutral"],
    ];
    const shown = (kind: ListKind) =>
      listStatuses[kind].map(({ label, tone }) => [label, tone]);
    expect(shown("plan")).toEqual(seven);
    expect(shown("memory")).toEqual(seven);
    expect(shown("session")).toEqual(
      seven.filter(([label]) => label !== "Needs review"),
    );
  });
});

describe.each(kinds)("listStatus on a %s", (kind) => {
  const offered = listStatuses[kind].map(({ key }) => key);

  it("shows nothing for a plain shared item or one only on this Mac", () => {
    expect(keyOf(kind)).toBeNull();
    expect(keyOf(kind, { resource: { local: true, revision: 0 } })).toBeNull();
  });

  it.each(offered)("shows %s from its own data", (key) => {
    expect(keyOf(kind, produces[key](kind))).toBe(key);
  });

  const ties = offered.flatMap((first, index) =>
    offered.slice(index + 1).map((second) => [first, second]),
  );
  it.each(ties)("puts %s ahead of %s", (first, second) => {
    expect(keyOf(kind, produces[second](kind), produces[first](kind))).toBe(
      first,
    );
  });
});

describe("listStatus edge cases", () => {
  it("treats 401, 408, and 429 as retryable and other 4xx as refused", () => {
    for (const error of ["401: Sign in", "408: Timeout", "429: Slow down"])
      expect(keyOf("session", { uploads: [upload(error)] })).toBe(
        "upload-failed",
      );
    expect(keyOf("session", { uploads: [upload("413: Too large")] })).toBe(
      "upload-refused",
    );
  });

  it("reads a reviewable 409 on a plan as Needs review, and one the service cannot review as refused", () => {
    expect(
      keyOf("plan", { uploads: [upload(stale, { reviewable: true })] }),
    ).toBe("needs-review");
    expect(keyOf("plan", { uploads: [upload(stale)] })).toBe("upload-refused");
  });

  it("offers memory reviews only for a governed instruction file with a newer shared version", () => {
    const pending = (installationState: string, governed = true) =>
      keyOf("memory", { governed, binding: { installationState } });
    expect(pending("review_pending")).toBe("needs-review");
    expect(pending("update_available")).toBe("needs-review");
    expect(pending("update_available", false)).toBeNull();
    expect(
      keyOf("memory", {
        governed: true,
        binding: { installationState: "update_available" },
        resource: { logicalPath: "claude/memory/notes.md", source: "claude" },
      }),
    ).toBeNull();
    expect(
      keyOf("session", {
        governed: true,
        binding: { installationState: "review_pending" },
      }),
    ).toBeNull();
  });

  it("reads a governed instruction file edited here as Local edits", () => {
    expect(
      keyOf("memory", { binding: { installationState: "locally_modified" } }),
    ).toBe("local-edits");
  });

  it("names read failures from a scan only, and gives other errors no pill", () => {
    const at = (source: string, error: string) => ({
      errors: [{ source, error }],
    });
    expect(keyOf("plan", at(readFailure.source, "Cannot read plan.md"))).toBe(
      "could-not-read",
    );
    expect(
      keyOf(
        "session",
        at(
          readFailure.source,
          `IO error for operation on /work/a.jsonl: ${readFailure.error}`,
        ),
      ),
    ).toBe("could-not-read");
    expect(
      keyOf("plan", at(readFailure.source, "Symlinked files are excluded")),
    ).toBeNull();
    expect(keyOf("plan", at("p:installation:a", readFailure.error))).toBeNull();
    expect(keyOf("session", at("a", "Session exceeds 128 MB"))).toBeNull();
    expect(
      keyOf("memory", {
        ...at(readFailure.source, readFailure.error),
        resource: { logicalPath: "claude/memory/notes.md", source: "claude" },
      }),
    ).toBeNull();
  });
});

describe("listStatus from the project snapshot", () => {
  const snapshot = (overrides: Partial<Snapshot>): Snapshot => ({
    user: "me",
    config: null,
    projects: [{ id: "p", name: "Orka", role: "owner" }],
    resources: [],
    bindings: [],
    conflicts: [],
    activity: [],
    outbox: [],
    errors: [],
    sync: { online: true },
    daemon: { running: true },
    devices: [],
    deviceId: "device",
    background: true,
    ...overrides,
  });
  const statusIn = (state: Snapshot, resource: ProjectResource) =>
    listStatus({
      resource,
      conflicted: state.conflicts.some(
        (conflict) => conflict.resourceId === resource.resourceId,
      ),
      attention: projectAttention(state, "p").items.find(
        (entry) => entry.resourceId === resource.resourceId,
      ),
      uploads: state.outbox.filter(
        (entry) => entry.resourceId === resource.resourceId,
      ),
      governed: true,
    })?.key ?? null;

  it("ties scan read failures to sessions and plans through their bound files, and to instruction files by path", () => {
    const file = "/work/repo/.claude/plans/rollout.md";
    const session = item("session", { resourceId: "s" });
    const plan = item("plan", { resourceId: "f" });
    const embedded = item("plan", {
      resourceId: "e",
      logicalPath: "codex/sessions/thread/plan.md",
      source: "codex",
    });
    const instructions = item("memory", { resourceId: "m" });
    const state = snapshot({
      resources: [session, plan, embedded, instructions],
      bindings: [
        { resourceId: "s", projectId: "p", paths: ["/work/s1.jsonl"] },
        { resourceId: "f", projectId: "p", paths: [file] },
      ],
      errors: [
        { source: "p:repo:scan:/work/s1.jsonl", error: readFailure.error },
        { source: `p:repo:scan:${file}`, error: readFailure.error },
        {
          source: "p:repo:scan:plan:codex/thread/plan.md",
          error: readFailure.error,
        },
        {
          source: "p:repo:scan:instructions/AGENTS.md",
          error: "No such file or directory (os error 2)",
        },
      ],
    });
    for (const resource of [session, plan, embedded, instructions])
      expect(statusIn(state, resource)).toBe("could-not-read");
  });

  it("reads queued uploads with no error, which the attention list drops", () => {
    const plan = item("plan");
    const state = snapshot({ resources: [plan], outbox: [upload(null)] });
    expect(projectAttention(state, "p").items).toEqual([]);
    expect(statusIn(state, plan)).toBe("waiting-to-sync");
  });
});
