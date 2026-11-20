import type { Page } from "@playwright/test";

// Synthetic project for the Skills index: shared and local skills in every
// status, several repository layouts, roles, and a set of global skills.
export type SkillsScene = {
  /** How many shared skills the project holds. */
  count?: number;
  role?: "owner" | "admin" | "member";
  sync?: "progress" | "pending" | "failed" | "uptodate";
  /** Every write or desktop command fails. */
  failActions?: boolean;
  governed?: boolean;
  access?: "publish" | "suggest" | "read" | "hidden";
  disconnected?: boolean;
  offline?: boolean;
  /** true is two connected repositories; the rest vary names and folders. */
  repositories?:
    boolean | "duplicate" | "many" | "partial" | "none" | "removed";
  accessRequest?: "pending" | "roleBased";
  /** Local skills, one per sharing status. */
  locals?: boolean;
  conflict?: boolean;
  /** Bindings and drafts that put shared skills into review states. */
  review?: boolean;
  usage?: "ok" | "hold" | "error" | "partial";
  summaries?: "ok" | "hold";
  extremes?: boolean;
  scan?: "ok" | "hold" | "error" | "partial" | "empty";
  globalUsage?: "ok" | "hold" | "error";
  add?: "ok" | "hold" | "error" | "partial";
};

export async function skillsIndexFixture(page: Page, scene: SkillsScene = {}) {
  // The dev-only annotation toolbar is not part of the product.
  await page.route(/annotation-tools/, (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: "export default () => null;",
    }),
  );
  await page.addInitScript((scene) => {
    const user = "user";
    const mate = "mira";
    const catalog: [string, string, string][] = [
      [
        "code-review",
        "Review a diff for correctness bugs, risky changes, and missing tests before it merges.",
        "claude",
      ],
      [
        "pr-polish",
        "Review, fix, and re-review a branch in a bounded loop until it is merge-ready.",
        "claude",
      ],
      [
        "issue-investigate",
        "Reproduce an issue, find the root cause, and recommend a scoped fix with evidence.",
        "codex",
      ],
      [
        "release-notes",
        "Draft release notes from merged pull requests, grouped by what users will notice.",
        "shared",
      ],
      [
        "ux-copy",
        "Write and shorten product copy using the approved terminology and voice.",
        "claude",
      ],
      [
        "design-review",
        "Check a screen against the design system: tokens, spacing, states, and accessibility.",
        "shared",
      ],
      [
        "migration-writer",
        "Write a reversible database migration with a backfill plan and a rollback note.",
        "codex",
      ],
      [
        "test-writer",
        "Add behavior-focused tests that fail on the base branch and pass on the fix.",
        "codex",
      ],
      [
        "api-contract-check",
        "Compare a change against the public API contract and flag breaking differences.",
        "shared",
      ],
      [
        "incident-summary",
        "Turn an incident channel into a timeline, impact statement, and follow-up list.",
        "claude",
      ],
      [
        "changelog",
        "Keep the changelog current from commit history, in the house format.",
        "shared",
      ],
      [
        "dependency-upgrade",
        "Upgrade one dependency, read its changelog, and fix what the upgrade breaks.",
        "codex",
      ],
      [
        "accessibility-audit",
        "Audit a page for keyboard, focus, contrast, and screen reader problems.",
        "claude",
      ],
      [
        "docs-page",
        "Write a docs page in the accepted reading layout with tested examples.",
        "shared",
      ],
      [
        "onboarding-check",
        "Walk the first-run flow and report every place a new user could get stuck.",
        "claude",
      ],
      [
        "perf-profile",
        "Profile a slow interaction and name the three changes with the largest effect.",
        "codex",
      ],
      [
        "security-review",
        "Review a change for injection, secrets, and unsafe file or network access.",
        "claude",
      ],
      [
        "flaky-test-triage",
        "Find why a test is flaky and either fix the cause or quarantine it with a reason.",
        "codex",
      ],
      [
        "sql-explain",
        "Explain a query plan in plain language and suggest the index that helps.",
        "shared",
      ],
      [
        "team-update",
        "Draft a short team update grounded in merged work and open decisions.",
        "claude",
      ],
      [
        "figma-handoff",
        "Turn a Figma frame into an implementation note with tokens and states.",
        "shared",
      ],
      [
        "commit-message",
        "Write a commit message that says what changed and why.",
        "codex",
      ],
      [
        "env-setup",
        "Set up a new machine for this project and verify each tool works.",
        "shared",
      ],
      [
        "i18n-check",
        "Find hard-coded strings and layouts that break when text grows.",
        "claude",
      ],
      [
        "log-reader",
        "Read a log excerpt and separate the first failure from its consequences.",
        "codex",
      ],
      [
        "spec-writer",
        "Turn a rough idea into a one-page spec with scope and open questions.",
        "claude",
      ],
      [
        "refactor-plan",
        "Plan a refactor as small, separately shippable steps.",
        "codex",
      ],
      [
        "support-reply",
        "Draft a support reply that answers the question and names the next step.",
        "shared",
      ],
      [
        "data-backfill",
        "Write and dry-run a backfill script with progress output and a resume point.",
        "codex",
      ],
      [
        "screenshot-evidence",
        "Capture before and after screenshots for a pull request.",
        "shared",
      ],
    ];
    const count = scene.count ?? 30;
    const binding = (name: string) => ({
      provider: "github",
      owner: "quaylabs",
      name,
    });
    const sourceList: any[] =
      scene.repositories === "duplicate"
        ? [
            { id: "a1b2c3d4e5", name: "orka", path: "/test/orka" },
            { id: "f6a7b8c9d0", name: "orka", path: "/test/forks/orka" },
            { id: "website", name: "website", path: "/test/website" },
          ]
        : scene.repositories === "many"
          ? [
              "desktop",
              "backend",
              "website",
              "docs",
              "infrastructure-and-deployment-scripts",
              "design-system",
              "mobile",
              "data-pipelines-and-analytics-warehouse",
            ].map((id) => ({ id, name: id, path: `/test/${id}` }))
          : scene.repositories === "partial"
            ? [
                {
                  id: "desktop",
                  name: "desktop",
                  path: "/test/desktop",
                  repository: binding("desktop"),
                },
                {
                  id: "backend",
                  name: "backend",
                  path: null,
                  folderState: "locate",
                  repository: binding("backend"),
                },
              ]
            : scene.repositories === "none"
              ? ["desktop", "backend"].map((id) => ({
                  id,
                  name: id,
                  path: null,
                  folderState: "locate",
                  repository: binding(id),
                }))
              : scene.repositories === "removed"
                ? [
                    { id: "desktop", name: "desktop", path: "/test/desktop" },
                    { id: "backend", name: "backend", path: "/test/backend" },
                    {
                      id: "legacy",
                      name: "legacy",
                      path: null,
                      removedAt: "2026-11-01T00:00:00Z",
                    },
                  ]
                : ["desktop", "backend"].map((id) => ({
                    id,
                    name: id,
                    path: `/test/${id}`,
                  }));
    const repos = sourceList.map((source) => source.id);
    const make = (index: number) => {
      const [name, description, source] = catalog[index % catalog.length];
      const title =
        index < catalog.length
          ? name
          : `${name}-${Math.floor(index / catalog.length) + 1}`;
      return {
        resourceId: `skill-${index}`,
        projectId: "one",
        kind: "skill",
        source,
        title,
        description,
        logicalPath: `skills/${title}`,
        // In the removed scene every sixth skill has no repository at all.
        sourceId: !scene.repositories
          ? undefined
          : scene.repositories === "removed" && index % 6 === 5
            ? undefined
            : scene.repositories === "many" && index % 5 === 4
              ? repos[7]
              : repos[
                  index % (scene.repositories === "many" ? 6 : repos.length)
                ],
        revision: 3,
        deleted: false,
        hash: `hash-${index}`,
        owner: index % 3 ? mate : user,
        updatedBy: index % 3 ? mate : user,
        updatedAt: new Date(Date.UTC(2026, 10, 18 - index, 10)).toISOString(),
        global: index === 4 || index === 11 || undefined,
        files: [
          {
            path: "SKILL.md",
            hash: `md-${index}`,
            size: 100,
            executable: false,
          },
        ],
      };
    };
    const shared: any[] = Array.from({ length: count }, (_, index) =>
      make(index),
    );
    if (scene.extremes) {
      shared[0] = {
        ...shared[0],
        title:
          "issue-investigate-followup-for-community-pull-requests-and-root-cause-verification",
        description:
          "Act on an issue-investigate report: find the pull requests that already address it, judge whether each can solve the root cause, then build on the best community PR when it is even directionally right, or open a draft PR of our own only when every candidate is wrong. Plans and implements with the code-quality skill and gates every push on checks.",
      };
      shared[1] = { ...shared[1], description: "" };
      shared[2] = { ...shared[2], description: null };
    }
    const sharings = [undefined, "queued", "approval", "paused", "blocked"];
    const locals = scene.locals
      ? sharings.map((sharing, index) => ({
          ...make(index),
          resourceId: `local-${index}`,
          title: [
            "standup-notes",
            "bug-repro",
            "launch-checklist",
            "customer-digest",
            "schema-review",
          ][index],
          description:
            "Imported on this Mac and not shared with the project yet.",
          logicalPath: `skills/local-${index}`,
          source: "shared",
          revision: 0,
          local: true,
          global: index === 1 || undefined,
          sharing,
          owner: user,
          updatedBy: user,
        }))
      : [];
    const bindings = scene.review
      ? [
          {
            base: { ...shared[0], revision: 2 },
            paths: [],
            installationState: "update_available",
            availableRevision: 3,
          },
          {
            base: { ...shared[1], revision: 3 },
            paths: [],
            installationState: "locally_modified",
            availableRevision: 3,
          },
          {
            base: { ...shared[2], revision: 2 },
            paths: [],
            installationState: "locally_modified",
            availableRevision: 3,
          },
          {
            base: { ...shared[3], revision: 3 },
            paths: [],
            installationState: "current",
            availableRevision: 3,
          },
        ]
      : [];
    const drafts = scene.review
      ? [
          {
            id: "draft-3",
            projectId: "one",
            resource: shared[3],
            status: "proposed",
            createdAt: "2026-11-17T09:00:00Z",
          },
          {
            id: "draft-5",
            projectId: "one",
            resource: shared[5],
            status: "rejected",
            createdAt: "2026-11-17T09:00:00Z",
          },
        ]
      : [];
    const accessMode = scene.access ?? "publish";
    const access = {
      mode: accessMode,
      canShare: true,
      create: accessMode,
      governed: true,
      policyRevision: 1,
    };
    const classes = [
      "instructions",
      "memory",
      "plan",
      "session",
      "skill",
      "env",
    ];
    const governanceCatalog = {
      owner: scene.role !== "member",
      governed: true,
      policyRevision: 1,
      policy: {},
      access: Object.fromEntries(classes.map((key) => [key, access])),
      members: [],
      memberRules: [],
      resourceCount: count,
      requests: [],
      ...(scene.accessRequest === "roleBased"
        ? { rolePolicies: { member: {} } }
        : {}),
    };
    const globals = [
      {
        id: "g-review",
        name: "review",
        sources: ["codex"],
        markdown:
          "---\nname: Code review\ndescription: Review changes with supporting scripts and references.\n---\n# Review",
        fileCount: 3,
      },
      {
        id: "g-writing",
        name: "writing",
        sources: ["claude"],
        markdown:
          "---\nname: Writing guide\ndescription: Write clear product copy in the house voice.\n---\n# Writing",
        fileCount: 1,
      },
      {
        id: "g-existing",
        name: "release-notes",
        sources: ["codex", "claude"],
        markdown:
          "---\nname: Release notes\ndescription: Draft release notes from merged pull requests.\n---\n# Notes",
        fileCount: 2,
        exists: true,
      },
      {
        id: "g-unsafe",
        name: "unsafe",
        sources: ["claude"],
        markdown: "",
        fileCount: 0,
        error: "Package contains symlink",
      },
      ...catalog.slice(8, 22).map(([name, description, source], index) => ({
        id: `g-${index}`,
        name,
        sources: [source === "shared" ? "codex" : source],
        markdown: `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}`,
        fileCount: 1 + (index % 4),
      })),
    ].map((skill: any) => ({
      exists: false,
      error: null,
      ...skill,
      path: `/Users/test/.${skill.sources[0]}/skills/${skill.name}`,
    }));
    let added = false;
    const hold = (key: string) =>
      new Promise<void>((resolve) => {
        (window as any)[key] = resolve;
      });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => {} },
    });
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: async (name: string, args: Record<string, any> = {}) => {
          if (name === "snapshot")
            return {
              user,
              config: { apiUrl: "https://test.local", syncMinutes: 15 },
              projects: [
                {
                  id: "one",
                  name: "Orka",
                  role: scene.role ?? "owner",
                  governed: scene.governed || undefined,
                  rolePolicies:
                    scene.accessRequest === "roleBased"
                      ? { member: {} }
                      : undefined,
                  path: scene.repositories
                    ? null
                    : scene.disconnected
                      ? null
                      : "/test/orka",
                  sources: scene.repositories ? sourceList : undefined,
                },
              ],
              resources: accessMode === "hidden" ? [] : shared,
              localSkills: locals,
              bindings,
              drafts,
              governance: scene.governed
                ? [{ projectId: "one", catalog: governanceCatalog }]
                : [],
              conflicts: scene.conflict
                ? [
                    {
                      id: "conflict-1",
                      resourceId: "skill-2",
                      author: mate,
                      deviceId: "other",
                      candidate: shared[2],
                      revision: 3,
                    },
                  ]
                : [],
              reviewRequests:
                scene.accessRequest === "pending"
                  ? [
                      {
                        id: "access-1",
                        projectId: "one",
                        author: user,
                        type: "access",
                        status: "pending",
                        requestedClass: "skill",
                        createdAt: "2026-11-18T09:00:00Z",
                      },
                    ]
                  : [],
              activity: [],
              outbox:
                scene.sync === "pending"
                  ? [
                      {
                        id: "out-1",
                        project: "one",
                        error: null,
                        resourceId: "skill-1",
                        title: "pr-polish",
                        kind: "skill",
                      },
                    ]
                  : scene.sync === "failed"
                    ? [
                        {
                          id: "out-1",
                          project: "one",
                          error: "Upload rejected: file too large",
                          resourceId: "skill-1",
                          title: "pr-polish",
                          kind: "skill",
                        },
                      ]
                    : [],
              errors: [],
              syncProgress:
                scene.sync === "progress"
                  ? {
                      label: "Syncing skills",
                      detail: "skills/pr-polish/SKILL.md",
                      completed: 12,
                      total: 30,
                    }
                  : null,
              sync: scene.offline
                ? { online: false, error: "Service unavailable" }
                : scene.sync === "uptodate"
                  ? { online: true, lastSync: new Date().toISOString() }
                  : { online: true },
              daemon: { running: true },
              devices: [],
              deviceId: "device",
              background: true,
            };
          if (name === "local_resource_catalog")
            return { resources: [], errors: [] };
          if (name === "governance_command")
            return scene.governed ? governanceCatalog : {};
          if (name === "inspect_resource") {
            if (scene.summaries === "hold") await hold("finishSummaries");
            const skill = [...shared, ...locals].find(
              (item) => item.resourceId === args.id,
            );
            const description = skill?.description;
            return {
              content:
                description === null
                  ? "# Skill without frontmatter\n"
                  : `---\nname: ${skill?.title}\ndescription: ${JSON.stringify(description ?? "")}\n---\n# ${skill?.title}\n\n- Step one\n- Step two\n`,
              previous: null,
              paths: [],
            };
          }
          if (name === "project_skill_usage") {
            if (scene.usage === "hold") await hold("finishUsage");
            if (scene.usage === "error") throw "History unreadable";
            return {
              counts: Object.fromEntries(
                [...shared, ...locals].map((skill, index) => [
                  skill.resourceId,
                  Math.max(0, 41 - index * 3),
                ]),
              ),
              partial: scene.usage === "partial",
            };
          }
          if (name === "scan_global_skills") {
            if (scene.scan === "hold") await hold("finishScan");
            if (scene.scan === "error") throw "Folder access failed";
            return {
              skills:
                scene.scan === "empty"
                  ? []
                  : globals.map((skill) => ({
                      ...skill,
                      exists:
                        skill.exists || (added && skill.id === "g-review"),
                    })),
              errors:
                scene.scan === "partial"
                  ? [
                      "Cannot scan /Users/test/.claude/skills: permission denied",
                    ]
                  : [],
            };
          }
          if (name === "global_skill_usage") {
            if (scene.globalUsage === "hold") await hold("finishGlobalUsage");
            if (scene.globalUsage === "error") throw "History unreadable";
            return {
              counts: Object.fromEntries(
                globals.map((skill, index) => [
                  skill.id,
                  Math.max(0, 14 - index * 2),
                ]),
              ),
              partial: false,
            };
          }
          if (name === "add_global_skill") {
            if (scene.add === "error") throw "Project folder is unavailable";
            if (scene.add === "hold") await hold("finishAdd");
            added = true;
            return { resourceId: "imported", status: "queued" };
          }
          if (name === "add_global_skills") {
            if (scene.add === "error")
              throw "The project folder isn’t available right now.";
            if (scene.add === "hold") await hold("finishAdd");
            added = true;
            return {
              results: (args.skillIds as string[]).map((skillId) =>
                scene.add === "partial" && skillId === "g-writing"
                  ? { skillId, error: "Folder changed; scan again" }
                  : { skillId, result: { status: "queued" } },
              ),
            };
          }
          if (name.startsWith("plugin:")) return null;
          if (scene.failActions) throw "Folder is unavailable";
          return {};
        },
      },
    });
  }, scene);
  await page.goto("/");
  await page.getByRole("button", { name: /^Skills/ }).click();
}
