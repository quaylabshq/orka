import { describe, expect, it } from "vitest";
import type { ProjectResource } from "../types.js";
import { defaultIndexFilters } from "./index-toolbar.js";
import { applySkillFilters, sortDirection } from "./skill-index.js";
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

describe("applySkillFilters", () => {
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
      applySkillFilters(skills, filters, context()).map(
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
        applySkillFilters(skills, { ...filters, query: "REVIEW" }, context()),
      ),
    ).toEqual(["code-review", "code-review"]);
    expect(
      applySkillFilters(skills, { ...filters, query: "SKILL.md" }, context()),
    ).toEqual([]);
  });

  it("combines categories and allows several options in one", () => {
    const filters = { ...defaultIndexFilters, sort: "title" as const };
    expect(
      titles(
        applySkillFilters(
          skills,
          { ...filters, repositories: ["api"], sharedBy: ["mira"] },
          context(),
        ),
      ),
    ).toEqual(["code-review", "release-notes"]);
    expect(
      titles(
        applySkillFilters(
          skills,
          { ...filters, locations: ["mac"] },
          context(),
        ),
      ),
    ).toEqual(["standup"]);
    expect(
      titles(
        applySkillFilters(
          skills,
          { ...filters, statuses: ["conflict", "local-edits"] },
          context({ standup: "local-edits", "release-notes": "conflict" }),
        ),
      ),
    ).toEqual(["release-notes", "standup"]);
  });

  it("sorts by status with the most urgent first and no status last", () => {
    const filters = { ...defaultIndexFilters, sort: "status" as const };
    expect(
      titles(
        applySkillFilters(
          skills,
          filters,
          context({ standup: "local-edits", "release-notes": "conflict" }),
        ),
      ),
    ).toEqual(["release-notes", "standup", "code-review", "code-review"]);
  });

  it("reads Recently updated newest first unless reversed", () => {
    const filters = { ...defaultIndexFilters, sort: "updated" as const };
    expect(sortDirection(filters)).toBe("desc");
    expect(titles(applySkillFilters(skills, filters, context()))[0]).toBe(
      "standup",
    );
    expect(
      titles(
        applySkillFilters(skills, { ...filters, direction: "asc" }, context()),
      ).at(-1),
    ).toBe("standup");
  });
});
