import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionTree } from "../apps/mac/src/components/session-tree.js";
import type { ProjectResource } from "../apps/mac/src/types.js";

const resource = (
  id: string,
  parentId?: string,
  projectId = "project",
): ProjectResource => ({
  resourceId: id,
  projectId,
  source: "codex",
  kind: "session",
  logicalPath: `codex/${id}`,
  title: id,
  revision: 1,
  owner: "user",
  updatedBy: "user",
  updatedAt: "2026-11-02T00:00:00Z",
  deleted: false,
  hash: "hash",
  files: [],
  ...(parentId
    ? {
        fork: {
          parentId,
          nativeId: id,
          destination: "desktop",
          createdAt: "2026-11-02T00:00:00Z",
        },
      }
    : {}),
});

void test("fork trees preserve sibling sort order, nested parents, and filtered orphans", () => {
  const list = [
    resource("newest", "source"),
    resource("grandchild", "older"),
    resource("source"),
    resource("older", "source"),
    resource("other"),
  ];
  const tree = sessionTree(list);
  assert.deepEqual(Object.fromEntries(tree.parents), {
    newest: "source",
    grandchild: "older",
    older: "source",
  });
  assert.deepEqual(
    tree.children.get("source")?.map((r) => r.resourceId),
    ["newest", "older"],
  );
  assert.equal(
    sessionTree(list.filter((r) => r.resourceId === "grandchild")).parents.size,
    0,
  );
});

void test("invalid lineage cannot hide sessions or join different projects and repositories", () => {
  const list = [
    resource("a", "b"),
    resource("b", "a"),
    resource("self", "self"),
    resource("orphan", "gone"),
    resource("foreign", "orphan", "other-project"),
    { ...resource("other-repo", "orphan"), sourceId: "different" },
  ];
  const tree = sessionTree(list);
  assert.equal(tree.parents.size, 0);
  assert.equal(tree.children.size, 0);
});

void test("native lineage nests local forks and gives Orka-recorded lineage precedence", () => {
  const parent = resource("parent");
  const native = {
    ...resource("native"),
    nativeForkParentId: parent.resourceId,
  };
  const managed = {
    ...resource("managed", native.resourceId),
    nativeForkParentId: parent.resourceId,
  };
  const tree = sessionTree([managed, native, parent]);
  assert.deepEqual(Object.fromEntries(tree.parents), {
    managed: "native",
    native: "parent",
  });
  assert.equal(sessionTree([native]).parents.size, 0);
});
