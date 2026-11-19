import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { Store } from "./bridge/store.js";
import { Blobs, bytesHash } from "./fixtures/blobs.js";
import { createApi } from "./bridge/main.js";

type PurgeStats = {
  projects: number;
  tombstones: number;
  expiredTombstones: number;
};

class PurgeFixture {
  readonly pool = new Pool({ connectionString: process.env.DATABASE_URL });
  readonly owner = randomUUID();
  readonly member = randomUUID();
  private constructor(
    readonly home: string,
    readonly blobs: Blobs,
    readonly store: Store,
    readonly server: ReturnType<typeof createApi>,
    readonly url: string,
  ) {}
  static async start() {
    const home = await mkdtemp(join(tmpdir(), "orka-project-purge-"));
    const blobs = new Blobs(join(home, "blobs"));
    const fixture = new PurgeFixture(home, blobs, null!, null!, "");
    const store = new Store(fixture.pool, blobs);
    const server = createApi(store, async (token) => token);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return Object.assign(fixture, {
      store,
      server,
      url: `http://127.0.0.1:${address.port}`,
    });
  }
  async api(path: string, input?: unknown, user = this.owner) {
    const response = await fetch(this.url + path, {
      method: input === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${user}`,
        "Content-Type": "application/json",
      },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    return { status: response.status, value: await response.json() };
  }
  async lifecycle(
    projectId: string,
    name: string,
    action: string,
    revision: number,
  ) {
    const result = await this.api("/v2/projects/action", {
      requestId: randomUUID(),
      projectId,
      action,
      expectedRevision: revision,
      confirmation: name,
    });
    assert.equal(result.status, 200, JSON.stringify(result.value));
  }
  /** A shared, deleted project with a file, a log entry and a member. */
  async deletedProject(name: string) {
    const project = await this.store.createProject(this.owner, name);
    const invite = await this.api("/v2/invites", { projectId: project });
    const joined = await this.api(
      "/v2/join",
      { token: invite.value.token },
      this.member,
    );
    assert.equal(joined.status, 200);
    const content = Buffer.from(`files of ${name}`);
    await this.blobs.put(project, content);
    await this.pool.query("insert into orka.blobs values($1,$2,$3)", [
      project,
      bytesHash(content),
      content.length,
    ]);
    await this.pool.query(
      "insert into orka.management_logs(project_id,payload) values($1,'{}')",
      [project],
    );
    await this.lifecycle(project, name, "delete", 0);
    return project;
  }
  async expire(project: string) {
    await this.pool.query(
      "update orka.projects set deleted_at=now()-interval '31 days',purge_after=now()-interval '1 day' where id=$1",
      [project],
    );
  }
  purge() {
    return this.store.invoke<PurgeStats>("purgeProjects", {});
  }
  async count(table: string, project: string) {
    const column = table === "projects" ? "id" : "project_id";
    const result = await this.pool.query(
      `select count(*)::int as count from orka.${table} where ${column}=$1`,
      [project],
    );
    return result.rows[0].count as number;
  }
  async tombstones(project: string) {
    const result = await this.pool.query(
      `select user_id,deleted_at,extract(epoch from expires_at-now())::float as ttl
       from orka.project_tombstones where project_id=$1 order by user_id`,
      [project],
    );
    return result.rows as { user_id: string; deleted_at: Date; ttl: number }[];
  }
  async close() {
    await new Promise<void>((r) => this.server.close(() => r()));
    await this.pool.end();
    await rm(this.home, { recursive: true, force: true });
  }
}

await test("the purge job removes expired projects with their files and logs, and tombstones every former member", async () => {
  const f = await PurgeFixture.start();
  try {
    const expired = await f.deletedProject("Expired project");
    const pending = await f.deletedProject("Still restorable");
    const restored = await f.deletedProject("Restored project");
    await f.lifecycle(restored, "Restored project", "restore", 1);
    await f.expire(expired);
    const { deleted_at: deletedAt } = (
      await f.pool.query("select deleted_at from orka.projects where id=$1", [
        expired,
      ])
    ).rows[0];

    const stats = await f.purge();
    assert.equal(stats.projects, 1);
    assert.equal(stats.tombstones, 2);
    for (const table of [
      "projects",
      "members",
      "blobs",
      "management_logs",
      "invites",
      "project_blob_cleanup",
    ])
      assert.equal(await f.count(table, expired), 0, table);
    await assert.rejects(access(join(f.home, "blobs", expired)));
    const tombstones = await f.tombstones(expired);
    assert.deepEqual(
      tombstones.map((t) => t.user_id),
      [f.owner, f.member].sort(),
    );
    for (const t of tombstones) {
      assert.equal(t.deleted_at.getTime(), deletedAt.getTime());
      assert.ok(Math.abs(t.ttl - 90 * 86400) < 600, String(t.ttl));
    }

    for (const project of [pending, restored]) {
      assert.equal(await f.count("projects", project), 1);
      assert.equal(await f.count("members", project), 2);
      assert.equal(await f.count("blobs", project), 1);
      await access(join(f.home, "blobs", project));
      assert.deepEqual(await f.tombstones(project), []);
    }
    const catalog = await f.api("/v2/projects");
    assert.ok(catalog.value.some((p: { id: string }) => p.id === restored));

    assert.deepEqual(await f.purge(), {
      projects: 0,
      tombstones: 0,
      expiredTombstones: 0,
    });
    assert.equal((await f.tombstones(expired)).length, 2);
  } finally {
    await f.close();
  }
});

await test("a project locked by another instance or a restore is skipped, not waited on, and purged later", async () => {
  const f = await PurgeFixture.start();
  const holder = await f.pool.connect();
  try {
    const project = await f.deletedProject("Locked project");
    await f.expire(project);
    await holder.query("begin");
    await holder.query("select 1 from orka.projects where id=$1 for update", [
      project,
    ]);
    assert.equal((await f.purge()).projects, 0);
    assert.equal(await f.count("projects", project), 1);
    await holder.query("rollback");
    assert.equal((await f.purge()).projects, 1);
    assert.equal(await f.count("projects", project), 0);
  } finally {
    holder.release();
    await f.close();
  }
});

await test("the purge job clears expired tombstones and keeps live ones", async () => {
  const f = await PurgeFixture.start();
  try {
    const old = randomUUID(),
      live = randomUUID();
    await f.pool.query(
      `insert into orka.project_tombstones(user_id,project_id,deleted_at,expires_at) values
       ($1,$2,now()-interval '120 days',now()-interval '1 second'),
       ($1,$3,now()-interval '10 days',now()+interval '80 days')`,
      [f.owner, old, live],
    );
    assert.ok((await f.purge()).expiredTombstones >= 1);
    assert.deepEqual(await f.tombstones(old), []);
    assert.equal((await f.tombstones(live)).length, 1);
  } finally {
    await f.close();
  }
});
