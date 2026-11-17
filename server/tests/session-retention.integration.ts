import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import { Blobs } from "./fixtures/blobs.js";
import { Store } from "./bridge/store.js";
import { createApi } from "./bridge/main.js";

const binary =
  process.env.ORKA_RETENTION_SERVER_BIN ??
  process.env.ORKA_GO_SERVER_BIN ??
  resolve("artifacts/bin/orka-server");
async function fixture(
  run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>,
) {
  const f = await setup();
  try {
    await run(f);
  } finally {
    await f.pool.query("delete from orka.projects where id=$1", [f.project]);
    await f.pool.end();
    await rm(f.root, { recursive: true, force: true });
  }
}
async function setup() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const root = await mkdtemp(join(tmpdir(), "orka-session-retention-"));
  const project = randomUUID(),
    owner = randomUUID();
  await pool.query(
    "insert into orka.projects(id,name,created_by,source_model) values($1,'Retention fixture',$2,1)",
    [project, owner],
  );
  await pool.query("insert into orka.members values($1,$2,'owner')", [
    project,
    owner,
  ]);
  const blobs = new Blobs(root);
  const file = async (label: string, recent = false, knownSession = true) => {
    const content = Buffer.from(
      JSON.stringify({ type: "session_meta", payload: { id: randomUUID() } }) +
        "\n" +
        JSON.stringify({
          type: "event_msg",
          payload: { type: "user_message", message: label },
        }) +
        "\n",
    );
    const hash = await blobs.put(project, content);
    await pool.query(
      "insert into orka.blobs(project_id,hash,size,created_at) values($1,$2,$3,now()-$4::interval)",
      [project, hash, content.length, recent ? "0 seconds" : "2 days"],
    );
    if (knownSession)
      await pool.query(
        "insert into orka.session_blob_candidates values($1,$2) on conflict do nothing",
        [project, hash],
      );
    return {
      path: "session.jsonl",
      hash,
      size: content.length,
      executable: false,
      content,
    };
  };
  const resource = (
    id: string,
    revision: number,
    files: unknown[],
    kind = "session",
  ) => ({
    resourceId: id,
    projectId: project,
    owner,
    updatedBy: owner,
    updatedAt: new Date().toISOString(),
    revision,
    kind,
    source: kind === "session" ? "codex" : "shared",
    logicalPath: `${kind}/${id}`,
    title: "Complete session",
    deleted: false,
    files,
  });
  const snapshot = async (id: string, revision: number, payload: unknown) =>
    pool.query("insert into orka.snapshots values($1,$2,$3,$4)", [
      project,
      id,
      revision,
      payload,
    ]);
  const current = async (id: string, revision: number, payload: unknown) =>
    pool.query("insert into orka.resources values($1,$2,$3,$4)", [
      project,
      id,
      revision,
      payload,
    ]);
  const command = (apply = false) =>
    JSON.parse(
      execFileSync(
        binary,
        ["prune-session-history", ...(apply ? ["--apply"] : [])],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            DATABASE_URL: process.env.DATABASE_URL,
            BLOB_ROOT: root,
          },
        },
      ),
    ) as {
      dryRun: boolean;
      prunedSnapshots: number;
      eligibleBlobs: number;
      catalogBlobsRemoved: number;
      filesRemoved: number;
      pendingFiles: number;
    };
  return {
    pool,
    root,
    project,
    owner,
    blobs,
    file,
    resource,
    snapshot,
    current,
    command,
  };
}

await test("latest-session cleanup is dry-run first, preserves complete current/lineage and non-session/review/conflict roots, and physically reclaims old versions", async () =>
  fixture(async (f) => {
    const old = await f.file("Earlier native snapshot"),
      latest = await f.file("Latest complete native conversation"),
      lineage = await f.file("Inherited complete native conversation");
    const conflict = await f.file("Unresolved concurrent native conversation"),
      review = await f.file("Pending review native conversation"),
      memoryOld = await f.file("Also referenced by non-session history"),
      recent = await f.file("Uploaded but not yet published", true),
      unknown = await f.file("Unclassified upload", false, false),
      closedMemoryReview = await f.file("Non-session review history"),
      opaqueOperation = await f.file("Opaque operation reference"),
      sessionOperation = await f.file(
        "Session resolution operation only",
        false,
        false,
      );
    const id = randomUUID(),
      memoryId = randomUUID();
    await f.snapshot(id, 1, f.resource(id, 1, [old]));
    const manifest = f.resource(id, 2, [
      latest,
      { ...lineage, path: "lineage/parent/2.jsonl" },
    ]);
    await f.snapshot(id, 2, manifest);
    await f.current(id, 2, manifest);
    await f.pool.query("insert into orka.events values($1,1,$2)", [
      f.project,
      { revision: 1, resource: f.resource(id, 1, [old]), conflicts: [] },
    ]);
    await f.pool.query(
      "insert into orka.receipts values($1,$2,$3,'request',$4)",
      [
        f.project,
        f.owner,
        randomUUID(),
        {
          event: { revision: 1, resource: f.resource(id, 1, [old]) },
          conflict: false,
        },
      ],
    );
    await f.pool.query(
      "insert into orka.mcp_operations values($1,$2,$3,'request',$4)",
      [
        f.project,
        f.owner,
        randomUUID(),
        {
          event: { revision: 1, resource: f.resource(id, 1, [old]) },
          conflict: false,
        },
      ],
    );
    await f.pool.query(
      "insert into orka.mcp_operations values($1,$2,$3,'opaque',$4)",
      [
        f.project,
        f.owner,
        randomUUID(),
        { opaque: { files: [opaqueOperation] } },
      ],
    );
    await f.pool.query(
      "insert into orka.mcp_operations values($1,$2,$3,'session-op',$4)",
      [
        f.project,
        f.owner,
        randomUUID(),
        {
          event: { resource: f.resource(id, 1, [sessionOperation]) },
          conflict: false,
        },
      ],
    );
    await f.snapshot(
      memoryId,
      1,
      f.resource(memoryId, 1, [memoryOld], "memory"),
    );
    await f.snapshot(memoryId, 2, f.resource(memoryId, 2, [latest], "memory"));
    await f.current(memoryId, 2, f.resource(memoryId, 2, [latest], "memory"));
    await f.pool.query(
      "insert into orka.conflicts(id,project_id,resource_id,payload) values($1,$2,$3,$4)",
      [
        randomUUID(),
        f.project,
        id,
        { candidate: f.resource(id, 3, [conflict]) },
      ],
    );
    for (const [file, status, kind] of [
      [review, "pending", "session"],
      [closedMemoryReview, "rejected", "memory"],
    ] as const) {
      await f.pool.query(
        "insert into orka.review_requests values($1,$2,$3,'review',$4,$5)",
        [
          f.project,
          randomUUID(),
          f.owner,
          { status },
          { resource: f.resource(id, 4, [file], kind) },
        ],
      );
    }
    await f.snapshot(randomUUID(), 1, f.resource(randomUUID(), 1, [recent]));
    const timestamps = (
      await f.pool.query(
        "select hash,created_at from orka.blobs where project_id=$1 order by hash",
        [f.project],
      )
    ).rows;
    const before = (
      await f.pool.query(
        "select count(*)::int count from orka.snapshots where project_id=$1",
        [f.project],
      )
    ).rows[0].count;
    const dry = f.command();
    assert.equal(dry.dryRun, true);
    assert.ok(dry.eligibleBlobs >= 1);
    assert.equal(
      (
        await f.pool.query(
          "select count(*)::int count from orka.snapshots where project_id=$1",
          [f.project],
        )
      ).rows[0].count,
      before,
    );
    assert.deepEqual(
      (
        await f.pool.query(
          "select hash,created_at from orka.blobs where project_id=$1 order by hash",
          [f.project],
        )
      ).rows,
      timestamps,
    );
    assert.deepEqual(await f.blobs.read(f.project, old.hash), old.content);
    const applied = f.command(true);
    assert.ok(applied.filesRemoved >= 1);
    assert.ok(applied.prunedSnapshots >= 1);
    await assert.rejects(f.blobs.read(f.project, old.hash));
    await assert.rejects(f.blobs.read(f.project, sessionOperation.hash));
    assert.equal(
      (
        await f.pool.query(
          "select count(*)::int count from orka.blobs where project_id=$1 and hash=$2",
          [f.project, old.hash],
        )
      ).rows[0].count,
      0,
    );
    for (const file of [
      latest,
      lineage,
      conflict,
      review,
      memoryOld,
      recent,
      unknown,
      closedMemoryReview,
      opaqueOperation,
    ])
      assert.deepEqual(await f.blobs.read(f.project, file.hash), file.content);
    assert.equal(
      (
        await f.pool.query(
          "select count(*)::int count from orka.snapshots where project_id=$1 and resource_id=$2",
          [f.project, id],
        )
      ).rows[0].count,
      1,
    );
    assert.equal(
      (
        await f.pool.query(
          "select count(*)::int count from orka.snapshots where project_id=$1 and resource_id=$2",
          [f.project, memoryId],
        )
      ).rows[0].count,
      2,
    );
    // Once upload grace expires, the remembered hash remains collectable even
    // though the sole snapshot that identified it was removed by the first pass.
    await f.pool.query(
      "update orka.blobs set created_at=now()-interval '2 days' where project_id=$1 and hash=$2",
      [f.project, recent.hash],
    );
    f.command(true);
    await assert.rejects(f.blobs.read(f.project, recent.hash));
    assert.equal(f.command(true).filesRemoved, 0);
  }));

await test("failed physical cleanup remains queued and resumes without catalog/file disagreement", async () =>
  fixture(async (f) => {
    const old = await f.file("Retryable cleanup"),
      id = randomUUID();
    await f.snapshot(id, 1, f.resource(id, 1, [old]));
    const path = join(f.root, f.project, old.hash);
    await rm(path);
    await mkdir(path);
    await writeFile(join(path, "block"), "block deletion");
    const failed = spawnSync(binary, ["prune-session-history", "--apply"], {
      encoding: "utf8",
      env: { ...process.env, BLOB_ROOT: f.root },
    });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /regular file/);
    assert.equal(
      (
        await f.pool.query(
          "select count(*)::int count from orka.blobs where project_id=$1 and hash=$2",
          [f.project, old.hash],
        )
      ).rows[0].count,
      0,
    );
    assert.equal(
      (
        await f.pool.query(
          "select count(*)::int count from orka.blob_file_cleanup where project_id=$1 and hash=$2",
          [f.project, old.hash],
        )
      ).rows[0].count,
      1,
    );
    await rm(path, { recursive: true });
    await writeFile(path, old.content);
    const retried = f.command(true);
    assert.ok(retried.filesRemoved >= 1);
    assert.equal(retried.pendingFiles, 0);
    await assert.rejects(readFile(path));
  }));

await test("upload locks exclude collection and an identical reupload refreshes grace and wins over a pending unlink", async () =>
  fixture(async (f) => {
    const file = await f.file("A reuploaded exact hash"),
      id = randomUUID();
    await f.snapshot(id, 1, f.resource(id, 1, [file]));
    const lock = await f.pool.connect();
    try {
      await lock.query("begin");
      await lock.query("select id from orka.projects where id=$1 for share", [
        f.project,
      ]);
      f.command(true);
      assert.deepEqual(await f.blobs.read(f.project, file.hash), file.content);
    } finally {
      await lock.query("rollback");
      lock.release();
    }
    const store = new Store(f.pool, f.blobs),
      server = createApi(store, async (token) => token);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      await f.pool.query(
        "insert into orka.blob_file_cleanup values($1,$2,$3)",
        [f.project, file.hash, file.size],
      );
      const response = await fetch(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/v2/blobs/${f.project}/${file.hash}`,
        {
          method: "PUT",
          headers: { Authorization: `Bearer ${f.owner}` },
          body: file.content,
        },
      );
      assert.equal(response.status, 200, await response.text());
      assert.equal(
        (
          await f.pool.query(
            "select created_at>now()-interval '1 minute' fresh from orka.blobs where project_id=$1 and hash=$2",
            [f.project, file.hash],
          )
        ).rows[0].fresh,
        true,
      );
      f.command(true);
      assert.deepEqual(await f.blobs.read(f.project, file.hash), file.content);
      assert.equal(
        (
          await f.pool.query(
            "select count(*)::int count from orka.blob_file_cleanup where project_id=$1",
            [f.project],
          )
        ).rows[0].count,
        0,
      );
    } finally {
      await new Promise<void>((done, reject) =>
        server.close((err) => (err ? reject(err) : done())),
      );
    }
  }));

await test("resolved session conflicts and completed session reviews release their temporary file roots", async () =>
  fixture(async (f) => {
    const conflict = await f.file("Unresolved candidate", false, false),
      review = await f.file("Review candidate", false, false),
      id = randomUUID(),
      conflictId = randomUUID(),
      requestId = randomUUID();
    await f.pool.query(
      "insert into orka.conflicts(id,project_id,resource_id,payload) values($1,$2,$3,$4)",
      [conflictId, f.project, id, { candidate: f.resource(id, 1, [conflict]) }],
    );
    await f.pool.query(
      "insert into orka.review_requests values($1,$2,$3,'review',$4,$5)",
      [
        f.project,
        requestId,
        f.owner,
        { status: "pending" },
        { resource: f.resource(id, 1, [review]) },
      ],
    );
    f.command(true);
    assert.deepEqual(
      await f.blobs.read(f.project, conflict.hash),
      conflict.content,
    );
    assert.deepEqual(
      await f.blobs.read(f.project, review.hash),
      review.content,
    );
    await f.pool.query("update orka.conflicts set resolved=true where id=$1", [
      conflictId,
    ]);
    await f.pool.query(
      "update orka.review_requests set payload=jsonb_set(payload,'{status}','\"approved\"'::jsonb) where project_id=$1 and id=$2",
      [f.project, requestId],
    );
    const applied = f.command(true);
    assert.ok(applied.filesRemoved >= 2);
    await assert.rejects(f.blobs.read(f.project, conflict.hash));
    await assert.rejects(f.blobs.read(f.project, review.hash));
  }));
