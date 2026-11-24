import { describe, expect, it } from "vitest";
import type { ProjectResource } from "../types.js";
import {
  applyPageFilters,
  defaultIndexFilters,
  effectiveFilters,
  filterCategories,
  indexPages,
  sortDirection,
} from "./skill-index.js";
import { listStatuses } from "./list-status.js";
import type { SkillReviewState } from "./skill-review-state.js";
import type { AttentionItem } from "./sync-attention.js";
import { skillStatus, skillStatuses } from "./skill-status.js";

const skill = (
  title: string,
  extra: Partial<ProjectResource> = {},
): ProjectResource =>
  ({
    resourceId: title,
    projectId: "p",
    kind: "skill",
    source: "shared",
    title,
    logicalPath: `${title}/SKILL.md`,
    owner: "mira",
    updatedBy: "mira",
    updatedAt: "2026-11-01T00:00:00Z",
    revision: 1,
    ...extra,
  }) as ProjectResource;

const quiet: SkillReviewState = {
  outgoing: false,
  pending: false,
  incoming: false,
  incomingBlocked: false,
};
const attention = (extra: Partial<AttentionItem>): AttentionItem => ({
  key: "a",
  title: "a",
  messages: [],
  errors: [],
  paths: [],
  requests: [],
  conflicts: [],
  uploads: [],
  ...extra,
});
const status = (key: string) =>
  skillStatuses.find((item) => item.key === key) ?? null;
const context = (statuses: Record<string, string> = {}) => ({
  displayTitle: (item: ProjectResource) => item.title,
  user: "me",
  memberName: (id: string) => (id === "me" ? "You" : id),
  statusOf: (item: ProjectResource) => status(statuses[item.title] ?? ""),
});
const titles = (items: ProjectResource[]) => items.map((item) => item.title);
const skillPage = indexPages.skill;

describe("skillStatus", () => {
  it("shows nothing for a plain shared skill or one only on this Mac", () => {
    const base = { conflicted: false, review: quiet };
    expect(skillStatus({ ...base, resource: skill("a") })).toBeNull();
    expect(
      skillStatus({ ...base, resource: skill("a", { local: true }) }),
    ).toBeNull();
  });

  it("puts a conflict ahead of every other state", () => {
    expect(
      skillStatus({
        resource: skill("a", { localChanges: true }),
        conflicted: true,
        review: { ...quiet, incoming: true },
      })?.key,
    ).toBe("conflict");
  });

  it("maps local sharing states", () => {
    const of = (sharing: ProjectResource["sharing"]) =>
      skillStatus({
        resource: skill("a", { local: true, sharing }),
        conflicted: false,
        review: quiet,
      })?.key;
    expect(of("blocked")).toBe("sharing-blocked");
    expect(of("approval")).toBe("awaiting-approval");
    expect(of("queued")).toBe("sharing-queued");
    expect(of("paused")).toBe("sharing-paused");
  });

  it("maps review states on shared skills", () => {
    const of = (review: Partial<SkillReviewState>, extra = {}) =>
      skillStatus({
        resource: skill("a", extra),
        conflicted: false,
        review: { ...quiet, ...review },
      })?.key;
    expect(of({ incoming: true, incomingBlocked: true })).toBe(
      "update-blocked",
    );
    expect(of({ pending: true })).toBe("awaiting-approval");
    expect(of({ incoming: true })).toBe("update-available");
    expect(
      of({
        incoming: true,
        binding: { installationState: "review_pending" },
      }),
    ).toBe("ready-to-install");
    expect(of({ outgoing: true })).toBe("local-edits");
    expect(of({}, { localChanges: true })).toBe("local-edits");
  });
});

describe("skillStatus with sync attention", () => {
  const upload = (
    id: string,
    error: string,
  ): AttentionItem["uploads"][number] => ({
    id,
    project: "p",
    resourceId: "a",
    error,
  });
  const errorAt = (source: string, error: string) => ({ source, error });
  const blockedUpdate = errorAt(
    "a",
    "Local skill edits preserved; resolve them before applying the shared update",
  );
  const readFailure = errorAt(
    "p:repo:scan:skills/a",
    "Permission denied (os error 13)",
  );
  const of = (
    extra: Partial<ProjectResource>,
    item: Partial<AttentionItem>,
    review: Partial<SkillReviewState> = {},
  ) =>
    skillStatus({
      resource: skill("a", { sourceId: "repo", logicalPath: "a", ...extra }),
      conflicted: false,
      attention: attention(item),
      review: { ...quiet, ...review },
    })?.key;

  it("keeps a sharing block for its own terminal upload and surfaces independent failures", () => {
    const blocked: Partial<ProjectResource> = {
      local: true,
      sharing: "blocked",
    };
    const rejected = upload("share", "403: Skill sharing is disabled");
    const unavailable = upload("other", "503: Service unavailable");
    expect(of(blocked, { uploads: [rejected] })).toBe("sharing-blocked");
    expect(of(blocked, { uploads: [rejected], errors: [readFailure] })).toBe(
      "could-not-read",
    );
    expect(of(blocked, { uploads: [rejected, unavailable] })).toBe(
      "upload-failed",
    );
    for (const sharing of ["queued", "paused", "approval"] as const)
      expect(of({ local: true, sharing }, { uploads: [unavailable] })).toBe(
        "upload-failed",
      );
  });

  it("keeps an update block for its own local edits and surfaces independent failures", () => {
    const review = { incoming: true, incomingBlocked: true };
    expect(of({}, { errors: [blockedUpdate] }, review)).toBe("update-blocked");
    expect(of({}, { errors: [blockedUpdate, readFailure] }, review)).toBe(
      "could-not-read",
    );
    expect(
      of(
        {},
        {
          errors: [blockedUpdate],
          uploads: [upload("share", "503: Service unavailable")],
        },
        review,
      ),
    ).toBe("upload-failed");
  });

  it("names explicit and native scan read failures without mislabeling install and package failures", () => {
    expect(of({}, { errors: [readFailure] })).toBe("could-not-read");
    expect(
      of(
        {},
        {
          errors: [
            errorAt(
              readFailure.source,
              `IO error for operation on /test/a/scripts: ${readFailure.error}`,
            ),
          ],
        },
      ),
    ).toBe("could-not-read");
    expect(
      of(
        {},
        {
          errors: [
            errorAt(
              readFailure.source,
              `Cannot cache SKILL.md: ${readFailure.error}`,
            ),
          ],
        },
      ),
    ).toBe("sync-issue");
    expect(
      of({}, { errors: [errorAt("a", "Cannot read /test/skills/a/SKILL.md")] }),
    ).toBe("could-not-read");
    expect(
      of(
        { local: true },
        {
          errors: [
            errorAt("p:repo:scan:skills/a", "Cannot inspect skill folder"),
          ],
        },
      ),
    ).toBe("could-not-read");
    expect(
      of({}, { errors: [errorAt("p:installation:a", readFailure.error)] }),
    ).toBe("sync-issue");
    expect(
      of(
        {},
        { errors: [errorAt(readFailure.source, "Package contains symlink")] },
      ),
    ).toBe("sync-issue");
  });

  it("puts failures ahead of edits, pending approval, an available update, and suggestions", () => {
    const failure = errorAt("a", "500: Sync service unavailable");
    expect(of({ localChanges: true }, { errors: [failure] })).toBe(
      "sync-issue",
    );
    expect(
      of({}, { errors: [readFailure] }, { incoming: true, pending: true }),
    ).toBe("could-not-read");
    expect(of({}, { errors: [readFailure] }, { incoming: true })).toBe(
      "could-not-read",
    );
    const requests = [{ canReview: true } as AttentionItem["requests"][number]];
    expect(of({}, { requests })).toBe("suggestion");
    expect(of({}, { errors: [failure], requests })).toBe("sync-issue");
  });

  it("offers every status it can produce, and no other", () => {
    expect(skillStatuses.map((item) => item.key)).not.toContain(
      "removed-by-team",
    );
    expect(new Set(skillStatuses.map((item) => item.key)).size).toBe(13);
  });
});

describe("applyPageFilters on Skills", () => {
  const skills = [
    skill("release-notes", { sourceId: "api", repositoryName: "orka-api" }),
    skill("code-review", { sourceId: "app", repositoryName: "orka-public" }),
    skill("code-review-2", {
      title: "code-review",
      resourceId: "dup",
      sourceId: "api",
      repositoryName: "orka-api",
    }),
    skill("standup", {
      local: true,
      owner: "me",
      sourceId: "app",
      repositoryName: "orka-public",
      updatedAt: "2026-11-10T00:00:00Z",
    }),
  ];

  it("sorts by name by default and keeps same-name copies together", () => {
    const filters = { ...defaultIndexFilters, sort: "title" as const };
    expect(
      applyPageFilters(skillPage, skills, filters, context()).map(
        (item) => `${item.title}@${item.repositoryName}`,
      ),
    ).toEqual([
      "code-review@orka-api",
      "code-review@orka-public",
      "release-notes@orka-api",
      "standup@orka-public",
    ]);
  });

  it("searches names only", () => {
    const filters = { ...defaultIndexFilters, sort: "title" as const };
    expect(
      titles(
        applyPageFilters(
          skillPage,
          skills,
          { ...filters, query: "REVIEW" },
          context(),
        ),
      ),
    ).toEqual(["code-review", "code-review"]);
    expect(
      applyPageFilters(
        skillPage,
        skills,
        { ...filters, query: "SKILL.md" },
        context(),
      ),
    ).toEqual([]);
  });

  it("combines categories and allows several options in one", () => {
    const filters = { ...defaultIndexFilters, sort: "title" as const };
    expect(
      titles(
        applyPageFilters(
          skillPage,
          skills,
          { ...filters, picks: { repositories: ["api"], people: ["mira"] } },
          context(),
        ),
      ),
    ).toEqual(["code-review", "release-notes"]);
    expect(
      titles(
        applyPageFilters(
          skillPage,
          skills,
          { ...filters, picks: { locations: ["mac"] } },
          context(),
        ),
      ),
    ).toEqual(["standup"]);
    expect(
      titles(
        applyPageFilters(
          skillPage,
          skills,
          { ...filters, picks: { statuses: ["conflict", "local-edits"] } },
          context({ standup: "local-edits", "release-notes": "conflict" }),
        ),
      ),
    ).toEqual(["release-notes", "standup"]);
  });

  it("sorts by status with the most urgent first and no status last", () => {
    const filters = { ...defaultIndexFilters, sort: "status" as const };
    expect(
      titles(
        applyPageFilters(
          skillPage,
          skills,
          filters,
          context({ standup: "local-edits", "release-notes": "conflict" }),
        ),
      ),
    ).toEqual(["release-notes", "standup", "code-review", "code-review"]);
  });

  it("reads Last updated newest first unless reversed", () => {
    const filters = { ...defaultIndexFilters, sort: "updated" as const };
    expect(sortDirection(filters)).toBe("desc");
    expect(
      titles(applyPageFilters(skillPage, skills, filters, context()))[0],
    ).toBe("standup");
    expect(
      titles(
        applyPageFilters(
          skillPage,
          skills,
          { ...filters, direction: "asc" },
          context(),
        ),
      ).at(-1),
    ).toBe("standup");
  });
});

describe("the memory, session, and plan pages", () => {
  const item = (
    kind: "memory" | "session" | "plan",
    title: string,
    extra: Partial<ProjectResource> = {},
  ) =>
    ({
      ...skill(title),
      kind,
      source: "claude",
      logicalPath: title,
      ...extra,
    }) as ProjectResource;
  const sessions = [
    item("session", "deploy fix", {
      owner: "mira",
      source: "codex",
      sourceId: "api",
      repositoryName: "orka-api",
      logicalPath: "codex/sessions/deploy.jsonl",
      updatedAt: "2026-11-03T00:00:00Z",
    }),
    item("session", "deploy fix, continued", {
      resourceId: "fork",
      owner: "me",
      sourceId: "app",
      repositoryName: "orka-public",
      nativeForkParentId: "deploy fix",
      updatedAt: "2026-11-02T00:00:00Z",
    }),
    item("session", "token audit", {
      local: true,
      owner: "me",
      sourceId: "app",
      repositoryName: "orka-public",
      fork: {
        parentId: "x",
        nativeId: null,
        destination: "desktop",
        createdAt: "2026-11-01T00:00:00Z",
      },
      updatedAt: "2026-11-05T00:00:00Z",
    }),
  ];
  const memories = [
    item("memory", "AGENTS.md", {
      source: "shared",
      logicalPath: "instructions/AGENTS.md",
      owner: "me",
      updatedBy: "mira",
      updatedAt: "2026-11-04T00:00:00Z",
    }),
    item("memory", "MEMORY.md", {
      resourceId: "claude-memory",
      logicalPath: "claude/memory/MEMORY.md",
      owner: "mira",
      updatedBy: "dev",
      updatedAt: "2026-11-06T00:00:00Z",
    }),
    item("memory", "MEMORY.md", {
      resourceId: "codex-memory",
      source: "codex",
      logicalPath: "codex/memories/MEMORY.md",
      local: true,
      owner: "me",
      updatedBy: "me",
      updatedAt: "2026-11-01T00:00:00Z",
    }),
  ];
  const opening = (kind: "memory" | "session" | "plan") => ({
    ...defaultIndexFilters,
    sort: indexPages[kind].defaultSort,
  });
  const run = (
    kind: "memory" | "session" | "plan",
    items: ProjectResource[],
    extra: Partial<typeof defaultIndexFilters> = {},
    statuses: Record<string, string> = {},
  ) =>
    applyPageFilters(
      indexPages[kind],
      items,
      { ...opening(kind), ...extra },
      {
        ...context(),
        statusOf: (resource) =>
          listStatuses.plan.find(
            ({ key }) => key === statuses[resource.resourceId],
          ) ?? null,
      },
    ).map((resource) => resource.resourceId);
  const categoryLabels = (
    kind: keyof typeof indexPages,
    items: ProjectResource[],
  ) =>
    filterCategories(indexPages[kind], items, defaultIndexFilters, {
      user: "me",
      memberName: (id) => (id === "me" ? "You" : id),
    }).map(({ label }) => label);

  it("opens on Last updated, newest first", () => {
    expect(run("session", sessions)).toEqual([
      "token audit",
      "deploy fix",
      "fork",
    ]);
    expect(run("session", sessions, { direction: "asc" })).toEqual([
      "fork",
      "deploy fix",
      "token audit",
    ]);
  });

  it("searches titles, paths, and agents, while Skills keeps names only", () => {
    expect(run("session", sessions, { query: "CODEX" })).toEqual([
      "deploy fix",
    ]);
    expect(run("session", sessions, { query: "deploy.jsonl" })).toEqual([
      "deploy fix",
    ]);
    expect(run("memory", memories, { query: "instructions/" })).toEqual([
      "AGENTS.md",
    ]);
    // A shared memory has no agent to match.
    expect(run("memory", memories, { query: "shared" })).toEqual([]);
    expect(
      applyPageFilters(
        skillPage,
        [skill("deploy", { source: "codex" })],
        { ...defaultIndexFilters, query: "codex" },
        context(),
      ),
    ).toEqual([]);
  });

  it("offers each page its own categories in menu order", () => {
    expect(categoryLabels("session", sessions)).toEqual([
      "Status",
      "Owner",
      "Agent",
      "Repository",
      "Location",
      "Forks",
    ]);
    expect(
      categoryLabels(
        "plan",
        sessions.map(
          (session) => ({ ...session, kind: "plan" }) as ProjectResource,
        ),
      ),
    ).toEqual(["Status", "Owner", "Repository", "Location"]);
    expect(categoryLabels("memory", memories)).toEqual([
      "Status",
      "Updated by",
      "Agent",
      "Location",
      "Kind",
    ]);
    expect(
      categoryLabels("skill", [skill("a"), skill("b", { owner: "me" })]),
    ).toEqual(["Status", "Shared by", "Location"]);
  });

  it("offers Agent only with two agents present, never counting shared items", () => {
    const [instructions, claude] = memories;
    expect(categoryLabels("memory", [instructions, claude])).not.toContain(
      "Agent",
    );
  });

  it("filters by agent, fork, kind, and the person each page credits", () => {
    expect(run("session", sessions, { picks: { agents: ["claude"] } })).toEqual(
      ["token audit", "fork"],
    );
    expect(run("session", sessions, { picks: { forks: ["fork"] } })).toEqual([
      "token audit",
      "fork",
    ]);
    expect(
      run("session", sessions, { picks: { forks: ["original"] } }),
    ).toEqual(["deploy fix"]);
    expect(
      run("memory", memories, { picks: { kinds: ["instruction"] } }),
    ).toEqual(["AGENTS.md"]);
    expect(run("memory", memories, { picks: { kinds: ["memory"] } })).toEqual([
      "claude-memory",
      "codex-memory",
    ]);
    // Memories credit whoever updated them; items only on this Mac credit you.
    expect(run("memory", memories, { picks: { people: ["mira"] } })).toEqual([
      "AGENTS.md",
    ]);
    expect(run("memory", memories, { picks: { people: ["me"] } })).toEqual([
      "codex-memory",
    ]);
    expect(run("session", sessions, { picks: { people: ["me"] } })).toEqual([
      "token audit",
      "fork",
    ]);
    // A page ignores a category it does not offer.
    expect(run("plan", sessions, { picks: { forks: ["fork"] } })).toHaveLength(
      3,
    );
  });

  it("drops a pick whose option is gone", () => {
    const shown = filterCategories(
      indexPages.session,
      sessions,
      { ...defaultIndexFilters, picks: { repositories: ["removed"] } },
      { user: "me", memberName: (id) => id },
    );
    expect(
      run("session", sessions, effectiveFilters(defaultIndexFilters, shown)),
    ).toHaveLength(3);
  });

  it("sorts by status with the most urgent first, and by the credited person", () => {
    expect(
      run(
        "session",
        sessions,
        { sort: "status" },
        { fork: "upload-failed", "token audit": "waiting-to-sync" },
      ),
    ).toEqual(["fork", "token audit", "deploy fix"]);
    expect(run("memory", memories, { sort: "author" })).toEqual([
      "claude-memory",
      "AGENTS.md",
      "codex-memory",
    ]);
  });

  it("names each sort and its directions for the page", () => {
    const sorts = (kind: keyof typeof indexPages) =>
      indexPages[kind].sorts.map(({ label, directions }) => [
        label,
        ...directions,
      ]);
    const list = [
      ["Last updated", "Oldest first", "Newest first"],
      ["Name", "A to Z", "Z to A"],
      ["Status", "Most urgent first", "Least urgent first"],
      ["Repository", "A to Z", "Z to A"],
    ];
    expect(sorts("session")).toEqual([...list, ["Owner", "A to Z", "Z to A"]]);
    expect(sorts("plan")).toEqual([...list, ["Owner", "A to Z", "Z to A"]]);
    expect(sorts("memory")).toEqual([
      ...list,
      ["Updated by", "A to Z", "Z to A"],
    ]);
    expect(sorts("skill").map(([label]) => label)).toEqual([
      "Name",
      "Status",
      "Repository",
      "Shared by",
      "Last updated",
    ]);
  });

  it("groups list statuses by tone in the Filter menu", () => {
    expect(indexPages.plan.statuses.map(({ group }) => group)).toEqual([
      "red",
      "red",
      "red",
      "amber",
      "amber",
      "neutral",
      "neutral",
    ]);
    expect(indexPages.session.statuses.map(({ label }) => label)).not.toContain(
      "Needs review",
    );
  });
});
