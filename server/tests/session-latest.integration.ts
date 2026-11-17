import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import type {
  Change,
  Event,
  Receipt,
  ResourceInput,
  SessionCopy,
} from "@portable/protocol";
import { Store } from "./bridge/store.js";
import { createApi } from "./bridge/main.js";
import { OrkaReader } from "./bridge/mcp.js";
import { Blobs, bytesHash } from "./fixtures/blobs.js";
import { acceptingMemoryResolver } from "./fixtures/memory-fixtures.js";

await test("latest complete sessions preserve sync, exact cached copies and conflicts without revision files", async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const directory = await mkdtemp(join(tmpdir(), "orka-latest-session-"));
  const store = new Store(
    pool,
    new Blobs(directory),
    acceptingMemoryResolver(),
  );
  const owner = randomUUID(),
    member = randomUUID(),
    outsider = randomUUID();
  const project = await store.createProject(
    owner,
    "Latest complete sessions",
    true,
  );
  await pool.query("insert into orka.members values($1,$2,'member')", [
    project,
    member,
  ]);
  await store.device(owner, owner, "Owner Mac");
  await store.device(member, member, "Member Mac");
  const server = createApi(store, async (token) => token);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const api = async <T = Record<string, unknown>>(
    path: string,
    input?: unknown,
    user = owner,
  ) => {
    const response = await fetch(origin + path, {
      method: input === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${user}`,
        "Content-Type": "application/json",
        "X-Orka-Governance": "1",
      },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    return { status: response.status, value: (await response.json()) as T };
  };
  const upload = async (
    content: string,
    path = "session.jsonl",
    user = owner,
  ) => {
    const bytes = Buffer.from(content),
      hash = bytesHash(bytes);
    const response = await fetch(`${origin}/v2/blobs/${project}/${hash}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${user}`, "X-Orka-Governance": "1" },
      body: bytes,
    });
    assert.equal(response.status, 200);
    return { path, hash, size: bytes.length, executable: false };
  };
  const sessionId = randomUUID();
  const transcript = (...messages: string[]) =>
    messages
      .map(
        (content, index) =>
          JSON.stringify({
            type: index % 2 ? "assistant" : "user",
            sessionId,
            message: { role: index % 2 ? "assistant" : "user", content },
          }) + "\n",
      )
      .join("");
  const reader = new OrkaReader(store, owner, origin);
  const outside = new OrkaReader(store, outsider, origin);
  const policyRevision = Number(
    (
      await pool.query(
        "select policy_revision from orka.projects where id=$1",
        [project],
      )
    ).rows[0].policy_revision,
  );
  const pull = () =>
    api<{ events: Event[]; cursor: number; hasMore: boolean }>(
      `/v2/sync/pull?projectId=${project}&cursor=0&governance=1&policyRevision=${policyRevision}`,
    );
  try {
    assert.equal(
      (await api("/v2/projects/capabilities")).value.sessionLatestOnly,
      1,
    );
    const originalText = transcript("First complete turn");
    const original: ResourceInput = {
      resourceId: randomUUID(),
      kind: "session",
      source: "claude",
      logicalPath: `claude/${sessionId}`,
      title: "Complete conversation",
      deleted: false,
      files: [
        await upload(originalText),
        await upload("Inherited context\n", "lineage/source/1.jsonl"),
      ],
    };
    const first: Change = {
      version: 2,
      id: randomUUID(),
      projectId: project,
      deviceId: owner,
      baseRevision: 0,
      resource: original,
    };
    const firstAck = await store.mutate(owner, first);
    const latest: Change = {
      ...first,
      id: randomUUID(),
      baseRevision: firstAck.event.revision,
      resource: {
        ...original,
        files: [
          await upload(
            transcript("First complete turn", "Second complete turn"),
          ),
          original.files[1],
        ],
      },
    };
    const latestAck = await store.mutate(owner, latest);
    assert.deepEqual(
      (
        await pool.query(
          "select revision from orka.snapshots where project_id=$1 and resource_id=$2",
          [project, original.resourceId],
        )
      ).rows,
      [{ revision: String(latestAck.event.revision) }],
    );

    // Simulate collection of the superseded transcript; event and receipt
    // metadata remain, and no reader may require those bytes to replay sync.
    await pool.query("delete from orka.blobs where project_id=$1 and hash=$2", [
      project,
      original.files[0].hash,
    ]);
    await rm(join(directory, project, original.files[0].hash));
    const feed = await pull();
    assert.equal(feed.status, 200);
    assert.equal(feed.value.cursor, latestAck.event.revision);
    assert.equal(feed.value.hasMore, false);
    assert.equal(feed.value.events[0].revision, firstAck.event.revision);
    for (const event of feed.value.events) {
      assert.deepEqual(event.resource.files, latest.resource.files);
      assert.equal(event.resource.revision, latestAck.event.revision);
    }
    assert.ok(
      !JSON.stringify(feed.value.events).includes(original.files[0].hash),
    );
    assert.deepEqual(
      await store.mutate(owner, first),
      firstAck,
      "A mutation retry must ACK the sender's original bytes, never rebase its native binding to newer bytes",
    );
    await assert.rejects(
      store.blobs.read(project, original.files[0].hash),
      /ENOENT/,
    );

    for (const name of ["get_resource_history", "compare_revisions"]) {
      const input = {
        projectId: project,
        resourceId: original.resourceId,
        ...(name === "compare_revisions"
          ? {
              fromRevision: firstAck.event.revision,
              toRevision: latestAck.event.revision,
            }
          : {}),
      };
      await assert.rejects(
        reader.run(name, input),
        /only the latest complete snapshot/,
      );
      await assert.rejects(outside.run(name, input), /Project access denied/);
    }
    // Governed current-file access must not depend on a historical snapshot row.
    await pool.query(
      "delete from orka.snapshots where project_id=$1 and resource_id=$2",
      [project, original.resourceId],
    );
    assert.equal(
      (
        await fetch(
          `${origin}/v2/blobs/${project}/${latest.resource.files[0].hash}`,
          {
            headers: {
              Authorization: `Bearer ${member}`,
              "X-Orka-Governance": "1",
            },
          },
        )
      ).status,
      200,
    );

    const stale = await store.mutate(owner, {
      ...first,
      id: randomUUID(),
      baseRevision: firstAck.event.revision,
      resource: {
        ...original,
        files: [
          await upload(
            transcript("First complete turn", "A concurrent continuation"),
          ),
          original.files[1],
        ],
      },
    });
    assert.equal(stale.conflict, true);
    assert.equal(stale.event.conflicts.length, 1);
    assert.deepEqual(stale.event.resource.files, latest.resource.files);
    await assert.rejects(
      store.mutate(owner, {
        ...first,
        id: randomUUID(),
        baseRevision: 999999,
        resource: latest.resource,
      }),
      /Unknown base revision/,
    );

    const legacyCopy: SessionCopy = {
      version: 2,
      id: randomUUID(),
      projectId: project,
      deviceId: member,
      resourceId: original.resourceId,
      expectedRevision: firstAck.event.revision,
    };
    const rejected = await api("/v2/sessions/copy", legacyCopy, member);
    assert.equal(rejected.status, 409);
    assert.equal(rejected.value.error, "Cached session revision unavailable");
    assert.equal(
      (
        await pool.query(
          "select 1 from orka.receipts where project_id=$1 and id=$2",
          [project, legacyCopy.id],
        )
      ).rowCount,
      0,
    );
    const currentLegacyCopy = await store.copy(member, {
      ...legacyCopy,
      id: randomUUID(),
      expectedRevision: stale.event.resource.revision,
    });
    assert.deepEqual(
      currentLegacyCopy.event.resource.files,
      latest.resource.files,
    );
    await upload(originalText, "session.jsonl", member);
    const copyInput: SessionCopy = {
      ...legacyCopy,
      id: randomUUID(),
      sourceSnapshot: original,
    };
    const response = await api<Receipt>("/v2/sessions/copy", copyInput, member);
    assert.equal(response.status, 200);
    const copied = response.value;
    assert.deepEqual(copied.event.resource.files, original.files);
    assert.equal(copied.event.resource.owner, member);
    assert.equal(copied.event.activity?.notifyOwner, owner);
    assert.ok(
      copied.event.resource.contextSources?.includes(original.resourceId),
    );
    assert.deepEqual(
      (await api<Receipt>("/v2/sessions/copy", copyInput, member)).value,
      copied,
    );
    const changedCopy = await api(
      "/v2/sessions/copy",
      {
        ...copyInput,
        sourceSnapshot: latest.resource,
      },
      member,
    );
    assert.equal(
      changedCopy.status,
      409,
      "A retry cannot replace its frozen cached source",
    );
    const invalid = await api(
      "/v2/sessions/copy",
      {
        ...copyInput,
        id: randomUUID(),
        sourceSnapshot: { ...original, projectId: project },
      },
      member,
    );
    assert.equal(invalid.status, 400);

    const resolved = await store.resolve(owner, {
      version: 2,
      id: randomUUID(),
      projectId: project,
      deviceId: owner,
      resourceId: original.resourceId,
      expectedRevision: stale.event.resource.revision,
      conflictId: stale.event.conflicts[0].id,
      action: "copy",
      selected: "candidate",
    });
    assert.equal(resolved.event.related?.[0].conflicts.length, 0);
    assert.deepEqual(
      (
        await pool.query(
          "select revision from orka.snapshots where project_id=$1 and resource_id=$2",
          [project, original.resourceId],
        )
      ).rows,
      [{ revision: String(resolved.event.related![0].resource.revision) }],
    );
    const afterResolution = await pull();
    for (const event of afterResolution.value.events) {
      assert.equal(
        event.conflicts.length,
        0,
        "Feed must not replay resolved candidate files",
      );
      for (const related of event.related ?? [])
        assert.equal(related.conflicts.length, 0);
    }
    const originalCurrent = resolved.event.related![0].resource;
    for (const event of afterResolution.value.events.filter(
      (e) => e.resource.resourceId === original.resourceId,
    )) {
      assert.equal(event.resource.revision, originalCurrent.revision);
      assert.deepEqual(event.resource.files, originalCurrent.files);
    }

    // Connector operation receipts are also immutable ACKs. Their old session
    // manifest metadata must not pin the transcript or require reading it again.
    const connectorCandidate = await upload(
      transcript("First complete turn", "Connector candidate"),
    );
    const connectorConflict = await store.mutate(owner, {
      ...first,
      id: randomUUID(),
      baseRevision: firstAck.event.revision,
      resource: { ...original, files: [connectorCandidate, original.files[1]] },
    });
    const connectorInput = {
      projectId: project,
      resourceId: original.resourceId,
      action: "accept",
      requestId: randomUUID(),
      expectedRevision: connectorConflict.event.resource.revision,
      conflictId: connectorConflict.event.conflicts[0].id,
      selected: "candidate",
    };
    const connectorAck = (await reader.run(
      "resolve_conflict",
      connectorInput,
    )) as Receipt;
    await store.mutate(owner, {
      ...latest,
      id: randomUUID(),
      baseRevision: connectorAck.event.resource.revision,
    });
    await pool.query("delete from orka.blobs where project_id=$1 and hash=$2", [
      project,
      connectorCandidate.hash,
    ]);
    await rm(join(directory, project, connectorCandidate.hash));
    assert.deepEqual(
      await reader.run("resolve_conflict", connectorInput),
      connectorAck,
    );

    // Document revision history and comparisons retain their existing behavior.
    const plan: ResourceInput = {
      resourceId: randomUUID(),
      kind: "plan",
      source: "codex",
      logicalPath: "codex/plans/feature.md",
      title: "Feature plan",
      deleted: false,
      files: [await upload("# First plan\n", "content.md")],
    };
    const planFirst = await store.mutate(owner, {
      ...first,
      id: randomUUID(),
      resource: plan,
    });
    const planLast = await store.mutate(owner, {
      ...first,
      id: randomUUID(),
      baseRevision: planFirst.event.revision,
      resource: {
        ...plan,
        files: [await upload("# Revised plan\n", "content.md")],
      },
    });
    const history = (await reader.run("get_resource_history", {
      projectId: project,
      resourceId: plan.resourceId,
    })) as { items: unknown[] };
    assert.equal(history.items.length, 2);
    const comparison = (await reader.run("compare_revisions", {
      projectId: project,
      resourceId: plan.resourceId,
      fromRevision: planFirst.event.revision,
      toRevision: planLast.event.revision,
    })) as { before: string; after: string };
    assert.equal(comparison.before, "# First plan\n");
    assert.equal(comparison.after, "# Revised plan\n");

    await pool.query("insert into orka.resource_access values($1,$2,$3,$4)", [
      project,
      original.resourceId,
      member,
      { mode: "hidden", canShare: false },
    ]);
    assert.equal(
      (
        await api(
          "/v2/sessions/copy",
          { ...copyInput, id: randomUUID() },
          member,
        )
      ).status,
      403,
    );
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
});
