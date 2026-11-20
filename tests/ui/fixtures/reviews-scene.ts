import type { Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { defaultProjectRules } from "@portable/protocol";

// Shared scene for the Reviews captures. Design tooling; synthetic data only.
const root = process.env.REVIEWS_SHOTS;
export const wide = { width: 1160, height: 800 };
export const compact = { width: 900, height: 640 };

export type Scene = {
  role?: "owner" | "member";
  governed?: boolean;
  requests?: Record<string, unknown>[];
  drafts?: Record<string, unknown>[];
  bindings?: "update" | "modified" | "review" | "none";
  outbox?: Record<string, unknown>[];
  errors?: { source: string; error: string }[];
  holdCatalog?: boolean;
  failCatalog?: boolean;
  detail?:
    | "skill"
    | "memory"
    | "access"
    | "deleted"
    | "multi"
    | "long"
    | "binary"
    | "longpath";
  canPublish?: boolean;
  longNames?: boolean;
  /** Extra shared resources, so requests can resolve a kind and repository. */
  resources?: Record<string, unknown>[];
};

export async function shot(page: Page, name: string, caption: string) {
  // Captures are for design review; a normal run asserts and moves on.
  if (!root) return;
  mkdirSync(root, { recursive: true });
  await page.addStyleTag({
    content:
      "[data-feedback-toolbar],[data-agentation-root],[data-agentation-toolbar]{display:none!important}",
  });
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${root}/${name}.png` });
  writeFileSync(`${root}/${name}.json`, JSON.stringify({ caption }));
}

export const day = (n: number) =>
  new Date(Date.UTC(2026, 10, 20 - n, 9, 30)).toISOString();
export const req = (
  id: string,
  title: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  projectId: "project",
  author: "mira",
  type: "change",
  resourceId: id.startsWith("skill") ? "skill" : `res-${id}`,
  title,
  status: "pending",
  baseRevision: 1,
  policyRevision: 1,
  previewHash: `hash-${id}`,
  createdAt: day(1),
  canReview: true,
  unread: true,
  ...extra,
});
export const mixed = [
  req("skill-1", "release-checklist"),
  req("m1", "Desktop interaction guidelines", { author: "jon" }),
  req("p1", "Onboarding rollout plan", { author: "jon", createdAt: day(3) }),
  req("a1", "Sessions access request", {
    type: "access",
    requestedMode: "suggest",
    requestedClass: "session",
    author: "ana",
  }),
];
export const draft = (
  id: string,
  title: string,
  status: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  projectId: "project",
  resource: {
    resourceId: `draft-${id}`,
    projectId: "project",
    kind: "memory",
    source: "claude",
    logicalPath: `memory/${id}.md`,
    title,
    revision: 1,
    owner: "owner",
    updatedBy: "owner",
    updatedAt: day(1),
    files: [{ path: "content.md", hash: "h", size: 24, executable: false }],
    deleted: false,
  },
  paths: [],
  status,
  createdAt: day(2),
  updatedAt: day(1),
  ...extra,
});

export async function open(page: Page, scene: Scene = {}, viewport = wide) {
  await page.setViewportSize(viewport);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route(/annotation-tools/, (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: "export default () => null;",
    }),
  );
  await page.addInitScript(
    ({ scene, rules }) => {
      const member = scene.role === "member";
      const me = member ? "mira" : "owner";
      const resource = {
        resourceId: "skill",
        projectId: "project",
        kind: "skill",
        source: "shared",
        logicalPath: "release-checklist",
        title: "release-checklist",
        sourceId: "desktop",
        revision: 2,
        owner: "owner",
        updatedBy: "owner",
        updatedAt: "2026-11-18T00:00:00Z",
        files: [
          { path: "SKILL.md", hash: "fixture", size: 16, executable: false },
        ],
        deleted: false,
      };
      const project = {
        id: "project",
        name: "Orka",
        path: "/synthetic/orka",
        role: member ? "member" : "owner",
        governed: scene.governed ?? true,
        sources: [
          { id: "desktop", name: "desktop", path: "/synthetic/orka" },
          { id: "backend", name: "backend", path: "/synthetic/backend" },
        ],
        sharing: { memory: true, skill: true, session: true, plan: true },
      };
      const requests = scene.requests ?? [];
      const suggest = Object.fromEntries(
        Object.entries(rules).map(([key, rule]) => [
          key,
          { ...(rule as object), mode: "suggest", canShare: false },
        ]),
      );
      const members = [
        { id: "owner", role: "owner", name: "Saket Rao" },
        { id: "mira", role: "member", name: "Mira Shah" },
        {
          id: "jon",
          role: "member",
          name: scene.longNames
            ? "Maximilian Alexander von Hohenzollern-Sigmaringen the Third"
            : "Jon Bell",
        },
        { id: "ana", role: "member", name: "Ana Souza" },
      ];
      const catalog = {
        owner: !member,
        governed: scene.governed ?? true,
        policyRevision: 1,
        policy: suggest,
        access: suggest,
        members,
        // Ana can only view sessions, so her request reads as a step up.
        memberRules: [
          {
            userId: "ana",
            class: "session",
            rule: { ...(suggest.session as object), mode: "read" },
          },
        ],
        resourceRules: [],
        resourceCount: 1,
        envSets: [],
        requests,
      };
      const state = scene.bindings ?? "none";
      const bindings =
        state === "none"
          ? []
          : [
              {
                base: { ...resource, revision: 1 },
                paths: ["/synthetic/orka/.claude/skills/release-checklist"],
                installationState:
                  state === "update"
                    ? "update_available"
                    : state === "modified"
                      ? "locally_modified"
                      : "review_pending",
              },
            ];
      const w = window as any;
      Object.assign(window, {
        isTauri: true,
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
        __TAURI_INTERNALS__: {
          transformCallback: () => 1,
          unregisterCallback: () => {},
          invoke: async (
            command: string,
            args: { action?: string; input?: Record<string, any> } = {},
          ) => {
            if (command === "snapshot")
              return {
                user: me,
                config: { apiUrl: "https://fixture.invalid", syncMinutes: 15 },
                projects: [project],
                resources: [resource, ...(scene.resources ?? [])],
                governance: [
                  {
                    projectId: "project",
                    catalog: { access: catalog.access, members },
                  },
                ],
                bindings,
                conflicts: [],
                activity: [],
                outbox: scene.outbox ?? [],
                errors: scene.errors ?? [],
                sync: { online: true },
                daemon: { running: true },
                devices: [],
                deviceId: "fixture",
                background: true,
                drafts: scene.drafts ?? [],
                reviewRequests: requests,
              };
            if (command === "sync_progress")
              return { user: me, progress: null };
            if (command === "project_skill_usage")
              return { counts: {}, partial: false };
            if (command.startsWith("plugin:")) return null;
            if (command === "governance_command")
              switch (args.action) {
                case "logs":
                  return {
                    items: [
                      {
                        id: "l1",
                        at: "2026-11-19T10:00:00Z",
                        action: "request.approved",
                        actorName: "Saket Rao",
                        subjectName: "Mira Shah",
                      },
                      {
                        id: "l2",
                        at: "2026-11-18T10:00:00Z",
                        action: "member.joined",
                        actorName: "Jon Bell",
                      },
                      {
                        id: "l3",
                        at: "2026-11-17T10:00:00Z",
                        action: "permissions.updated",
                        actorName: "Saket Rao",
                      },
                    ],
                    next: null,
                  };
                case "catalog":
                  w.catalogCalls = (w.catalogCalls ?? 0) + 1;
                  if (scene.holdCatalog) await new Promise(() => {});
                  if (scene.failCatalog || w.failCatalog)
                    throw new Error("Network unavailable");
                  return catalog;
                case "request": {
                  if (w.holdRequestLoad)
                    await new Promise<void>((resolve) => {
                      w.finishRequestLoad = resolve;
                    });
                  if (w.requestLoadFailure)
                    throw new Error("Could not load this request");
                  const request =
                    requests.find((item) => item.id === args.input?.id) ??
                    requests[0];
                  const kind = scene.detail ?? "skill";
                  if (kind === "access") return { request };
                  if ((kind as string) === "longpath")
                    return {
                      request,
                      files: {
                        "docs/architecture/decisions/2026/desktop/a-very-long-directory-name-for-review/settings-members-and-permissions-migration-plan-final-v2.md":
                          "A line with one extremely long unbroken token: " +
                          "x".repeat(220) +
                          "\nSecond line.\n",
                      },
                      before: {
                        "docs/architecture/decisions/2026/desktop/a-very-long-directory-name-for-review/settings-members-and-permissions-migration-plan-final-v2.md":
                          "Second line.\n",
                      },
                      audience: ["owner", "mira", "jon", "ana"],
                      content: {
                        resource: {
                          ...resource,
                          kind: "memory",
                          files: [
                            {
                              path: "docs/architecture/decisions/2026/desktop/a-very-long-directory-name-for-review/settings-members-and-permissions-migration-plan-final-v2.md",
                              hash: "m",
                              size: 1,
                              executable: false,
                            },
                          ],
                          memory: {
                            topic:
                              "A very long topic name that describes the permissions migration in far more words than a label should ever need",
                            scope:
                              "apps/mac/src/components/settings/members/permissions/migration",
                            provider: "claude",
                            supersedes: [],
                          },
                        },
                      },
                    };
                  if ((kind as string) === "long") {
                    const lines = Array.from(
                      { length: 70 },
                      (_, i) =>
                        "Step " +
                        (i + 1) +
                        ": check the " +
                        [
                          "build",
                          "changelog",
                          "tests",
                          "screenshots",
                          "release notes",
                        ][i % 5] +
                        ".",
                    );
                    const after = lines
                      .map((l, i) =>
                        i % 9 === 4 ? l.replace("check", "verify") : l,
                      )
                      .concat(["Step 71: tag the build."]);
                    return {
                      request,
                      files: { "SKILL.md": after.join("\n") + "\n" },
                      before: { "SKILL.md": lines.join("\n") + "\n" },
                      content: { resource },
                    };
                  }
                  if ((kind as string) === "binary")
                    return {
                      request,
                      files: {
                        "SKILL.md": "1. Run the UI suite.\n2. Tag the build.\n",
                      },
                      before: { "SKILL.md": "1. Run the UI suite.\n" },
                      content: {
                        resource: {
                          ...resource,
                          files: [
                            {
                              path: "SKILL.md",
                              hash: "a",
                              size: 1,
                              executable: false,
                            },
                            {
                              path: "assets/diagram.png",
                              hash: "b",
                              size: 20480,
                              executable: false,
                            },
                            {
                              path: "scripts/check.sh",
                              hash: "c",
                              size: 30,
                              executable: true,
                            },
                          ],
                        },
                      },
                    };
                  if (kind === "memory")
                    return {
                      request,
                      files: {
                        "content.md":
                          "# Desktop interaction guidelines\n\nKeep control size stable on hover.\nUse the shared focus ring.\nPrefer menus over inline destructive buttons.\n",
                      },
                      before: {
                        "content.md":
                          "# Desktop interaction guidelines\n\nKeep control size stable on hover.\n",
                      },
                      audience: ["owner", "mira", "jon"],
                      content: {
                        resource: {
                          ...resource,
                          kind: "memory",
                          files: [
                            {
                              path: "content.md",
                              hash: "m",
                              size: 1,
                              executable: false,
                            },
                          ],
                          memory: {
                            topic: "Desktop interaction",
                            scope: "apps/mac",
                            provider: "claude",
                            supersedes: [],
                          },
                        },
                      },
                    };
                  if (kind === "deleted")
                    return {
                      request,
                      files: { "SKILL.md": "Previous version\n" },
                      before: { "SKILL.md": "Previous version\n" },
                      content: { resource: { ...resource, deleted: true } },
                    };
                  if (kind === "multi")
                    return {
                      request,
                      files: {
                        "SKILL.md":
                          "---\nname: release-checklist\ndescription: Steps before a desktop release.\n---\n\n1. Run the UI suite.\n2. Check the changelog.\n3. Tag the build.\n",
                        "scripts/check.sh": "#!/bin/sh\nnpm run test:ui\n",
                        "notes/rollback.md":
                          "Roll back with the previous tag.\n",
                      },
                      before: {
                        "SKILL.md":
                          "---\nname: release-checklist\ndescription: Steps before a release.\n---\n\n1. Run the UI suite.\n2. Tag the build.\n",
                        "scripts/check.sh": "#!/bin/sh\nnpm test\n",
                      },
                      content: {
                        resource: {
                          ...resource,
                          files: [
                            "SKILL.md",
                            "scripts/check.sh",
                            "notes/rollback.md",
                          ].map((path) => ({
                            path,
                            hash: path,
                            size: 1,
                            executable: false,
                          })),
                        },
                      },
                    };
                  return {
                    request,
                    files: {
                      "SKILL.md":
                        "---\nname: release-checklist\n---\n\n1. Run the UI suite.\n2. Check the changelog.\n3. Tag the build.\n",
                    },
                    before: {
                      "SKILL.md":
                        "---\nname: release-checklist\n---\n\n1. Run the UI suite.\n2. Tag the build.\n",
                    },
                    content: { resource },
                  };
                }
                case "read-notification":
                  (w.readCalls ??= []).push(args.input?.id);
                  return { ok: true };
                case "decide": {
                  if (w.decideFail) throw new Error("Network unavailable");
                  if (w.holdRequestDecision)
                    await new Promise<void>((resolve) => {
                      w.finishRequestDecision = resolve;
                    });
                  const request = requests.find(
                    (item) => item.id === args.input?.id,
                  )!;
                  request.status = w.decideStale
                    ? "stale"
                    : args.input?.decision === "approve"
                      ? "approved"
                      : "rejected";
                  return request;
                }
                case "draft": {
                  const found = (scene.drafts ?? []).find(
                    (item) => item.id === args.input?.id,
                  );
                  return {
                    draft: found,
                    files: {
                      "content.md":
                        "# Sync retry guidance\n\nRetry once, then surface the error.\nNever retry a rejected upload.\n",
                    },
                    before: w.draftNew
                      ? undefined
                      : {
                          "content.md":
                            "# Sync retry guidance\n\nRetry once, then surface the error.\n",
                        },
                    baseRevision: w.draftNew ? undefined : 3,
                    related: [],
                    canPublish: scene.canPublish ?? false,
                  };
                }
                case "submit-draft":
                  return { status: scene.canPublish ? "queued" : "pending" };
                case "dismiss":
                case "refresh-draft":
                  return { ok: true };
                case "resource":
                  return {
                    access: { mode: "publish", canShare: true },
                    rules: [],
                  };
                case "preview-install":
                  return {
                    token: "local-preview",
                    revision: 2,
                    dirty: state === "modified",
                    before: {
                      "SKILL.md": "1. Run the UI suite.\n2. Tag the build.\n",
                    },
                    after: {
                      "SKILL.md":
                        "1. Run the UI suite.\n2. Check the changelog.\n3. Tag the build.\n",
                    },
                  };
                case "apply-install":
                  return { status: "current" };
              }
            if (command === "inspect_resource")
              return {
                content: "# release-checklist\n",
                previous: null,
                paths: [],
              };
            return {};
          },
        },
      });
    },
    { scene, rules: defaultProjectRules },
  );
  await page.goto("/");
}

/** A shared item a request can point at. */
export const shared = (
  id: string,
  kind: "memory" | "plan" | "skill" | "session",
  title: string,
  sourceId = "desktop",
  updatedBy = "owner",
) => ({
  resourceId: id,
  projectId: "project",
  kind,
  source: "shared",
  logicalPath: `${kind}/${id}.md`,
  title,
  sourceId,
  revision: 2,
  owner: "owner",
  updatedBy,
  updatedAt: day(2),
  files: [{ path: "content.md", hash: "h", size: 24, executable: false }],
  deleted: false,
});
