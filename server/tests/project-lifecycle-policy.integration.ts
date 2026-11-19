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

await test("deletion receipts and advertised restore policy use the configured window", async (t) => {
  for (const days of [1, 7]) {
    await t.test(`${days}-day restore window`, async () => {
      const database = new URL(process.env.DATABASE_URL!);
      database.searchParams.set(
        "options",
        `-corka.project_restore_window_days=${days}`,
      );
      const pool = new Pool({ connectionString: database.href });
      const home = await mkdtemp(join(tmpdir(), "orka-project-policy-"));
      const store = new Store(pool, new Blobs(home));
      const owner = randomUUID();
      const server = createApi(store, async (token) => token);
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const api = async (path: string, input?: unknown) => {
        const response = await fetch(
          `http://127.0.0.1:${address.port}${path}`,
          {
            method: input === undefined ? "GET" : "POST",
            headers: {
              Authorization: `Bearer ${owner}`,
              "Content-Type": "application/json",
            },
            body: input === undefined ? undefined : JSON.stringify(input),
          },
        );
        const result = await response.json();
        assert.equal(response.status, 200, JSON.stringify(result));
        return result;
      };
      try {
        const capabilities = await api("/v2/projects/capabilities");
        assert.equal(capabilities.softDelete, 1);
        assert.equal(capabilities.projectRestoreWindowDays, days);
        const project = await store.createProject(owner, "Policy project");
        const deletion = {
          requestId: randomUUID(),
          projectId: project,
          action: "delete",
          expectedRevision: 0,
          confirmation: "Policy project",
        };
        const deleted = await api("/v2/projects/action", deletion);
        assert.equal(deleted.archivedAt, deleted.deletedAt);
        assert.equal(
          Date.parse(deleted.purgeAfter) - Date.parse(deleted.deletedAt),
          days * 86400_000,
        );
        assert.equal(deleted.lifecycleRevision, 1);
        const restored = await api("/v2/projects/action", {
          requestId: randomUUID(),
          projectId: project,
          action: "restore",
          expectedRevision: 1,
        });
        assert.equal(restored.lifecycleRevision, 2);
        for (const field of ["archivedAt", "deletedAt", "purgeAfter"])
          assert.equal(restored[field], null);
        // Retrying deletion returns its original committed markers, even after
        // another operation changed the project's current lifecycle state.
        assert.deepEqual(await api("/v2/projects/action", deletion), deleted);
        const catalog = await api("/v2/projects");
        const active = catalog.find(
          (entry: { id: string }) => entry.id === project,
        );
        assert.equal(active.lifecycleRevision, 2);
        assert.equal(active.deletedAt, null);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await pool.end();
        await rm(home, { recursive: true, force: true });
      }
    });
  }
});
