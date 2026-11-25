import test from "node:test";
import assert from "node:assert/strict";
import type { Resource, SessionConflict } from "@portable/protocol";
import type { Snapshot } from "../apps/mac/src/types.js";
import { projectAttention } from "../apps/mac/src/components/sync-attention.js";
import { recoveryEpisodes } from "../apps/mac/src/components/session-recovery.js";

function fixture(minutes = [0, 5, 9]) {
  const resources: Resource[] = minutes.map((_, i) => ({
    resourceId: String(i),
    projectId: "project",
    kind: "session",
    title: "Session " + i,
    owner: "owner",
    source: "codex",
    logicalPath: "codex/" + i,
    updatedAt: "2026-11-13T10:00:00Z",
    updatedBy: "owner",
    revision: 5 + i,
    files: [],
    deleted: true,
    hash: "deleted",
  }));
  const conflicts: SessionConflict[] = resources.map((r, i) => ({
    id: "incoming-" + i,
    resourceId: r.resourceId,
    author: r.owner,
    deviceId: "laptop",
    revision: r.revision,
    candidate: {
      ...r,
      updatedAt: new Date(Date.UTC(2026, 10, 13, 11, minutes[i])).toISOString(),
      deleted: false,
      files: [
        { path: "session.jsonl", hash: "file", size: 10, executable: false },
      ],
    },
  }));
  const state: Snapshot = {
    resources,
    conflicts,
    user: "owner",
    projects: [],
    errors: resources.map((r) => ({
      source: r.resourceId,
      error: "Session conflict: choose Keep, Override, or Create copy",
    })),
    drafts: [],
    outbox: [],
    bindings: [],
    reviewRequests: [],
    config: null,
    sync: null,
    daemon: null,
    devices: null,
    deviceId: "local-device",
    activity: [],
    background: true,
  };
  return state;
}

function grouped(state: Snapshot) {
  return recoveryEpisodes(
    state,
    projectAttention(state, "project").items,
    "project",
  ).map((group) => group.sessions.map((s) => s.id));
}

await test("the five-minute window includes its endpoints and does not chain through later arrivals", () => {
  assert.deepEqual(grouped(fixture()), [["0", "1"]]);
  assert.deepEqual(grouped(fixture([0, 6])), []);
  assert.deepEqual(grouped(fixture([9, 5, 0, 10])), [
    ["2", "1"],
    ["0", "3"],
  ]);
});

await test("only same-device owned, matching live session copies can participate", () => {
  const exceptions: ((s: Snapshot) => void)[] = [
    (s) => {
      s.conflicts[0].deviceId = "";
    },
    (s) => {
      s.conflicts[0].deviceId = "other-device";
    },
    (s) => {
      s.conflicts[0].author = "another-person";
    },
    (s) => {
      s.resources[0].owner = "another-person";
    },
    (s) => {
      s.conflicts[0].candidate.projectId = "other-project";
    },
    (s) => {
      s.resources[0].projectId = "other-project";
    },
    (s) => {
      s.conflicts[0].candidate.updatedAt = "unknown";
    },
    (s) => {
      s.conflicts[0].candidate.updatedAt = "2026-11-13T11:00:00";
    },
    (s) => {
      s.conflicts[0].candidate.sourceId = "other-source";
    },
    (s) => {
      s.conflicts[0].candidate.logicalPath = "other-path";
    },
    (s) => {
      s.resources[0].revision++;
    },
    (s) => {
      s.conflicts[0].candidate.files = [];
    },
    (s) => {
      s.resources[0].deleted = false;
    },
    (s) => {
      s.conflicts[0].candidate.deleted = true;
    },
    (s) => {
      s.conflicts.push({ ...s.conflicts[0], id: "another-candidate" });
    },
    (s) => {
      s.outbox.push({
        id: "queued",
        project: "project",
        resourceId: "0",
        error: null,
      });
    },
    (s) => {
      s.errors.push({ source: "0", error: "Review the local session" });
    },
    (s) => {
      s.user = "another-person";
    },
  ];
  exceptions.push((s) => {
    s.errors.push({
      source: "project:installation:0",
      error: "Session conflict: choose Keep, Override, or Create copy",
    });
  });
  for (const change of exceptions) {
    const state = fixture([0, 1]);
    change(state);
    assert.deepEqual(grouped(state), [], String(change));
  }
});
