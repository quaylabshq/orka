import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import type {
  Change,
  Receipt,
  ResourceInput,
  SessionCopy,
} from "@portable/protocol";
import { Store } from "./bridge/store.js";
import { createApi } from "./bridge/main.js";
import { Blobs, bytesHash } from "./fixtures/blobs.js";

type Outcome =
  { status: "accepted"; receipt: Receipt } | { status: "cancelled" };

await test("session upload reconciliation recovers original receipts and fences replacement identities", async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const directory = await mkdtemp(join(tmpdir(), "orka-session-reconcile-"));
  const store = new Store(pool, new Blobs(directory));
  const owner = randomUUID(),
    member = randomUUID(),
    outsider = randomUUID();
  const project = await store.createProject(
    owner,
    "Session reconciliation",
    true,
  );
  const otherProject = await store.createProject(
    owner,
    "Separate receipt scope",
    true,
  );
  await pool.query("insert into orka.members values($1,$2,'member')", [
    project,
    member,
  ]);
  for (const user of [owner, member, outsider])
    await store.device(user, user, "Fixture Mac");
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
  const reconcile = (
    id: string,
    user = owner,
    projectId = project,
    deviceId = user,
  ) =>
    api<Outcome>("/v2/sessions/reconcile", { projectId, deviceId, id }, user);
  try {
    assert.equal(
      (await api("/v2/projects/capabilities")).value.sessionUploadReconcile,
      1,
    );
    const source: ResourceInput = {
      resourceId: randomUUID(),
      kind: "session",
      source: "claude",
      logicalPath: `claude/${randomUUID()}`,
      title: "Use sk-abcdefghijklmnopqrstuvwx",
      deleted: false,
      files: [
        await upload(
          '{"message":{"content":"Use sk-abcdefghijklmnopqrstuvwx"}}\n',
        ),
      ],
    };
    const original: Change = {
      version: 2,
      id: randomUUID(),
      projectId: project,
      deviceId: owner,
      baseRevision: 0,
      resource: source,
    };
    const pushed = await api<Receipt>("/v2/sync/push", original);
    assert.equal(pushed.status, 200);
    await upload(
      '{"message":{"content":"Use sk-abcdefghijklmnopqrstuvwx"}}\n',
      "session.jsonl",
      member,
    );
    const copy: SessionCopy = {
      version: 2,
      id: randomUUID(),
      projectId: project,
      deviceId: member,
      resourceId: source.resourceId,
      expectedRevision: pushed.value.event.resource.revision,
      sourceSnapshot: source,
    };
    const copied = await api<Receipt>("/v2/sessions/copy", copy, member);
    assert.equal(copied.status, 200);

    const latestSource = {
      ...source,
      title: "Newer conversation",
      files: [await upload('{"message":{"content":"Newer conversation"}}\n')],
    };
    const advanced = await api<Receipt>("/v2/sync/push", {
      ...original,
      id: randomUUID(),
      baseRevision: pushed.value.event.resource.revision,
      resource: latestSource,
    });
    assert.equal(advanced.status, 200);
    const latestCopy: ResourceInput = {
      ...latestSource,
      resourceId: copy.id,
      logicalPath: `copies/${copy.id}`,
      files: [
        await upload(
          '{"message":{"content":"Newer owned copy"}}\n',
          "session.jsonl",
          member,
        ),
      ],
    };
    assert.equal(
      (
        await api(
          "/v2/sync/push",
          {
            ...original,
            id: randomUUID(),
            deviceId: member,
            baseRevision: copied.value.event.resource.revision,
            resource: latestCopy,
          },
          member,
        )
      ).status,
      200,
    );

    // Rebuilding an uncertain body under its old ID fails. Receipt recovery
    // supplies the original ACK without sending either old snapshot back.
    assert.equal(
      (await api("/v2/sync/push", { ...original, resource: latestSource }))
        .status,
      409,
    );
    assert.deepEqual((await reconcile(original.id)).value, {
      status: "accepted",
      receipt: pushed.value,
    });
    assert.deepEqual((await reconcile(copy.id, member)).value, {
      status: "accepted",
      receipt: copied.value,
    });
    assert.deepEqual((await reconcile(copy.id, member)).value, {
      status: "accepted",
      receipt: copied.value,
    });
    assert.equal(
      (
        await pool.query(
          "select count(*)::int as count from orka.resources where project_id=$1 and payload->>'kind'='session'",
          [project],
        )
      ).rows[0].count,
      2,
    );

    // An uncommitted identity is fenced even if a delayed old client submits
    // it after cancellation. Reconciliation itself adds no event/revision.
    const pending: Change = {
      ...original,
      id: randomUUID(),
      resource: {
        ...source,
        resourceId: randomUUID(),
        logicalPath: `claude/${randomUUID()}`,
      },
    };
    const before = (
      await pool.query("select revision from orka.projects where id=$1", [
        project,
      ])
    ).rows[0].revision;
    assert.deepEqual((await reconcile(pending.id)).value, {
      status: "cancelled",
    });
    assert.deepEqual((await reconcile(pending.id)).value, {
      status: "cancelled",
    });
    const late = await api("/v2/sync/push", pending);
    assert.equal(late.status, 409);
    assert.equal(late.value.error, "Session upload request was cancelled");
    assert.equal(
      (
        await pool.query("select revision from orka.projects where id=$1", [
          project,
        ])
      ).rows[0].revision,
      before,
    );
    const replacement = {
      ...pending,
      id: randomUUID(),
      resource: {
        ...pending.resource,
        title: "[REDACTED]",
        files: [await upload('{"message":{"content":"[REDACTED]"}}\n')],
      },
    };
    assert.equal((await api("/v2/sync/push", replacement)).status, 200);
    const cancelledCopy = {
      ...copy,
      id: randomUUID(),
      expectedRevision: advanced.value.event.resource.revision,
      sourceSnapshot: latestSource,
    };
    assert.deepEqual((await reconcile(cancelledCopy.id, member)).value, {
      status: "cancelled",
    });
    assert.equal(
      (await api("/v2/sessions/copy", cancelledCopy, member)).status,
      409,
    );

    // Either publication wins the same lock and has a recoverable receipt, or
    // cancellation wins and publication cannot slip through afterwards.
    const racing: Change = {
      ...replacement,
      id: randomUUID(),
      resource: {
        ...replacement.resource,
        resourceId: randomUUID(),
        logicalPath: `claude/${randomUUID()}`,
      },
    };
    const [racedPush, racedOutcome] = await Promise.all([
      api<Receipt>("/v2/sync/push", racing),
      reconcile(racing.id),
    ]);
    if (racedOutcome.value.status === "accepted") {
      assert.equal(racedPush.status, 200);
      assert.deepEqual(racedOutcome.value.receipt, racedPush.value);
    } else {
      assert.equal(racedPush.status, 409);
      assert.equal(
        (
          await pool.query(
            "select 1 from orka.resources where project_id=$1 and id=$2",
            [project, racing.resource.resourceId],
          )
        ).rowCount,
        0,
      );
    }

    // Receipts and fences belong to the authenticated author and project.
    assert.deepEqual((await reconcile(original.id, member)).value, {
      status: "cancelled",
    });
    assert.deepEqual((await reconcile(original.id)).value, {
      status: "accepted",
      receipt: pushed.value,
    });
    assert.deepEqual(
      (await reconcile(original.id, owner, otherProject)).value,
      { status: "cancelled" },
    );
    assert.equal((await reconcile(original.id, outsider)).status, 403);
    assert.equal(
      (await reconcile(original.id, owner, project, member)).status,
      403,
    );
    assert.equal(
      (await reconcile(original.id, owner, randomUUID())).status,
      403,
    );
    assert.equal(
      (
        await api("/v2/sessions/reconcile", {
          projectId: project,
          deviceId: owner,
          id: original.id,
          sourceSnapshot: source,
        })
      ).status,
      400,
    );

    await pool.query("insert into orka.resource_access values($1,$2,$3,$4)", [
      project,
      copy.id,
      member,
      { mode: "hidden", canShare: false },
    ]);
    assert.equal((await reconcile(copy.id, member)).status, 403);
    await pool.query("delete from orka.resource_access where project_id=$1", [
      project,
    ]);
    await pool.query(
      "delete from orka.members where project_id=$1 and user_id=$2",
      [project, member],
    );
    assert.equal((await reconcile(copy.id, member)).status, 403);

    const plan: Change = {
      ...original,
      id: randomUUID(),
      resource: {
        resourceId: randomUUID(),
        kind: "plan",
        source: "codex",
        logicalPath: `codex/plans/${randomUUID()}.md`,
        title: "Plan",
        deleted: false,
        files: [await upload("Plan content\n", "content.md")],
      },
    };
    assert.equal((await api("/v2/sync/push", plan)).status, 200);
    assert.equal((await reconcile(plan.id)).status, 409);
    await pool.query("update orka.projects set archived_at=now() where id=$1", [
      project,
    ]);
    assert.equal((await reconcile(original.id)).status, 403);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await pool.query("delete from orka.projects where id=any($1::uuid[])", [
      [project, otherProject],
    ]);
    await pool.query("delete from orka.devices where owner=any($1::uuid[])", [
      [owner, member, outsider],
    ]);
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
});
