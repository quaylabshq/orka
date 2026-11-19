import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { Store } from "./bridge/store.js";
import { Blobs } from "./fixtures/blobs.js";
import { createApi } from "./bridge/main.js";

type Project = Record<string, unknown> & { id: string };

class CatalogFixture {
  readonly pool = new Pool({ connectionString: process.env.DATABASE_URL });
  readonly owner = randomUUID();
  readonly member = randomUUID();
  readonly outsider = randomUUID();
  private constructor(
    readonly home: string,
    readonly blobs: Blobs,
    readonly store: Store,
    readonly server: ReturnType<typeof createApi>,
    readonly url: string,
  ) {}
  static async start() {
    const home = await mkdtemp(join(tmpdir(), "orka-project-catalog-"));
    const blobs = new Blobs(join(home, "blobs"));
    const fixture = new CatalogFixture(home, blobs, null!, null!, "");
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
  async api(path: string, input?: unknown, user: string = this.owner) {
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
  async catalog(query = "", user: string = this.owner) {
    const result = await this.api(`/v2/projects${query}`, undefined, user);
    assert.equal(result.status, 200, JSON.stringify(result.value));
    return result.value as Project[];
  }
  async entry(id: string, query = "", user: string = this.owner) {
    return (await this.catalog(query, user)).find((p) => p.id === id);
  }
  /** A refusal keeps its status and message and adds the state as a code. */
  async refusal(path: string, input: unknown, user: string, code: string) {
    assert.deepEqual(await this.api(path, input, user), {
      status: 403,
      value: { error: "Project access denied", code },
    });
  }
  async lifecycle(action: string, revision: number, name: string, id: string) {
    const result = await this.api("/v2/projects/action", {
      requestId: randomUUID(),
      projectId: id,
      action,
      expectedRevision: revision,
      confirmation: name,
    });
    assert.equal(result.status, 200, JSON.stringify(result.value));
  }
  /** A project shared by the owner and one member. */
  async sharedProject(name: string) {
    const id = await this.store.createProject(this.owner, name);
    const invite = await this.api("/v2/invites", { projectId: id });
    const joined = await this.api(
      "/v2/join",
      { token: invite.value.token },
      this.member,
    );
    assert.equal(joined.status, 200, JSON.stringify(joined.value));
    return id;
  }
  async close() {
    await new Promise<void>((r) => this.server.close(() => r()));
    await this.pool.end();
    await rm(this.home, { recursive: true, force: true });
  }
}

await test("the project catalog and access errors describe every deletion state to a member", async () => {
  const f = await CatalogFixture.start();
  try {
    const capabilities = await f.api("/v2/projects/capabilities");
    assert.equal(capabilities.value.projectTombstones, 1);

    const name = "Lifecycle project";
    const project = await f.sharedProject(name);
    const sync = `/v2/sync/pull?projectId=${project}`;
    const governance = {
      action: "catalog",
      input: { projectId: project },
    };

    // Active: visible to every member, with no deletion fields.
    for (const user of [f.owner, f.member]) {
      const active = await f.entry(project, "", user);
      assert.ok(active, "active project missing from the catalog");
      assert.equal(active.name, name);
      assert.equal(active.deletedAt, null);
      assert.equal(active.purgeAfter, null);
      assert.equal(active.purged, undefined);
      assert.equal((await f.api(sync, undefined, user)).status, 200);
    }
    await f.refusal(sync, undefined, f.outsider, "not_member");
    await f.refusal(
      "/v2/governance/action",
      governance,
      f.outsider,
      "not_member",
    );

    // Archived: hidden from the active catalog but readable in the trash view.
    await f.lifecycle("archive", 0, name, project);
    assert.equal(await f.entry(project), undefined);
    const archived = await f.entry(
      project,
      "?includeArchived=true&projectLifecycle=1",
      f.member,
    );
    assert.ok(archived?.archivedAt, "archivedAt missing from the trash view");
    assert.equal(archived.deletedAt, null);
    await f.refusal(sync, undefined, f.member, "project_archived");
    await f.refusal(
      "/v2/governance/action",
      governance,
      f.member,
      "project_archived",
    );
    await f.lifecycle("restore", 1, name, project);

    // Deleted inside the restore window: every member sees the window.
    await f.lifecycle("delete", 2, name, project);
    const deleted = await f.entry(
      project,
      "?includeArchived=true&projectLifecycle=1",
    );
    assert.ok(deleted, "deleted project missing from the trash view");
    assert.ok(deleted.deletedAt && deleted.purgeAfter);
    assert.equal(
      Date.parse(String(deleted.purgeAfter)) -
        Date.parse(String(deleted.deletedAt)),
      7 * 86400_000,
    );
    assert.equal(deleted.purged, undefined);
    // Every member learns the window, but only the owner sees the whole row.
    assert.deepEqual(
      await f.entry(
        project,
        "?includeArchived=true&projectLifecycle=1",
        f.member,
      ),
      {
        id: project,
        name,
        role: "member",
        lifecycleRevision: 3,
        deletedAt: deleted.deletedAt,
        purgeAfter: deleted.purgeAfter,
      },
    );
    for (const user of [f.owner, f.member])
      await f.refusal(sync, undefined, user, "project_deleted");
    await f.refusal(
      "/v2/governance/action",
      governance,
      f.member,
      "project_deleted",
    );

    // Purged: only a tombstone entry remains, and only for former members.
    await f.lifecycle("purge", 3, name, project);
    const tombstone = {
      id: project,
      deletedAt: deleted.deletedAt,
      purged: true,
    };
    for (const user of [f.owner, f.member]) {
      assert.deepEqual(
        await f.entry(
          project,
          "?includeArchived=true&projectLifecycle=1",
          user,
        ),
        tombstone,
      );
      assert.equal(await f.entry(project, "", user), undefined);
      await f.refusal(sync, undefined, user, "not_member");
    }
    assert.equal(
      await f.entry(
        project,
        "?includeArchived=true&projectLifecycle=1",
        f.outsider,
      ),
      undefined,
    );

    // An expired tombstone is no longer reported.
    await f.pool.query(
      "update orka.project_tombstones set expires_at=now()-interval '1 second' where project_id=$1",
      [project],
    );
    assert.equal(
      await f.entry(
        project,
        "?includeArchived=true&projectLifecycle=1",
        f.member,
      ),
      undefined,
    );
  } finally {
    await f.close();
  }
});

await test("the legacy catalog preserves folder mappings and sparse entries require an explicit opt-in", async () => {
  const f = await CatalogFixture.start();
  try {
    // The released desktop compares lifecycle revisions before merging and
    // understands archivedAt, role and sources. Exercise both revisions that
    // previously either replaced its source mappings or hid the deletion.
    for (const revision of [0, 1]) {
      const name = `Legacy catalog ${revision}`;
      const project = await f.sharedProject(name);
      const source = { id: randomUUID(), name: "Connected repository" };
      const added = await f.api("/v2/projects/sources", {
        projectId: project,
        sources: [source],
      });
      assert.equal(added.status, 200, JSON.stringify(added.value));
      if (revision === 1) {
        const renamed = await f.api("/v2/projects/action", {
          projectId: project,
          action: "rename",
          expectedRevision: 0,
          requestId: randomUUID(),
          name,
        });
        assert.equal(renamed.status, 200, JSON.stringify(renamed.value));
      }
      const before = await f.entry(project, "?includeArchived=true", f.member);
      assert.equal(before?.lifecycleRevision, revision);
      assert.deepEqual(before.sources, [source]);

      await f.lifecycle("delete", revision, name, project);
      const legacy = await f.entry(project, "?includeArchived=true", f.member);
      assert.ok(legacy?.archivedAt, "old clients must keep the archive gate");
      assert.equal(legacy.role, "member");
      assert.equal(legacy.lifecycleRevision, revision + 1);
      assert.deepEqual(legacy.sources, before.sources);
      assert.equal(legacy.purged, undefined);
      assert.deepEqual(
        await f.entry(
          project,
          "?includeArchived=true&projectLifecycle=2",
          f.member,
        ),
        legacy,
        "an unsupported version must not opt the client into sparse entries",
      );
      const reduced = await f.entry(
        project,
        "?includeArchived=true&projectLifecycle=1",
        f.member,
      );
      assert.deepEqual(reduced, {
        id: project,
        name,
        role: "member",
        lifecycleRevision: revision + 1,
        deletedAt: legacy.deletedAt,
        purgeAfter: legacy.purgeAfter,
      });
      const owner = await f.entry(
        project,
        "?includeArchived=true&projectLifecycle=1",
      );
      assert.equal(owner?.role, "owner");
      assert.equal(owner.lifecycleRevision, revision + 1);
      assert.deepEqual(owner.sources, before.sources);
      assert.equal(
        await f.entry(project, "?projectLifecycle=1", f.member),
        undefined,
      );

      await f.lifecycle("restore", revision + 1, name, project);
      const restored = await f.entry(
        project,
        "?includeArchived=true",
        f.member,
      );
      assert.equal(restored?.archivedAt, null);
      assert.deepEqual(restored.sources, before.sources);
      assert.equal(restored.lifecycleRevision, revision + 2);
      await f.lifecycle("delete", revision + 2, name, project);
      await f.lifecycle("purge", revision + 3, name, project);
      for (const user of [f.owner, f.member]) {
        assert.equal(
          await f.entry(project, "?includeArchived=true", user),
          undefined,
        );
        const tombstone = await f.entry(
          project,
          "?includeArchived=true&projectLifecycle=1",
          user,
        );
        assert.equal(tombstone?.purged, true);
        assert.equal(
          await f.entry(project, "?projectLifecycle=1", user),
          undefined,
        );
      }
    }
  } finally {
    await f.close();
  }
});
