import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { Store } from "./bridge/store.js";
import { createApi } from "./bridge/main.js";
import { Blobs } from "./fixtures/blobs.js";
import { startEnvMac, type EnvMac } from "./fixtures/env-native.js";

interface Project {
  id: string;
  role?: string;
  lifecycleRevision?: number;
  deletedAt?: string | null;
  archivedAt?: string | null;
  purged?: boolean;
  revoked?: boolean;
  detachedAt?: string;
  sources?: { id: string; path?: string | null }[];
}
interface Snapshot {
  projects: Project[];
  deletedProjects?: Project[];
  archivedProjects?: Project[];
  inactive?: Project[];
}
const enabled = Boolean(process.env.ORKA_ENV_NATIVE_BIN);
const command = <T = Record<string, unknown>>(
  mac: EnvMac,
  operation: string,
  input: Record<string, unknown> = {},
) => mac.request<T>({ action: "project", operation, input });
const snapshot = (mac: EnvMac) => mac.request<Snapshot>({ action: "snapshot" });

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "orka-project-native-"));
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const store = new Store(pool, new Blobs(join(home, "server-blobs")));
  const owner = randomUUID(),
    member = randomUUID();
  const server = createApi(store, async (token) => token);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const macs: EnvMac[] = [];
  const api = async (
    path: string,
    input?: unknown,
    user = owner,
    status = 200,
  ) => {
    const response = await fetch(url + path, {
      method: input === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${user}`,
        "Content-Type": "application/json",
        "X-Orka-Governance": "1",
      },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    const value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    return value;
  };
  const mac = async (
    name: string,
    user: string,
    project: string,
    origin = url,
    sources?: { id: string; name: string }[],
  ) => {
    const native = await startEnvMac({
      home,
      name,
      user,
      project,
      url: origin,
      sources,
      enable: false,
    });
    macs.push(native);
    await command(native, "list");
    return native;
  };
  const close = async () => {
    for (const native of macs.reverse()) await native.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
    await rm(home, { recursive: true, force: true });
  };
  return { home, pool, store, owner, member, url, api, mac, close };
}

await test(
  "native recoverable deletion refuses an older service before sending any mutation",
  { skip: !enabled, timeout: 60000 },
  async () => {
    const f = await fixture();
    let mutationPosts = 0;
    const proxyErrors: unknown[] = [];
    const proxy = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        if (request.method === "POST" && request.url === "/v2/projects/action")
          mutationPosts += 1;
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(request.headers))
          if (typeof value === "string" && name !== "host")
            headers[name] = value;
        const upstream = await fetch(f.url + (request.url ?? "/"), {
          method: request.method,
          headers,
          body: body.length ? body : undefined,
        });
        if (request.url === "/v2/projects/capabilities") {
          const capabilities = await upstream.json();
          delete capabilities.softDelete;
          response.writeHead(upstream.status, {
            "Content-Type": "application/json",
          });
          response.end(JSON.stringify(capabilities));
        } else {
          response.writeHead(
            upstream.status,
            Object.fromEntries(upstream.headers),
          );
          response.end(Buffer.from(await upstream.arrayBuffer()));
        }
      })().catch((error: unknown) => {
        proxyErrors.push(error);
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({ error: "Lifecycle fixture proxy failed" }),
        );
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    assert.ok(address && typeof address !== "string");
    try {
      const name = "Older service";
      const project = await f.store.createProject(f.owner, name);
      const native = await f.mac(
        "older",
        f.owner,
        project,
        `http://127.0.0.1:${address.port}`,
      );
      for (const operation of ["delete", "purge"])
        await assert.rejects(
          command(native, operation, {
            projectId: project,
            requestId: randomUUID(),
            expectedRevision: 0,
            confirmation: name,
          }),
          /recoverable project deletion|[Uu]pdate the server/,
        );
      assert.equal(
        mutationPosts,
        0,
        "an older service interprets delete as permanent deletion",
      );
      assert.deepEqual(proxyErrors, []);
      assert.equal(
        (
          await f.pool.query("select 1 from orka.projects where id=$1", [
            project,
          ])
        ).rowCount,
        1,
      );
      assert.ok(
        (await snapshot(native)).projects.some((entry) => entry.id === project),
      );
    } finally {
      await f.close();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  },
);

await test(
  "native owner deletion and recovery preserve role, revision and folders across Macs",
  { skip: !enabled, timeout: 60000 },
  async () => {
    const f = await fixture();
    try {
      const name = "Cross-Mac recovery";
      const project = await f.store.createProject(f.owner, name);
      const first = await f.mac("first", f.owner, project);
      const second = await f.mac("second", f.owner, project);
      await command(first, "delete", {
        projectId: project,
        requestId: randomUUID(),
        expectedRevision: 0,
        confirmation: name,
      });
      const immediate = await snapshot(first);
      assert.ok(!immediate.projects.some((entry) => entry.id === project));
      const deleted = immediate.deletedProjects?.find(
        (entry) => entry.id === project,
      );
      assert.ok(deleted?.deletedAt);
      assert.equal(deleted.role, "owner");
      assert.equal(deleted.lifecycleRevision, 1);

      await command(second, "list");
      const secondDeleted = (await snapshot(second)).deletedProjects?.find(
        (entry) => entry.id === project,
      );
      assert.equal(secondDeleted?.role, "owner");
      assert.equal(secondDeleted.lifecycleRevision, 1);
      assert.equal(
        secondDeleted.sources?.[0].path,
        await realpath(second.sources[0].path),
      );
      const fresh = await f.mac(
        "fresh",
        f.owner,
        project,
        f.url,
        first.sources.map(({ id, name: sourceName }) => ({
          id,
          name: sourceName,
        })),
      );
      const freshDeleted = (await snapshot(fresh)).deletedProjects?.find(
        (entry) => entry.id === project,
      );
      assert.equal(freshDeleted?.role, "owner");
      assert.equal(freshDeleted.lifecycleRevision, 1);
      assert.equal(
        freshDeleted.sources?.[0].path,
        await realpath(fresh.sources[0].path),
      );

      await command(second, "restore", {
        projectId: project,
        requestId: randomUUID(),
        expectedRevision: 1,
      });
      const restored = (await snapshot(second)).projects.find(
        (entry) => entry.id === project,
      );
      assert.ok(
        restored,
        "the restore receipt must reactivate immediately without catalog polling",
      );
      assert.equal(restored.lifecycleRevision, 2);
      assert.equal(restored.deletedAt, null);
      assert.equal(restored.archivedAt, null);
      assert.equal(
        restored.sources?.[0].path,
        await realpath(second.sources[0].path),
      );
      for (const native of [first, fresh]) {
        await command(native, "list");
        assert.ok(
          (await snapshot(native)).projects.some(
            (entry) => entry.id === project,
          ),
        );
      }
      await command(second, "archive", {
        projectId: project,
        requestId: randomUUID(),
        expectedRevision: 2,
      });
      const archived = (await snapshot(second)).archivedProjects?.find(
        (entry) => entry.id === project,
      );
      assert.equal(archived?.role, "owner");
      assert.equal(archived.lifecycleRevision, 3);
      await command(second, "restore", {
        projectId: project,
        requestId: randomUUID(),
        expectedRevision: 3,
      });
      assert.ok(
        (await snapshot(second)).projects.some((entry) => entry.id === project),
      );
    } finally {
      await f.close();
    }
  },
);

await test(
  "native leave removes account membership on every Mac and purge tombstones detach remaining Macs",
  { skip: !enabled, timeout: 60000 },
  async () => {
    const f = await fixture();
    try {
      const name = "Membership and purge";
      const project = await f.store.createProject(
        f.owner,
        name,
        false,
        undefined,
        undefined,
        true,
      );
      const source = { id: randomUUID(), name: "Shared repository" };
      await f.api("/v2/projects/sources", {
        projectId: project,
        sources: [source],
      });
      const invite = await f.api("/v2/invites", { projectId: project });
      await f.api("/v2/join", { token: invite.token }, f.member);
      const first = await f.mac("member-first", f.member, project);
      const second = await f.mac("member-second", f.member, project);
      const owner = await f.mac("owner", f.owner, project);
      const catalog = await first.request<{ policyRevision: number }>({
        action: "governance",
        operation: "catalog",
        input: { projectId: project },
      });
      await command(first, "leave", {
        projectId: project,
        expectedPolicyRevision: catalog.policyRevision,
      });
      const left = (await snapshot(first)).inactive?.find(
        (entry) => entry.id === project,
      );
      assert.equal(left?.revoked, true);
      assert.ok(left.detachedAt);
      assert.equal(
        (
          await f.pool.query(
            "select 1 from orka.members where project_id=$1 and user_id=$2",
            [project, f.member],
          )
        ).rowCount,
        0,
      );
      const denial = await f.api(
        `/v2/sync/pull?projectId=${project}`,
        undefined,
        f.member,
        403,
      );
      assert.equal(denial.code, "not_member");
      await command(second, "list");
      assert.equal(
        (await snapshot(second)).inactive?.find((entry) => entry.id === project)
          ?.revoked,
        true,
      );
      assert.ok(
        (await snapshot(owner)).projects.some((entry) => entry.id === project),
      );

      await f.api("/v2/projects/action", {
        action: "delete",
        projectId: project,
        requestId: randomUUID(),
        expectedRevision: 0,
        confirmation: name,
      });
      await f.api("/v2/projects/action", {
        action: "purge",
        projectId: project,
        requestId: randomUUID(),
        expectedRevision: 1,
        confirmation: name,
      });
      await command(owner, "list");
      const purged = (await snapshot(owner)).inactive?.find(
        (entry) => entry.id === project,
      );
      assert.equal(purged?.purged, true);
      assert.equal(purged.revoked, true);
      assert.ok(purged.detachedAt);
      assert.equal(
        (
          await f.pool.query("select 1 from orka.projects where id=$1", [
            project,
          ])
        ).rowCount,
        0,
      );
    } finally {
      await f.close();
    }
  },
);
