import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { Store } from "./bridge/store.js";
import { createApi } from "./bridge/main.js";
import { authSettings } from "./bridge/auth.js";
import { Blobs } from "./fixtures/blobs.js";
import { acceptingMemoryResolver } from "./fixtures/memory-fixtures.js";

for (const mode of ["cloud", "self-hosted"]) {
  await test(`${mode} live episodes fence stop, concurrent starts, changed provenance and revoked access`, async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const directory = await mkdtemp(join(tmpdir(), "orka-live-sessions-"));
    const store = new Store(
      pool,
      new Blobs(directory),
      acceptingMemoryResolver(),
    );
    const owner = randomUUID(),
      writer = randomUUID(),
      reader = randomUUID(),
      outsider = randomUUID();
    const deviceId = randomUUID(),
      secondDevice = randomUUID(),
      projectId = await store.createProject(owner, "Experiment", true);
    await pool.query(
      "insert into orka.members values($1,$2,'member'),($1,$3,'member')",
      [projectId, writer, reader],
    );
    await store.device(writer, deviceId, "Author");
    await store.device(writer, secondDevice, "Other");
    await store.device(owner, owner, "Owner");
    await store.device(reader, reader, "Reader");
    const server = createApi(
      store,
      async (token) => token,
      undefined,
      authSettings({ DEPLOYMENT_MODE: mode }),
    );
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = "http://127.0.0.1:" + address.port;
    const secret = randomUUID();
    const parentId = randomUUID(),
      resourceId = randomUUID();
    const sourceId = randomUUID();
    await pool.query(
      "insert into orka.project_sources(project_id,id,name) values($1,$2,'source')",
      [projectId, sourceId],
    );
    const accepted = (id: string, kind: string, revision: number) => ({
      resourceId: id,
      projectId,
      kind,
      sourceId,
      source: "claude",
      owner: writer,
      revision,
      deleted: false,
      contextSources: kind === "session" ? [parentId] : [],
      logicalPath: "claude/" + id,
      files: [],
      title: "Fixture session",
    });
    for (const [id, kind, rev] of [
      [parentId, "memory", 1],
      [resourceId, "session", 2],
    ] as const) {
      await pool.query("insert into orka.resources values($1,$2,$3,$4)", [
        projectId,
        id,
        rev,
        accepted(id, kind, rev),
      ]);
    }
    const request = async (
      path: string,
      body?: unknown,
      user = writer,
      key?: string,
    ) => {
      const result = await fetch(origin + path, {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: "Bearer " + user,
          "Content-Type": "application/json",
          "X-Orka-Governance": "1",
          ...(key ? { "X-Orka-Live-Relay-Secret": key } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: result.status, body: await result.json() };
    };
    const control = "/v2/live-sessions/",
      authorize = "/internal/live-sessions/authorize",
      scope = { projectId, resourceId };
    const base = {
      ...scope,
      deviceId,
      expectedRevision: 2,
      contextSources: [parentId],
    };
    const configure = async (enabled: boolean) =>
      store.invoke("configure", {
        settings: authSettings({ DEPLOYMENT_MODE: mode }),
        environment: enabled
          ? {
              ORKA_EXPERIMENTAL_LIVE_SESSIONS: "1",
              ORKA_LIVE_SESSION_RELAY_SECRET: secret,
            }
          : {},
      });
    try {
      await configure(false);
      assert.equal(
        (await request("/v2/projects/capabilities")).body
          .experimentalLiveSessions,
        undefined,
      );
      assert.equal((await request(control + "status", scope)).status, 404);
      await configure(true);
      assert.equal(
        (await request("/v2/projects/capabilities")).body
          .experimentalLiveSessions,
        1,
      );
      assert.deepEqual(
        (await request(control + "status", scope, reader)).body,
        { episodeId: null },
      );
      assert.equal(
        (
          await request(control + "start", {
            ...base,
            episodeId: randomUUID(),
            resourceId: randomUUID(),
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await request(
            control + "start",
            { ...base, episodeId: randomUUID(), deviceId: owner },
            owner,
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await request(control + "start", {
            ...base,
            episodeId: randomUUID(),
            expectedRevision: 1,
          })
        ).status,
        409,
      );
      const cancelled = { ...scope, deviceId, episodeId: randomUUID() };
      assert.equal((await request(control + "stop", cancelled)).status, 200);
      assert.equal(
        (
          await request(control + "start", {
            ...base,
            episodeId: cancelled.episodeId,
          })
        ).status,
        409,
      );
      const ids = [randomUUID(), randomUUID()];
      const starts = await Promise.all(
        ids.map((episodeId) =>
          request(control + "start", { ...base, episodeId }),
        ),
      );
      assert.deepEqual(starts.map((x) => x.status).sort(), [200, 409]);
      const episodeId = ids[starts.findIndex((x) => x.status === 200)];
      const active = { ...scope, episodeId },
        read = { ...active, action: "read" },
        write = {
          ...active,
          deviceId,
          action: "write",
          contextSources: [parentId],
        };
      assert.equal(
        (await request(control + "start", { ...base, episodeId })).status,
        200,
      );
      assert.equal(
        (
          await request(control + "start", {
            ...base,
            episodeId,
            expectedRevision: 1,
          })
        ).status,
        409,
      );
      assert.equal(
        (await request(control + "status", scope, reader)).body.episodeId,
        episodeId,
      );
      assert.equal((await request(authorize, read, reader)).status, 404);
      assert.equal(
        (await request(authorize, read, reader, "wrong")).status,
        404,
      );
      assert.equal(
        (await request(authorize, read, outsider, secret)).status,
        403,
      );
      assert.equal(
        (await request(authorize, read, reader, secret)).body.role,
        "reader",
      );
      assert.equal(
        (await request(authorize, write, writer, secret)).body.role,
        "writer",
      );
      assert.equal(
        (
          await request(
            authorize,
            { ...write, deviceId: secondDevice },
            writer,
            secret,
          )
        ).status,
        403,
      );
      assert.equal(
        (await request(authorize, { ...write, deviceId: owner }, owner, secret))
          .status,
        403,
      );
      assert.equal(
        (
          await request(
            authorize,
            { ...write, contextSources: undefined },
            writer,
            secret,
          )
        ).status,
        400,
      );
      // Hidden upstream provenance and revoked writer rights apply to a previously admitted reader.
      const restrict = async (id: string, target: string, level: string) =>
        pool.query(
          "insert into orka.resource_access values($1,$2,$3,$4) on conflict(project_id,resource_id,user_id) do update set rule=excluded.rule",
          [projectId, id, target, { mode: level, canShare: false }],
        );
      await restrict(parentId, reader, "hidden");
      assert.equal(
        (await request(authorize, read, reader, secret)).status,
        403,
      );
      await restrict(parentId, reader, "read");
      await restrict(resourceId, writer, "suggest");
      assert.equal(
        (await request(authorize, read, reader, secret)).status,
        403,
      );
      assert.equal(
        (await request(authorize, write, writer, secret)).status,
        403,
      );
      await restrict(resourceId, writer, "publish");
      await pool.query(
        "update orka.projects set archived_at=now() where id=$1",
        [projectId],
      );
      assert.equal(
        (await request(authorize, read, reader, secret)).status,
        403,
      );
      await pool.query(
        "update orka.projects set archived_at=null where id=$1",
        [projectId],
      );
      await pool.query(
        "update orka.project_sources set removed_at=now() where project_id=$1 and id=$2",
        [projectId, sourceId],
      );
      assert.equal(
        (await request(authorize, read, reader, secret)).status,
        409,
      );
      await pool.query(
        "update orka.project_sources set removed_at=null where project_id=$1 and id=$2",
        [projectId, sourceId],
      );
      assert.equal(
        (
          await request(
            authorize,
            { ...write, contextSources: [parentId, randomUUID()] },
            writer,
            secret,
          )
        ).body.code,
        "live_context_changed",
      );
      assert.equal(
        (await request(authorize, read, reader, secret)).status,
        409,
      );
      assert.equal(
        (await request(authorize, read, reader, secret)).body.code,
        "live_episode_inactive",
      );
      const conflictId = randomUUID();
      await pool.query(
        "insert into orka.conflicts(id,project_id,resource_id,payload) values($1,$2,$3,'{}')",
        [conflictId, projectId, resourceId],
      );
      assert.equal(
        (await request(control + "start", { ...base, episodeId: randomUUID() }))
          .status,
        409,
      );
      await pool.query("update orka.conflicts set resolved=true where id=$1", [
        conflictId,
      ]);
      const next = randomUUID();
      assert.equal(
        (await request(control + "start", { ...base, episodeId: next })).status,
        200,
      );
      assert.equal(
        (await request(control + "stop", { ...active, deviceId })).status,
        200,
      );
      assert.equal(
        (await request(control + "status", scope, reader)).body.episodeId,
        next,
      );
      await pool.query(
        "update orka.live_sessions set expires_at=now()-interval '1 second' where episode_id=$1",
        [next],
      );
      assert.equal(
        (await request(control + "status", scope, reader)).body.episodeId,
        null,
      );
      assert.equal(
        (await request(control + "start", { ...base, episodeId: next })).status,
        409,
      );
      assert.equal(
        (await request(control + "start", { ...base, episodeId: randomUUID() }))
          .status,
        200,
      );
      await pool.query("update orka.projects set revision=2 where id=$1", [
        projectId,
      ]);
      const deleted = await request("/v2/sync/push", {
        version: 2,
        id: randomUUID(),
        projectId,
        deviceId,
        baseRevision: 2,
        resource: {
          resourceId,
          sourceId,
          kind: "session",
          source: "claude",
          logicalPath: "claude/" + resourceId,
          title: "Fixture session",
          deleted: true,
          files: [],
        },
      });
      assert.equal(deleted.status, 200);
      assert.equal(
        (
          await pool.query(
            "select count(*) from orka.live_sessions where project_id=$1 and resource_id=$2 and stopped_at is null",
            [projectId, resourceId],
          )
        ).rows[0].count,
        "0",
      );
    } finally {
      await new Promise<void>((ok) => server.close(() => ok()));
      await pool.end();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
