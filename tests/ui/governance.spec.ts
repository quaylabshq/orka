import { test, expect, type Locator, type Page } from "@playwright/test";
import type { FileManifestEntry } from "../../apps/mac/src/components/diff-model.js";
import {
  defaultProjectRules,
  defaultRolePolicies,
  type ClassRule,
  type ProjectRules,
} from "@portable/protocol";

// Saved policies are independent of the defaults for newly created projects.
const savedProjectRules: ProjectRules = {
  instructions: { mode: "suggest", create: "suggest", canShare: false },
  memory: { mode: "suggest", create: "suggest", canShare: false },
  skill: { mode: "suggest", create: "suggest", canShare: false },
  plan: { mode: "suggest", create: "suggest", canShare: false },
  session: { mode: "suggest", create: "suggest", canShare: false },
  env: defaultProjectRules.env,
};

async function fixture(
  page: Page,
  governed = true,
  removed = false,
  mode = "owner",
  envData = false,
  review: {
    before?: Record<string, string>;
    files?: Record<string, string>;
    baseRevision?: number;
    beforeManifest?: FileManifestEntry[];
    manifest?: FileManifestEntry[];
    sourceUnavailable?: boolean;
  } = {},
) {
  await page.addInitScript(
    ({ rules, governed, removed, mode, envData, review, defaultRoles }) => {
      const roleBased = mode === "role-policy-skills";
      const isMember = mode === "member" || mode === "restricted" || roleBased;
      const instructions = mode === "instructions";
      const file = instructions ? "CLAUDE.md" : "SKILL.md";
      const resource = {
        resourceId: instructions ? "instructions" : "skill",
        projectId: "project",
        kind: instructions ? "memory" : "skill",
        source: "shared",
        logicalPath: instructions ? "instructions/CLAUDE.md" : "sample",
        title: instructions ? "Project instructions" : "Sample skill",
        revision: 2,
        owner: "owner",
        updatedBy: "owner",
        updatedAt: "2026-10-18T00:00:00Z",
        files: [{ path: file, hash: "fixture", size: 16, executable: false }],
        deleted: removed,
      };
      const localDraft = {
        id: "local-memory",
        projectId: "project",
        resource: {
          ...resource,
          // A draft is its own row unless the test wants it on the resource
          // that also has a shared update waiting.
          resourceId:
            mode === "draft-blocked" ? resource.resourceId : "saved-learning",
          kind: "memory",
          title: "Saved learning",
          files: Object.entries(
            review.files ?? { "content.md": "Saved learning\n" },
          ).map(([path, content]) => ({
            path,
            hash: "fixture",
            size: content.length,
            executable: false,
          })),
        },
        paths: [],
        status: "local",
        createdAt: "2026-10-18T00:00:00Z",
      };
      const project = {
        id: "project",
        name: "Team \u2014 project",
        path: "/synthetic/project",
        role: isMember ? "member" : "owner",
        governed,
        policyRevision: roleBased ? 1 : undefined,
        rolePolicies: roleBased ? defaultRoles : undefined,
        sharing: {
          memory: true,
          skill: true,
          session: true,
          plan: true,
          env: envData,
        },
      };
      const request = {
        id: "request",
        projectId: "project",
        author: "member",
        type: "change",
        resourceId: "skill",
        title: "Sample skill",
        status: "pending",
        baseRevision: 1,
        policyRevision: 1,
        previewHash: "reviewed-hash",
        createdAt: "2026-10-18T00:00:00Z",
        canReview: mode !== "request-viewer",
        unread: true,
      };
      const envRequests = envData
        ? Array.from({ length: 7 }, (_, index) => ({
            ...request,
            id: `env-request-${index}`,
            type: "access",
            requestedClass: "env",
            title: "ENV sets access request",
          }))
        : [];
      const catalog = {
        owner: !isMember,
        governed,
        policyRevision: governed ? 1 : 0,
        rolePolicies: project.rolePolicies,
        policy: rules,
        access: Object.fromEntries(
          Object.entries(rules).map(([key, rule]) => [
            key,
            {
              ...rule,
              mode:
                mode === "restricted"
                  ? "hidden"
                  : roleBased && key === "skill"
                    ? "publish"
                    : rule.mode,
            },
          ]),
        ),
        members: [
          {
            id: "owner",
            role: "owner",
            ...(mode === "names" ? { name: "Saket Rao" } : {}),
          },
          {
            id: "member",
            role: "member",
            ...(mode === "names" ? { name: "Mira Shah" } : {}),
          },
        ],
        memberRules:
          mode === "mixed" || mode === "partial"
            ? [
                {
                  userId: "member",
                  class: "instructions",
                  rule: {
                    mode: "read",
                    create: "hidden",
                    canShare: false,
                  } as ClassRule,
                },
              ]
            : ([] as { userId: string; class: string; rule: ClassRule }[]),
        resourceRules: [
          {
            resourceId: "skill",
            userId: "member",
            rule: { mode: "read", canShare: false },
          },
        ],
        resourceCount: 1,
        envSets: envData
          ? [{ resourceId: "env-set", title: "Private ENV set" }]
          : [],
        requests: [
          ...envRequests,
          ...(mode === "many"
            ? Array.from({ length: 12 }, (_, index) => ({
                ...request,
                id: `request-${index}`,
                title: `Request ${index + 1}`,
              }))
            : [request]),
        ],
      };
      const pendingSkillCatalog: { finish: () => void; fail: () => void }[] =
        [];
      const calls: { command: string; args: Record<string, unknown> }[] = [];
      Object.assign(window, {
        governanceCalls: calls,
        governanceStale: false,
        pendingEnvLink: null,
        governanceBump: () => {
          catalog.policyRevision++;
        },
        skillCatalog: {
          finish: () => pendingSkillCatalog.shift()?.finish(),
          fail: () => pendingSkillCatalog.shift()?.fail(),
          restrict: () => {
            project.policyRevision = ++catalog.policyRevision;
            defaultRoles.member.skill = "read";
            catalog.access.skill.mode = "read";
          },
        },
        isTauri: true,
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
        __TAURI_INTERNALS__: {
          transformCallback: () => 1,
          unregisterCallback: () => {},
          invoke: async (
            command: string,
            args: { action?: string; input?: Record<string, unknown> } = {},
          ) => {
            if (command === "snapshot")
              return {
                user: isMember ? "member" : "owner",
                config: { apiUrl: "https://fixture.invalid", syncMinutes: 15 },
                projects:
                  mode === "multi-project"
                    ? [
                        project,
                        {
                          ...project,
                          id: "second",
                          name: "Second project",
                          path: "/synthetic/second",
                        },
                      ]
                    : [roleBased ? structuredClone(project) : project],
                resources: mode === "restricted" ? [] : [resource],
                governance: [
                  {
                    projectId: "project",
                    catalog: {
                      access: catalog.access,
                      members: roleBased ? catalog.members : undefined,
                    },
                  },
                ],
                bindings: [
                  {
                    base: { ...resource, revision: 1 },
                    installationState: "update_available",
                  },
                ],
                conflicts: [],
                activity: [],
                outbox: [],
                errors: [],
                sync: { online: true },
                daemon: { running: true },
                devices: [],
                deviceId: "fixture",
                background: true,
                drafts: mode.startsWith("draft-") ? [localDraft] : [],
                reviewRequests: [...envRequests, request],
              };
            if (command === "sync_progress")
              return { user: "owner", progress: null };
            if (command === "project_skill_usage")
              return { counts: {}, partial: false };
            calls.push({ command, args });
            if (command === "profile_events") {
              const w = window as any;
              const link = w.pendingEnvLink;
              w.pendingEnvLink = null;
              return link;
            }
            if (command === "plugin:deep-link|get_current" && envData)
              return ["orka://env/project/env-set"];
            if (command.startsWith("plugin:")) return null;
            if (command === "governance_command")
              switch (args.action) {
                case "logs":
                  if (mode === "paginated-logs")
                    return {
                      items: [
                        args.input?.before
                          ? {
                              id: "older-log",
                              at: "2026-10-18T00:00:00Z",
                              action: "member.joined",
                              actorName: "Mira Shah",
                            }
                          : {
                              id: "latest-log",
                              at: "2026-10-19T00:00:00Z",
                              action: "request.approved",
                              actorName: "Saket Rao",
                              subjectName: "Mira Shah",
                            },
                        ...(!args.input?.before
                          ? [
                              {
                                id: "revoked-invite-log",
                                at: "2026-10-19T00:00:00Z",
                                action: "invite.revoked",
                                actorName: "Saket Rao",
                              },
                              {
                                id: "future-log",
                                at: "2026-10-19T00:00:00Z",
                                action: "project.future_action",
                                actorName: "Mira Shah",
                              },
                            ]
                          : []),
                      ],
                      next: args.input?.before ? null : "older-logs",
                    };
                  return {
                    items:
                      envData && !args.input?.before
                        ? [
                            {
                              id: "env-log",
                              at: "2026-10-19T00:00:00Z",
                              action: "env.replaced",
                              actorName: "Owner",
                            },
                            {
                              id: "env-policy-log",
                              at: "2026-10-19T00:00:00Z",
                              action: "permissions.updated",
                              category: "env",
                              actorName: "Owner",
                            },
                          ]
                        : [
                            {
                              id: "1",
                              at: "2026-10-19T00:00:00Z",
                              action: "request.approved",
                              actorName: "Saket Rao",
                              subjectName: "Mira Shah",
                            },
                          ],
                    next: envData && !args.input?.before ? "next-page" : null,
                  };
                case "catalog":
                  if (roleBased)
                    await new Promise<void>((resolve, reject) => {
                      pendingSkillCatalog.push({
                        finish: resolve,
                        fail: () => reject(new Error("Network unavailable")),
                      });
                    });
                  if (mode === "held-catalog")
                    await new Promise<void>((resolve) => {
                      ((window as any).finishMemberLoads ??= []).push(resolve);
                    });
                  if (args.input?.projectId === "second")
                    return {
                      ...catalog,
                      requests: [
                        {
                          ...request,
                          id: "second-request",
                          projectId: "second",
                          title: "Second project request",
                        },
                      ],
                    };
                  return catalog;
                case "policy": {
                  const input = args.input!;
                  if (input.expectedPolicyRevision !== catalog.policyRevision)
                    throw new Error(
                      "Permissions changed; refresh and review again",
                    );
                  if (mode === "partial" && input.class === "memory")
                    throw new Error("Permissions changed during save");
                  if (input.userId) {
                    const existing = catalog.memberRules.find(
                      (item) =>
                        item.class === input.class &&
                        item.userId === input.userId,
                    );
                    if (existing) existing.rule = input.rule as ClassRule;
                    else
                      catalog.memberRules.push({
                        userId: String(input.userId),
                        class: String(input.class),
                        rule: input.rule as ClassRule,
                      });
                  } else
                    catalog.policy[input.class as keyof ProjectRules] =
                      input.rule as ClassRule;
                  catalog.policyRevision++;
                  return { policyRevision: catalog.policyRevision };
                }
                case "inherit":
                  catalog.memberRules = catalog.memberRules.filter(
                    (item) =>
                      !(
                        item.userId === args.input!.userId &&
                        item.class === args.input!.class
                      ),
                  );
                  catalog.policyRevision++;
                  return { policyRevision: catalog.policyRevision };
                case "request-access":
                  return { status: "pending" };
                case "draft":
                  return {
                    draft: localDraft,
                    files: review.files ?? { "content.md": "Saved learning\n" },
                    before: review.before,
                    baseRevision: review.baseRevision,
                    beforeManifest: review.beforeManifest,
                    manifest: review.manifest,
                    sourceUnavailable: review.sourceUnavailable,
                    related: [],
                    canPublish: mode === "draft-publisher",
                  };
                case "submit-draft":
                  if ((window as any).holdDraftSubmit)
                    await new Promise<void>((resolve) => {
                      (window as any).finishDraftSubmit = resolve;
                    });
                  if ((window as any).governanceStale)
                    throw new Error(
                      "The shared version changed. Review the changes again before publishing.",
                    );
                  return {
                    status: mode === "draft-publisher" ? "queued" : "pending",
                  };
                case "activate":
                  catalog.governed = true;
                  catalog.policy = args.input!.rules as ProjectRules;
                  catalog.policyRevision++;
                  project.governed = true;
                  return { governed: true };
                case "resource":
                  return {
                    access: { mode: "publish", canShare: true },
                    rules: [],
                  };
                case "request":
                  if ((window as any).holdRequestLoad)
                    await new Promise<void>((resolve) => {
                      (window as any).finishRequestLoad = resolve;
                    });
                  if ((window as any).requestLoadFailure)
                    throw new Error("Could not load this request");
                  return {
                    request:
                      catalog.requests.find(
                        (item) => item.id === args.input?.id,
                      ) ?? request,
                    files: {
                      "SKILL.md": removed
                        ? "Previous version\n"
                        : "Reviewed candidate\n",
                    },
                    before: { "SKILL.md": "Previous version\n" },
                    content: { resource },
                  };
                case "read-notification":
                  request.unread = false;
                  return { ok: true };
                case "decide":
                  if ((window as any).holdRequestDecision)
                    await new Promise<void>((resolve) => {
                      (window as any).finishRequestDecision = resolve;
                    });
                  request.status = "stale";
                  return request;
                case "preview-install":
                  if ((window as any).holdInstallPreview)
                    await new Promise<void>((resolve) => {
                      (window as any).finishInstallPreview = resolve;
                    });
                  if ((window as any).installPreviewFailure)
                    throw new Error("Could not prepare the comparison");
                  return {
                    token: "local-preview",
                    revision: 2,
                    dirty: true,
                    before: { [file]: "Local edits\n" },
                    after: removed
                      ? {}
                      : {
                          [file]: instructions
                            ? "Approved instructions\n"
                            : "Approved skill\n",
                        },
                  };
                case "apply-install":
                  if (
                    (window as unknown as { governanceStale: boolean })
                      .governanceStale
                  )
                    throw new Error(
                      "Local or shared files changed; review the update again",
                    );
                  return { status: "current" };
              }
            if (command === "inspect_resource")
              return { content: "# Sample skill\n", previous: null, paths: [] };
            return {};
          },
        },
      });
    },
    {
      rules: savedProjectRules,
      governed,
      removed,
      mode,
      envData,
      review,
      defaultRoles: defaultRolePolicies,
    },
  );
  await page.goto("/");
  if (mode === "role-policy-skills") return;
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Members", exact: true }).click();
  await page
    .getByRole("button", {
      name: /Review pending requests|View requests and history/,
    })
    .click();
}

const management = (page: Page) =>
  page.getByRole("region", { name: "Manage", exact: true });
const requestPage = (page: Page) =>
  page.getByRole("region", { name: "Review details", exact: true });
const requestInfo = (page: Page) =>
  page.getByRole("complementary", { name: "Review information" });
const reviews = (page: Page) =>
  page.getByRole("region", { name: "Reviews", exact: true });
/** A titled table on the Open view; its name is the heading plus a count. */
const section = (
  page: Page,
  title: "To decide" | "Sent by you" | "On this Mac",
) => reviews(page).getByRole("region", { name: new RegExp(`^${title} \\d+$`) });
/** The button that names a row; the row and the button both open the review. */
const rowButton = (scope: Locator, title: string) =>
  scope.getByRole("button", { name: title, exact: true });
const toMembers = async (page: Page) => {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("region", { name: "Settings", exact: true })
    .getByRole("button", { name: "Members", exact: true })
    .click();
};
const draftRow = (page: Page) =>
  rowButton(section(page, "On this Mac"), "Saved learning");

test("Settings Members opens activity logs, paginates, and returns to Members", async ({
  page,
}) => {
  await fixture(page, true, false, "paginated-logs");
  await toMembers(page);
  const settings = page.getByRole("region", { name: "Settings", exact: true });
  await settings
    .getByRole("button", { name: "View logs", exact: true })
    .click();
  const logs = page.getByRole("region", { name: "Activity logs", exact: true });
  await expect(logs).toContainText("Saket Rao approved Mira Shah's request");
  await expect
    .soft(logs.getByText("Saket Rao revoked a member invite", { exact: true }))
    .toBeVisible();
  await expect
    .soft(logs.getByText("Mira Shah updated the project", { exact: true }))
    .toBeVisible();
  await logs
    .getByRole("button", { name: "View more logs", exact: true })
    .click();
  await expect(logs).toContainText("Mira Shah joined the project");
  await expect(logs).toContainText("Saket Rao approved Mira Shah's request");
  await expect(
    logs.getByRole("button", { name: "View more logs", exact: true }),
  ).toHaveCount(0);
  expect(await calls(page, "logs")).toEqual([
    { projectId: "project", limit: 25 },
    { projectId: "project", limit: 25, before: "older-logs" },
  ]);
  await management(page)
    .getByRole("button", { name: "Back to Members", exact: true })
    .click();
  await expect(
    settings.getByRole("heading", { name: "Members", exact: true }),
  ).toBeVisible();
});

test("Reviews stays reachable from Settings and lists every request without paging", async ({
  page,
}) => {
  await fixture(page, true, false, "many");
  const screen = reviews(page);
  await expect(screen).toBeVisible();
  const requests = section(page, "To decide");
  await expect(requests).toHaveAccessibleName("To decide 12");
  // Every request renders at once; there is no paging.
  await expect(
    requests.getByRole("button", { name: /^Request \d+$/ }),
  ).toHaveCount(12);
  for (const title of ["Request 1", "Request 12"])
    await expect(rowButton(requests, title)).toBeVisible();
  await expect(
    screen.getByRole("button", { name: "View more requests", exact: true }),
  ).toHaveCount(0);
  await expect(
    screen.getByRole("button", { name: "Requests", exact: true }),
  ).toHaveCount(0);
  await toMembers(page);
  await expect(
    page
      .getByRole("region", { name: "Settings", exact: true })
      .getByRole("heading", { name: "Members", exact: true }),
  ).toBeVisible();
});

test("switching projects keeps Reviews open and returns to Settings Members", async ({
  page,
}) => {
  await fixture(page, true, false, "multi-project");
  const screen = reviews(page);
  for (const [projectName, requestTitle] of [
    ["Second project", "Second project request"],
    ["Team · project", "Sample skill"],
  ]) {
    await page
      .getByRole("combobox", { name: "Select project", exact: true })
      .click();
    await page.getByRole("option", { name: projectName, exact: true }).click();
    await expect(screen).toBeVisible();
    await expect(
      rowButton(section(page, "To decide"), requestTitle),
    ).toBeVisible();
    await expect(
      screen.getByRole("button", {
        name: "Default member permissions",
        exact: true,
      }),
    ).toHaveCount(0);
  }
  await toMembers(page);
  await expect(
    page
      .getByRole("region", { name: "Settings", exact: true })
      .getByRole("heading", { name: "Members", exact: true }),
  ).toBeVisible();
});

async function calls(page: Page, action: string) {
  return page.evaluate(
    (action) =>
      (
        window as unknown as {
          governanceCalls: {
            args: { action?: string; input?: Record<string, unknown> };
          }[];
        }
      ).governanceCalls
        .filter((item) => item.args.action === action)
        .map((item) => item.args.input),
    action,
  );
}
const updateRow = (page: Page, title = "Sample skill") =>
  rowButton(section(page, "On this Mac"), title);
async function openUpdates(
  page: Page,
  name = "Review local update",
  title?: string,
) {
  await updateRow(page, title).click();
  return page.getByRole("dialog", { name, exact: true });
}

for (const publisher of [true, false]) {
  test(`local memory ${publisher ? "publishes directly" : "requests publisher approval"}`, async ({
    page,
  }) => {
    await fixture(
      page,
      true,
      false,
      publisher ? "draft-publisher" : "draft-suggester",
    );
    await draftRow(page).click();
    const dialog = page.getByRole("dialog", {
      name: "Review changes",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("File changes")).toContainText(
      "Saved learning",
    );
    await expect(dialog.locator(".diff-count--added")).toContainText("+1");
    await expect(
      dialog.getByRole("heading", { name: "content.md", exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", {
        name: publisher ? "Publish update" : "Send for approval",
        exact: true,
      }),
    ).toHaveClass(/ui-button--primary/);
    await expect(
      dialog.getByRole("button", { name: "Cancel", exact: true }),
    ).toHaveClass(/ui-button--tertiary/);
    await dialog
      .getByRole("button", {
        name: publisher ? "Publish update" : "Send for approval",
        exact: true,
      })
      .click();
    expect(await calls(page, "submit-draft")).toEqual([
      {
        projectId: "project",
        id: "local-memory",
        reviewedFiles: [
          { path: "content.md", hash: "fixture", size: 15, executable: false },
        ],
      },
    ]);
  });
}
test("local review compares the accepted version with additions and removals in a bounded modal", async ({
  page,
}) => {
  await page.setViewportSize({ width: 820, height: 600 });
  await fixture(page, true, false, "draft-publisher", false, {
    baseRevision: 3,
    before: {
      "content.md": "Original learning\n",
      "removed.md": "Old learning\n",
    },
    files: { "content.md": "Saved learning\n", "added.md": "New learning\n" },
  });
  await draftRow(page).click();
  const dialog = page.getByRole("dialog", {
    name: "Review changes",
    exact: true,
  });
  await expect(dialog.getByLabel("Compared versions")).toHaveText(
    "Version 3tocompared withThis Mac",
  );
  await expect(dialog.locator(".diff-card-path")).toHaveText([
    "content.md",
    "removed.md",
    "added.md",
  ]);
  await expect(
    dialog
      .getByRole("region", { name: "content.md changes", exact: true })
      .getByLabel("File changes"),
  ).toContainText("Original learning");
  await expect(
    dialog
      .getByRole("region", { name: "removed.md changes", exact: true })
      .getByLabel("File changes"),
  ).toContainText("Old learning");
  await expect(dialog.locator(".diff-card-removed")).toHaveText("Removed");
  await expect(
    dialog.getByRole("button", { name: "Publish update", exact: true }),
  ).toBeInViewport();
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(24);
  expect(bounds!.y).toBeGreaterThanOrEqual(24);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(576);
});

test("local review keeps a readable diff when modern renderer features are unavailable", async ({
  page,
}) => {
  const adapterRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/src/components/pierre-diff.tsx"))
      adapterRequests.push(request.url());
  });
  await page.addInitScript(() => {
    const supports = CSS.supports.bind(CSS);
    CSS.supports = ((...args: string[]) =>
      args.some((argument) => argument.includes("light-dark("))
        ? false
        : Reflect.apply(supports, CSS, args)) as typeof CSS.supports;
  });
  await fixture(page, true, false, "draft-publisher", false, {
    before: { "content.md": "Original learning\n" },
    baseRevision: 3,
  });
  await draftRow(page).click();
  const dialog = page.getByRole("dialog", {
    name: "Review changes",
    exact: true,
  });
  const diff = dialog.getByRole("group", { name: "File changes", exact: true });
  await expect(diff).toContainText("Original learning");
  await expect(diff).toContainText("Saved learning");
  await expect(diff.getByLabel("Removed", { exact: true })).toHaveText("−");
  await expect(diff.getByLabel("Added", { exact: true })).toHaveText("+");
  await expect(dialog.locator("diffs-container")).toHaveCount(0);
  expect(adapterRequests).toEqual([]);
});

test("local review includes executable-only changes and distinguishes binary assets from literal text", async ({
  page,
}) => {
  await fixture(page, true, false, "draft-publisher", false, {
    before: { "run.sh": "echo hello\n", "image.bin": "Binary asset" },
    files: {
      "run.sh": "echo hello\n",
      "image.bin": "Binary asset",
      "literal.txt": "Binary asset",
    },
    beforeManifest: [
      { path: "run.sh", hash: "fixture", executable: false, binary: false },
      { path: "image.bin", hash: "binary", binary: true },
    ],
    manifest: [
      { path: "run.sh", hash: "fixture", executable: true, binary: false },
      { path: "image.bin", hash: "binary", binary: true },
      { path: "literal.txt", hash: "literal", binary: false },
    ],
    baseRevision: 3,
  });
  await draftRow(page).click();
  const dialog = page.getByRole("dialog", {
    name: "Review changes",
    exact: true,
  });
  await expect(dialog.locator(".diff-card-path")).toHaveText([
    "run.sh",
    "literal.txt",
  ]);
  await expect(
    dialog.getByText("Executable permission added.", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog
      .getByRole("region", { name: "literal.txt changes", exact: true })
      .getByLabel("File changes"),
  ).toContainText("Binary asset");
  await expect(
    dialog.getByText("No file changes.", { exact: true }),
  ).toHaveCount(0);
});

test("a removed source keeps its saved preview readable and private", async ({
  page,
}) => {
  await fixture(page, true, false, "draft-publisher", false, {
    sourceUnavailable: true,
    baseRevision: 2,
    before: { "content.md": "Earlier learning\n" },
  });
  await draftRow(page).click();
  const dialog = page.getByRole("dialog", {
    name: "Review changes",
    exact: true,
  });
  await expect(
    dialog.getByRole("status").filter({
      hasText: "This source is no longer available in this project.",
    }),
  ).toContainText("The saved changes remain private on this Mac.");
  await expect(
    dialog.getByRole("group", { name: "File changes", exact: true }),
  ).toContainText("Saved learning");
  await expect(
    dialog.getByRole("button", { name: "Publish update", exact: true }),
  ).toBeDisabled();
  expect(await calls(page, "submit-draft")).toEqual([]);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await calls(page, "dismiss")).toEqual([]);
});

test("closing local review restores focus without dismissing or publishing private changes", async ({
  page,
}) => {
  await fixture(page, true, false, "draft-publisher");
  const trigger = draftRow(page);
  for (const close of ["Cancel", "Close review changes", "Escape"]) {
    await trigger.click();
    const dialog = page.getByRole("dialog", {
      name: "Review changes",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    if (close === "Escape") await page.keyboard.press("Escape");
    else await dialog.getByRole("button", { name: close, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
  expect(await calls(page, "submit-draft")).toEqual([]);
  expect(await calls(page, "dismiss")).toEqual([]);
});

test("local publication failures remain visible beside the exact reviewed version", async ({
  page,
}) => {
  await fixture(page, true, false, "draft-publisher", false, {
    baseRevision: 3,
    before: { "content.md": "Original learning\n" },
  });
  await draftRow(page).click();
  const dialog = page.getByRole("dialog", {
    name: "Review changes",
    exact: true,
  });
  await page.evaluate(() => {
    (window as any).governanceStale = true;
  });
  await dialog
    .getByRole("button", { name: "Publish update", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "The shared version changed. Review the changes again before publishing.",
  );
  await expect(dialog.getByLabel("Compared versions")).toContainText(
    "Version 3",
  );
  expect(await calls(page, "submit-draft")).toEqual([
    {
      projectId: "project",
      id: "local-memory",
      reviewedFiles: [
        { path: "content.md", hash: "fixture", size: 15, executable: false },
      ],
      reviewedRevision: 3,
    },
  ]);
});

test("an in-flight local publication keeps the review open and prevents duplicate submissions", async ({
  page,
}) => {
  await fixture(page, true, false, "draft-publisher");
  await draftRow(page).click();
  const dialog = page.getByRole("dialog", {
    name: "Review changes",
    exact: true,
  });
  await page.evaluate(() => {
    (window as any).holdDraftSubmit = true;
  });
  await dialog
    .getByRole("button", { name: "Publish update", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "Publish update", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  expect(await calls(page, "submit-draft")).toHaveLength(1);
  await page.evaluate(() => {
    (window as any).finishDraftSubmit();
  });
  await expect(dialog).toHaveCount(0);
});

// An item with both a shared update and local edits gets a row for each.
test("local edits stay reviewable when a shared update is waiting on the same item", async ({
  page,
}) => {
  await fixture(page, true, false, "draft-blocked");
  const rows = section(page, "On this Mac").getByRole("row", {
    name: /Sample skill/,
  });
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("Update blocked");
  await expect(rows.last()).toContainText("Local edits");
  await rows.last().getByRole("button", { name: "Sample skill" }).click();
  await expect(
    page.getByRole("dialog", { name: "Review changes", exact: true }),
  ).toBeVisible();
});

for (const local of [false, true]) {
  test(`${local ? "local changes" : "pending requests"} show deletion diffs when tombstones retain file metadata`, async ({
    page,
  }) => {
    await fixture(
      page,
      true,
      true,
      local ? "draft-publisher" : "owner",
      false,
      { before: { "content.md": "Saved learning\n" }, baseRevision: 3 },
    );
    await (
      local
        ? draftRow(page)
        : rowButton(section(page, "To decide"), "Sample skill")
    ).click();
    const review = local
      ? page.getByRole("dialog", { name: "Review changes", exact: true })
      : requestPage(page);
    await expect(review.locator(".diff-card-removed")).toHaveText("Removed");
    await expect(
      review.getByRole("group", { name: "File changes", exact: true }),
    ).toContainText(local ? "Saved learning" : "Previous version");
    await expect(
      review.getByText("No file changes.", { exact: true }),
    ).toHaveCount(0);
    if (!local) {
      await review
        .getByRole("button", { name: "Approve", exact: true })
        .click();
      expect(await calls(page, "decide")).toEqual([
        {
          projectId: "project",
          id: "request",
          previewHash: "reviewed-hash",
          expectedPolicyRevision: 1,
          decision: "approve",
        },
      ]);
    }
  });
}

test("request approval sends the exact reviewed hash and reports stale proposals", async ({
  page,
}) => {
  await fixture(page);
  await rowButton(section(page, "To decide"), "Sample skill").click();
  const review = requestPage(page);
  await expect(review.getByLabel("File changes")).toContainText(
    "Reviewed candidate",
  );
  await review.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(
    page.locator("[data-orka-toast]").getByRole("status"),
  ).toHaveText("Suggestion needs a fresh review");
  // A stale decision keeps its page, with the new status and no buttons.
  await expect(requestInfo(page)).toContainText("Needs refresh");
  await expect(
    review.getByRole("button", { name: "Approve", exact: true }),
  ).toHaveCount(0);
  expect(await calls(page, "decide")).toEqual([
    {
      projectId: "project",
      id: "request",
      previewHash: "reviewed-hash",
      expectedPolicyRevision: 1,
      decision: "approve",
    },
  ]);
});

test("Skills waits for confirmed role access without moving cards on workspace polls", async ({
  page,
}) => {
  await page.clock.install();
  await fixture(page, true, false, "role-policy-skills");
  await page.getByRole("button", { name: /^Skills\b/ }).click();

  const notice = page.getByText(
    "The project Owner manages access for your role.",
    { exact: true },
  );
  const toolbar = page.getByRole("group", { name: "skills tools" });
  const card = page.getByRole("button", { name: /^Sample skill\b/ });
  const positions = async () => [
    (await toolbar.boundingBox())?.y,
    (await card.boundingBox())?.y,
  ];
  const catalog = async (operation: "finish" | "fail" | "restrict") => {
    await page.evaluate((operation) => {
      const { skillCatalog } = window as unknown as {
        skillCatalog: Record<typeof operation, () => void>;
      };
      skillCatalog[operation]();
    }, operation);
  };

  await expect.poll(() => calls(page, "catalog")).toHaveLength(1);
  await expect(card).toBeVisible();
  const initialPositions = await positions();
  expect(await notice.count()).toBe(0);
  await catalog("fail");
  await page.clock.runFor(5_100);
  await expect.poll(() => calls(page, "catalog")).toHaveLength(2);
  expect(await notice.count()).toBe(0);
  expect(await positions()).toEqual(initialPositions);
  await catalog("finish");
  await page.clock.runFor(6_100);
  expect(await notice.count()).toBe(0);
  expect(await positions()).toEqual(initialPositions);
  expect(await calls(page, "catalog")).toHaveLength(2);

  await catalog("restrict");
  await page.clock.runFor(3_100);
  await expect.poll(() => calls(page, "catalog")).toHaveLength(3);
  expect(await notice.count()).toBe(0);
  await catalog("finish");
  await expect(notice).toBeVisible();
  const restrictedPositions = await positions();
  await catalog("restrict");
  await page.clock.runFor(3_100);
  await expect.poll(() => calls(page, "catalog")).toHaveLength(4);
  await expect(notice).toBeVisible();
  expect(await positions()).toEqual(restrictedPositions);
  await catalog("finish");
  await page.clock.runFor(6_100);
  await expect(notice).toBeVisible();
  expect(await positions()).toEqual(restrictedPositions);
  expect(await calls(page, "catalog")).toHaveLength(4);
});

test("access requests start from resource pages and do not appear in management", async ({
  page,
}) => {
  await fixture(page, true, false, "member");
  await expect(reviews(page)).toBeVisible();
  await expect(
    reviews(page).getByRole("button", {
      name: "Request access",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Plans 0", exact: true }).click();
  await page
    .getByRole("button", { name: "Request editing access", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Request access",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "Send request", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Access requested", exact: true }),
  ).toBeVisible();
  expect((await calls(page, "request-access"))[0]).toMatchObject({
    projectId: "project",
    class: "plan",
    mode: "publish",
  });
  expect((await calls(page, "request-access"))[0]).not.toHaveProperty(
    "resourceId",
  );
});

test("shared skill removals stay reviewable and preserve private edits", async ({
  page,
}) => {
  await fixture(page, true, true);
  const dialog = await openUpdates(page, "Review skill removal");
  await expect(dialog.getByRole("heading", { name: "SKILL.md" })).toBeVisible();
  await expect(dialog.locator(".diff-card-removed")).toHaveText("Removed");
  await dialog
    .getByRole("button", { name: "Keep edits and remove", exact: true })
    .click();
  expect((await calls(page, "apply-install"))[0]).toMatchObject({
    resourceId: "skill",
    token: "local-preview",
    preserveLocal: true,
  });
});

for (const removed of [false, true]) {
  test(`Requests keeps instruction ${removed ? "removal" : "updates"} reviewable`, async ({
    page,
  }) => {
    await fixture(page, true, removed, "instructions");
    const dialog = await openUpdates(
      page,
      "Review local update",
      "Project instructions",
    );
    await expect(dialog).toHaveClass(/governance-dialog/);
    await expect(
      dialog.getByRole("heading", {
        name: "Project instructions",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", {
        name: removed ? "Review local removal" : "Review local update",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(dialog.getByLabel("File changes")).toContainText(
      "Local edits",
    );
    await expect(
      dialog.getByText(
        `Your local edits will be saved privately on this Mac before ${removed ? "removal" : "installation"}.`,
      ),
    ).toBeVisible();
    expect(await calls(page, "preview-install")).toEqual([
      { projectId: "project", resourceId: "instructions" },
    ]);
    await dialog
      .getByRole("button", {
        name: removed ? "Keep edits and remove" : "Keep edits and install",
        exact: true,
      })
      .click();
    expect(await calls(page, "apply-install")).toEqual([
      {
        projectId: "project",
        resourceId: "instructions",
        token: "local-preview",
        preserveLocal: true,
      },
    ]);
  });
}

test("local installation rejects changes made after reviewing the preview", async ({
  page,
}) => {
  await fixture(page);
  const dialog = await openUpdates(page);
  await expect(dialog.getByLabel("File changes")).toContainText("Local edits");
  await page.evaluate(() => {
    (window as unknown as { governanceStale: boolean }).governanceStale = true;
  });
  await dialog
    .getByRole("button", { name: "Keep edits and install", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toHaveText(
    "Files changed since this preview.",
  );
  await expect(
    dialog.getByRole("button", { name: "Review latest", exact: true }),
  ).toBeVisible();
});

test("a member with no shared access can request a collection from its empty page", async ({
  page,
}) => {
  await fixture(page, true, false, "restricted");
  await page.getByRole("button", { name: "Memories 0", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Shared memories are restricted",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Request access", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Request access",
    exact: true,
  });
  await expect(
    dialog.getByLabel("Requested permission", { exact: true }),
  ).toContainText("View only");
  await dialog
    .getByRole("button", { name: "Send request", exact: true })
    .click();
  expect((await calls(page, "request-access"))[0]).toMatchObject({
    class: "memory",
    mode: "read",
    projectId: "project",
  });
});

for (const viewport of [
  { width: 900, height: 640 },
  { width: 1160, height: 800 },
]) {
  test(`request review stays visible above twelve requests at ${viewport.width}px and restores focus`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await fixture(page, true, false, "many");
    const trigger = rowButton(section(page, "To decide"), "Request 1");
    const review = requestPage(page);
    for (const leave of ["Back to Reviews", "Reviews"]) {
      await trigger.click();
      await expect(
        review.getByRole("heading", { name: "Request 1", exact: true }),
      ).toBeInViewport();
      await expect(review.getByLabel("File changes")).toContainText(
        "Reviewed candidate",
      );
      const approve = review.getByRole("button", {
        name: "Approve",
        exact: true,
      });
      await expect(approve).toBeInViewport();
      await expect(approve).toBeEnabled();
      // Focus moves onto the page, so the keyboard does not stay on a hidden row.
      await expect(reviews(page)).toBeFocused();
      await expect(
        page.getByRole("navigation", { name: "Requests", exact: true }),
      ).toContainText("1 of 12");
      await page
        .getByRole("button", {
          name: leave === "Reviews" ? /^Reviews\b/ : leave,
        })
        .first()
        .click();
      await expect(review).toHaveCount(0);
      await expect(trigger).toBeVisible();
      if (leave === "Back to Reviews") await expect(trigger).toBeFocused();
    }
    expect(await calls(page, "decide")).toEqual([]);
    expect(await calls(page, "request")).toEqual(
      Array(2).fill({ projectId: "project", id: "request-0" }),
    );
  });
}

test("request review loads in place, retries failed reads, and respects review permission", async ({
  page,
}) => {
  await fixture(page, true, false, "request-viewer");
  await page.evaluate(() => {
    (window as any).holdRequestLoad = true;
    (window as any).requestLoadFailure = true;
  });
  await rowButton(section(page, "Sent by you"), "Sample skill").click();
  const review = requestPage(page);
  // The name comes from the list, so it is there while the rest loads.
  await expect(
    review.getByRole("heading", { name: "Sample skill", exact: true }),
  ).toBeVisible();
  await expect(review.getByLabel("File changes")).toHaveCount(0);
  await page.evaluate(() => (window as any).finishRequestLoad());
  await expect(review.getByRole("alert")).toContainText(
    "Couldn’t load this request",
  );
  await page.evaluate(() => {
    (window as any).holdRequestLoad = false;
    (window as any).requestLoadFailure = false;
  });
  await review.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(review.getByLabel("File changes")).toContainText(
    "Reviewed candidate",
  );
  await expect(requestInfo(page)).toContainText("Awaiting approval");
  await expect(
    review.getByRole("button", { name: "Approve", exact: true }),
  ).toHaveCount(0);
  await expect(
    review.getByRole("button", { name: "Reject", exact: true }),
  ).toHaveCount(0);
  expect(await calls(page, "read-notification")).toEqual([
    { projectId: "project", id: "request" },
  ]);
});

test("request decisions lock the page while sending, and a stale result stays with its new status", async ({
  page,
}) => {
  await fixture(page);
  const trigger = rowButton(section(page, "To decide"), "Sample skill");
  await trigger.click();
  const review = requestPage(page);
  await page.evaluate(() => {
    (window as any).holdRequestDecision = true;
  });
  const approve = review.getByRole("button", { name: "Approve", exact: true });
  await approve.click();
  await expect(approve).toBeDisabled();
  await expect(
    review.getByRole("button", { name: "Reject", exact: true }),
  ).toBeDisabled();
  expect(await calls(page, "decide")).toHaveLength(1);
  await page.evaluate(() => (window as any).finishRequestDecision());
  await expect(requestInfo(page)).toContainText("Needs refresh");
  await expect(approve).toHaveCount(0);
  await page.getByRole("button", { name: "Back to Reviews" }).click();
  await expect(review).toHaveCount(0);
  await expect(reviews(page)).toBeFocused();
  await expect(trigger).toHaveCount(0);
  await expect(section(page, "To decide")).toHaveCount(0);
  await reviews(page)
    .getByRole("button", { name: "History", exact: true })
    .click();
  await expect(
    reviews(page)
      .getByRole("region", { name: "Requests", exact: true })
      .getByRole("row", { name: /Sample skill/ }),
  ).toContainText("Needs refresh");
});

test("instruction previews load directly, recover from failures, and require a fresh review after edits", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 640 });
  await fixture(page, true, false, "instructions");
  await page.evaluate(() => {
    (window as any).holdInstallPreview = true;
    (window as any).installPreviewFailure = true;
  });
  const trigger = updateRow(page, "Project instructions");
  await trigger.click();
  const dialog = page.getByRole("dialog", {
    name: "Review local update",
    exact: true,
  });
  await expect(dialog.getByRole("status")).toHaveText("Loading update…");
  await page.evaluate(() => (window as any).finishInstallPreview());
  await expect(dialog.getByRole("alert")).toContainText(
    "Could not prepare the comparison",
  );
  await page.evaluate(() => {
    (window as any).holdInstallPreview = false;
    (window as any).installPreviewFailure = false;
  });
  await dialog.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(dialog.getByLabel("File changes")).toContainText(
    "Approved instructions",
  );
  const install = dialog.getByRole("button", {
    name: "Keep edits and install",
    exact: true,
  });
  await expect(install).toBeInViewport();
  await expect(install).toHaveAccessibleDescription(
    "Your local edits will be saved privately on this Mac before installation.",
  );
  const header = await dialog.locator(".review-header").evaluate((element) => {
    const heading = element.querySelector("h2")!;
    const close = element.querySelector("button")!;
    const h = heading.getBoundingClientRect();
    const c = close.getBoundingClientRect();
    return {
      fontSize: getComputedStyle(heading).fontSize,
      offset: Math.abs(h.y + h.height / 2 - c.y - c.height / 2),
    };
  });
  expect(header.fontSize).toBe("20px");
  expect(header.offset).toBeLessThanOrEqual(1);
  await page.evaluate(() => {
    (window as any).governanceStale = true;
  });
  await install.click();
  await expect(dialog.getByRole("status")).toContainText(
    "Files changed since this preview",
  );
  await expect(install).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).governanceStale = false;
  });
  await dialog
    .getByRole("button", { name: "Review latest", exact: true })
    .click();
  await expect(install).toBeVisible();
  expect(await calls(page, "preview-install")).toHaveLength(3);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(trigger).toBeFocused();
});

test("legacy activation keeps the consequence visible and migration details available on demand", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 640 });
  await fixture(page, false);
  const activation = reviews(page).getByRole("region", {
    name: "Enable project permissions",
    exact: true,
  });
  await expect(activation).toContainText(
    "Shared memory and skill changes will need approval unless you allow editing.",
  );
  const button = activation.getByRole("button", {
    name: "Enable project permissions",
    exact: true,
  });
  await expect(button).toBeInViewport();
  await expect(button).toHaveClass(/ui-button--primary/);
  await expect(
    activation.getByText(/queued changes on this Mac keep their content/),
  ).not.toBeVisible();
  await activation
    .getByText("What happens to existing work?", { exact: true })
    .click();
  await expect(
    activation.getByText(/queued changes on this Mac keep their content/),
  ).toBeVisible();
  await expect(activation).toContainText("Existing Macs need an updated app.");
  await expect(activation).toContainText(
    "Project instructions need local review before installation.",
  );
  await button.click();
  expect(await calls(page, "activate")).toEqual([
    {
      projectId: "project",
      expectedPolicyRevision: 0,
      rules: defaultProjectRules,
    },
  ]);
  await expect(activation).toHaveCount(0);
});
