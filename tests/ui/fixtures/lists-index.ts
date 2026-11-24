import type { Page } from "@playwright/test";

// Synthetic project for the Memories, Sessions, and Plans indexes: the rows,
// people, repositories, and statuses of the design's benchmark frames.
export type ListsScene = {
  /** Every row is yours, as in a project nobody else has joined. */
  solo?: boolean;
  /** One connected repository instead of four. */
  oneRepository?: boolean;
  /** Two repositories, the second removed from the project; its rows stay. */
  removedRepository?: boolean;
  /** Extra sessions after the sample ones; every seventh is a fork. */
  sessions?: number;
  /** Nothing shared and nothing on this Mac. */
  empty?: boolean;
  /** No repository is connected on this Mac. */
  disconnected?: boolean;
  /** A member whose role only reads, or cannot see, shared items. */
  access?: "read" | "hidden";
  /**
   * Local discovery never finishes, or fails until the test sets
   * `window.listsDiscovery` to "ok".
   */
  discovery?: "pending" | "failed";
};

type Kind = "memory" | "session" | "plan";
type Row = {
  id: string;
  title: string;
  source?: "claude" | "codex";
  repo: number;
  owner: "user" | "mira" | "dev";
  /** Minutes ago, or an ISO date for older rows. */
  updated: number | string;
  status?:
    | "conflict"
    | "failed"
    | "refused"
    | "review"
    | "waiting"
    | "edits"
    | "unreadable";
  /** A second condition the row is in at the same time. */
  also?: Row["status"];
  local?: true;
  logicalPath?: string;
  /** The file Copy local path reports; none when it is not on this Mac. */
  path?: string;
  forkOf?: string;
  revision?: number;
};

export async function listsIndexFixture(page: Page, scene: ListsScene = {}) {
  // The dev-only annotation toolbar is not part of the product.
  await page.route(/annotation-tools/, (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: "export default () => null;",
    }),
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript((scene) => {
    const user = "user";
    const home = "/Users/test";
    const repositories = [
      "orka-public",
      "orka-api",
      "infrastructure-and-deployment",
      "data-pipelines-and-analytics",
    ].slice(0, scene.oneRepository ? 1 : scene.removedRepository ? 2 : 4);
    const sources = repositories.map((name, index) => ({
      id: name,
      name,
      ...(scene.disconnected
        ? {}
        : { path: `${home}/code/${name}`, folderState: "connected" }),
      ...(scene.removedRepository && index === 1
        ? { removedAt: "2026-11-20T10:00:00Z" }
        : {}),
    }));
    const hour = 60;
    const day = 24 * hour;
    const rows: Record<Kind, Row[]> = {
      plan: [
        ["Skills index production rollout", 0, "mira", 25],
        ["Repository filter across collections", 0, "user", 2 * hour, "edits"],
        ["Conflicts panel handoff", 1, "user", 4 * hour, "review"],
        ["Sync menu attention states", 0, "mira", 6 * hour, "conflict"],
        ["Docs redesign table component", 1, "mira", day + 60],
        ["Packaged app launcher fix", 0, "user", day + 120, "failed"],
        ["Pending reviews redesign", 1, "dev", 2 * day],
        ["Detail page layout unification", 0, "user", 2 * day + 60, "waiting"],
        ["Add skills popover build", 0, "user", 3 * day, undefined, true],
        ["Lucide icon migration plan", 1, "user", 4 * day, "refused"],
        // Waiting to sync and unreadable at once.
        [
          "Copy pass with Orka guidelines",
          1,
          "user",
          5 * day,
          "waiting",
          undefined,
          "unreadable",
        ],
        ["Library icon gaps", 2, "dev", "2026-11-14T10:00:00", "unreadable"],
        [
          "Onboarding journeys and handoff",
          1,
          "user",
          "2026-11-12T10:00:00",
          undefined,
          true,
        ],
        [
          "Prototype with state control panel",
          0,
          "user",
          "2026-11-11T10:00:00",
          undefined,
          true,
        ],
        ["Self-hosted server upgrade", 3, "dev", "2026-11-09T10:00:00"],
        ["Release checklist for 0.3.19", 0, "user", "2026-11-06T10:00:00"],
      ].map(([title, repo, owner, updated, status, local, also], index) => {
        const slug = String(title).toLowerCase().replace(/\W+/g, "-");
        const fromSession = index === 6;
        return {
          id: `plan-${index}`,
          title,
          source: "claude",
          repo,
          owner,
          updated,
          status,
          local,
          also,
          logicalPath: fromSession
            ? `claude/sessions/s${index}/plan.md`
            : `claude/files/${slug}.md`,
          path:
            owner === user && !fromSession
              ? `${home}/.claude/plans/${slug}.md`
              : undefined,
        } as Row;
      }),
      memory: [
        [
          "AGENTS.md",
          "codex",
          0,
          "mira",
          40,
          "review",
          "instructions/AGENTS.md",
        ],
        [
          "CLAUDE.md",
          "claude",
          0,
          "user",
          41,
          undefined,
          "instructions/CLAUDE.md",
        ],
        ["MEMORY.md", "claude", 1, "user", 2 * hour, "edits"],
        ["MEMORY.md", "codex", 0, "mira", 3 * hour],
        ["Voice agent interaction model notes", "claude", 1, "mira", 5 * hour],
        [
          "Figma UI kit token sync and light theme",
          "codex",
          0,
          "mira",
          day + 30,
          "conflict",
        ],
        ["Resize divider feedback, PR 2931", "codex", 1, "dev", day + 90],
        [
          "Core flow end-to-end smoke test",
          "claude",
          0,
          "user",
          2 * day,
          "failed",
        ],
        [
          "Searchable notes folder overflow",
          "codex",
          0,
          "user",
          2 * day + 60,
          undefined,
          undefined,
          true,
        ],
        [
          "Figma workspace layout audit",
          "claude",
          1,
          "user",
          3 * day,
          "waiting",
        ],
        ["Agent prompt and Figma references", "codex", 1, "user", 4 * day],
        [
          "Sharded pull request checks",
          "claude",
          2,
          "dev",
          5 * day,
          "unreadable",
          "instructions/docs/sharded-checks.md",
        ],
        [
          "Notes load more, PR 2809",
          "codex",
          1,
          "user",
          "2026-11-14T10:00:00",
          undefined,
          undefined,
          true,
        ],
        [
          "Release notes voice",
          "claude",
          0,
          "user",
          "2026-11-12T10:00:00",
          "refused",
        ],
        ["Design review checklist", "claude", 3, "dev", "2026-11-11T10:00:00"],
        ["Team glossary", "codex", 0, "user", "2026-11-09T10:00:00"],
      ].map(
        ([title, source, repo, owner, updated, status, path, local], index) => {
          const logicalPath =
            (path as string | undefined) ??
            `${source}/memory/${String(title).toLowerCase().replace(/\W+/g, "-")}.md`;
          return {
            id: `memory-${index}`,
            title,
            source,
            repo,
            owner,
            updated,
            status,
            local,
            logicalPath,
            revision: 12 - (index % 5),
            path:
              owner !== user
                ? undefined
                : logicalPath.startsWith("instructions/")
                  ? `${home}/code/${repositories[Number(repo)] ?? repositories[0]}/${logicalPath.slice("instructions/".length)}`
                  : `${home}/.${source}/${logicalPath.slice(String(source).length + 1)}`,
          } as Row;
        },
      ),
      session: [
        ["Fix packaged launcher identity on reinstall", "codex", 0, "mira", 12],
        ["Skills index redesign review", "claude", 0, "user", hour, "edits"],
        [
          "Skills index redesign review, second pass",
          "claude",
          0,
          "mira",
          hour + 5,
          undefined,
          undefined,
          "session-1",
        ],
        [
          "Restore local catalogs before discovery",
          "codex",
          0,
          "mira",
          3 * hour,
          "conflict",
        ],
        [
          "Investigate sync retry after sleep",
          "codex",
          1,
          "user",
          5 * hour,
          "failed",
        ],
        ["Repository picker empty state copy", "claude", 0, "mira", day + 60],
        ["Governance spec flake on CI", "codex", 1, "user", 2 * day, "waiting"],
        [
          "Governance spec flake on CI, retry",
          "codex",
          1,
          "dev",
          2 * day + 60,
          undefined,
          undefined,
          "session-6",
        ],
        [
          "Add skills popover keyboard order",
          "claude",
          0,
          "user",
          3 * day,
          undefined,
          true,
        ],
        [
          "Token audit for the Skills table",
          "codex",
          1,
          "user",
          4 * day,
          "refused",
        ],
        [
          "Request access panel failure states",
          "claude",
          1,
          "user",
          6 * day,
          "unreadable",
        ],
        [
          "Onboarding folder step illustration",
          "claude",
          2,
          "dev",
          "2026-11-14T10:00:00",
        ],
        [
          "Capture detail states for memories",
          "codex",
          1,
          "user",
          "2026-11-12T10:00:00",
        ],
        // Forked in Orka and not shared yet: no shared revision, no local flag.
        [
          "Unify detail pages on one layout",
          "codex",
          0,
          "user",
          "2026-11-11T10:00:00",
          undefined,
          undefined,
          "session-15",
          0,
        ],
        [
          "Replace Primer Octicons with Lucide",
          "claude",
          3,
          "dev",
          "2026-11-09T10:00:00",
        ],
        [
          "Docs redesign table component",
          "codex",
          0,
          "user",
          "2026-11-06T10:00:00",
        ],
        ...Array.from({ length: scene.sessions ?? 0 }, (_, index) => [
          `Archived session ${index + 1}`,
          index % 2 ? "codex" : "claude",
          index % repositories.length,
          index % 3 ? "user" : "mira",
          `2026-10-${String(28 - (index % 27)).padStart(2, "0")}T10:00:00`,
          undefined,
          undefined,
          // A fork shares its parent's repository.
          index % 7 === 6
            ? `session-${16 + index - repositories.length}`
            : undefined,
        ]),
      ].map(
        (
          [
            title,
            source,
            repo,
            owner,
            updated,
            status,
            local,
            forkOf,
            revision,
          ],
          index,
        ) =>
          ({
            id: `session-${index}`,
            title,
            source,
            repo,
            owner,
            updated,
            status,
            local,
            forkOf,
            revision,
            logicalPath: `${source}/sessions/s${index}.jsonl`,
          }) as Row,
      ),
    };
    if (scene.solo)
      for (const kind of Object.keys(rows) as Kind[])
        for (const row of rows[kind]) row.owner = user;
    const now = Date.now();
    const resource = (kind: Kind, row: Row) => ({
      resourceId: row.id,
      projectId: "one",
      sourceId: (sources[row.repo] ?? sources[0]).id,
      kind,
      source: row.source ?? "claude",
      logicalPath: row.logicalPath ?? `claude/${kind}/${row.id}`,
      title: row.title,
      files: [
        {
          path: kind === "session" ? "session.jsonl" : "content.md",
          hash: row.id,
          size: 20,
          executable: false,
        },
      ],
      deleted: false,
      hash: row.id,
      revision: row.local ? 0 : (row.revision ?? 3),
      owner: row.owner,
      updatedBy: row.owner,
      updatedAt:
        typeof row.updated === "number"
          ? new Date(now - row.updated * 60_000).toISOString()
          : new Date(row.updated).toISOString(),
      ...(row.local ? { local: true } : {}),
      ...(row.forkOf
        ? {
            fork: {
              parentId: row.forkOf,
              nativeId: `native-${row.id}`,
              destination: "desktop",
              createdAt: "2026-11-20T10:00:00Z",
            },
          }
        : {}),
    });
    const all = (Object.keys(rows) as Kind[]).flatMap((kind) =>
      rows[kind].map((row) => ({ kind, row })),
    );
    const shared =
      scene.empty || scene.access === "hidden"
        ? []
        : all
            // A fork not shared yet exists only on this Mac, like a local row.
            .filter(
              ({ row }) =>
                !row.local && !(scene.disconnected && row.revision === 0),
            )
            .map(({ kind, row }) => resource(kind, row));
    const local = (kind: Kind) =>
      rows[kind]
        .filter(
          (row) =>
            !scene.empty &&
            !scene.disconnected &&
            (row.local ||
              (row.status === "edits" && scene.access !== "hidden")),
        )
        .map((row) => ({
          ...resource(kind, row),
          ...(row.status === "edits"
            ? { localChanges: true, sharedRevision: row.revision ?? 3 }
            : {}),
        }));
    const withStatus = (status: Row["status"]) =>
      all.filter(({ row }) => row.status === status || row.also === status);
    const upload = (
      { kind, row }: { kind: Kind; row: Row },
      error: string | null,
      reviewable?: boolean,
    ) => ({
      id: `out-${row.id}`,
      project: "one",
      resourceId: row.id,
      title: row.title,
      kind,
      error,
      ...(reviewable ? { reviewable: true } : {}),
    });
    const members = [
      { id: "mira", role: "member", name: "Mira" },
      { id: "dev", role: "member", name: "Dev" },
    ];
    const catalog = {
      access: scene.access
        ? Object.fromEntries(
            ["instructions", "memory", "skill", "plan", "session", "env"].map(
              (key) => [key, { mode: scene.access }],
            ),
          )
        : {},
      members: scene.solo ? [] : members,
    };
    const located = new Map(
      all.filter(({ row }) => row.path).map(({ row }) => [row.id, row.path]),
    );
    const scanOf = ({ kind, row }: { kind: Kind; row: Row }) =>
      `one:${resource(kind, row).sourceId}:scan:`;
    // An unreadable session or plan is the file this Mac's binding records;
    // an instruction file is scanned by its path in the repository.
    const unreadable = withStatus("unreadable").map((item) => ({
      ...item,
      file:
        item.kind === "memory"
          ? undefined
          : `${home}/.${item.row.source ?? "claude"}/${item.kind}s/${item.row.id}`,
    }));
    // A rescan of a bound plan that failed for a reason other than reading it.
    const rescanned = all.find(({ row }) => row.id === "plan-4")!;
    Object.assign(window, {
      listsCalls: [],
      isTauri: true,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: async (name: string, args: Record<string, any> = {}) => {
          (window as any).listsCalls.push({ name, args });
          if (name === "snapshot")
            return {
              user,
              accountProfile: { displayName: "Alex" },
              config: { apiUrl: "https://test.local", syncMinutes: 15 },
              projects: [
                {
                  id: "one",
                  name: "Orka",
                  role: scene.access ? "member" : "owner",
                  governed: true,
                  sources,
                },
              ],
              // Rows a test has taken out of later snapshots.
              resources: shared.filter(
                ({ resourceId }) =>
                  !((window as any).listsHidden ?? []).includes(resourceId),
              ),
              bindings: [
                ...withStatus("review").map(({ kind, row }) => ({
                  resourceId: row.id,
                  projectId: "one",
                  base: resource(kind, row),
                  installationState: "review_pending",
                })),
                ...unreadable.flatMap(({ row, file }) =>
                  file
                    ? [{ resourceId: row.id, projectId: "one", paths: [file] }]
                    : [],
                ),
              ],
              governance: [{ projectId: "one", catalog }],
              conflicts: withStatus("conflict").map(({ kind, row }) => ({
                id: `conflict-${row.id}`,
                resourceId: row.id,
                author: "mira",
                deviceId: "other",
                candidate: resource(kind, row),
                revision: 3,
              })),
              activity: [],
              outbox: [
                ...withStatus("failed").map((item) =>
                  upload(item, "503: Service unavailable"),
                ),
                ...withStatus("refused").map((item) =>
                  upload(item, "403: Sharing is disabled"),
                ),
                ...withStatus("waiting").map((item) => upload(item, null)),
                ...withStatus("review")
                  .filter(({ kind }) => kind === "plan")
                  .map((item) =>
                    upload(
                      item,
                      "409: Resource changed; refresh and review the exact version again",
                      true,
                    ),
                  ),
              ],
              errors: [
                ...unreadable.map((item) => ({
                  source: `${scanOf(item)}${item.file ?? resource(item.kind, item.row).logicalPath}`,
                  error: "Permission denied (os error 13)",
                })),
                {
                  source: `${scanOf(rescanned)}${rescanned.row.id}`,
                  error: "Permission denied (os error 13)",
                },
              ],
              sync: { online: true },
              daemon: { running: true },
              devices: [],
              deviceId: "device",
              background: true,
            };
          if (name === "local_resource_catalog") {
            if (scene.discovery === "pending") return new Promise(() => {});
            if (
              scene.discovery === "failed" &&
              (window as any).listsDiscovery !== "ok"
            )
              return {
                resources: [],
                errors: ["Permission denied (os error 13)"],
              };
            return { resources: local(args.kind as Kind), errors: [] };
          }
          if (name === "governance_command") return catalog;
          if (name === "session_display_title") return null;
          if (name === "resource_command" && args.action === "paths") {
            const path = located.get(args.input?.resourceId);
            if (!path) throw "This item has no local file on this Mac.";
            return { paths: [path] };
          }
          if (name === "session_messages")
            return {
              messages: [{ index: 0, role: "user", text: "Fixture message" }],
              total: 1,
              offset: 0,
            };
          if (name === "inspect_resource")
            return { content: "# Notes\n", previous: null, paths: [] };
          if (name.startsWith("plugin:")) return null;
          return {};
        },
      },
    });
  }, scene);
  await page.goto("/");
}
