import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { Store, HttpError } from "./bridge/store.js";
import { Blobs } from "./fixtures/blobs.js";
import { createApi } from "./bridge/main.js";
import { authSettings } from "./bridge/auth.js";
import { tokenHash } from "./bridge/mcp.js";

await test("desktop session alone selects connector identity; retired OAuth sessions cannot reconnect or impersonate it", async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const directory = await mkdtemp(join(tmpdir(), "orka-desktop-connector-"));
  const store = new Store(pool, new Blobs(directory));
  const owner = randomUUID(),
    other = randomUUID(),
    client = randomUUID();
  const project = await store.createProject(
    owner,
    "Desktop account only",
    true,
  );
  const remoteAccess = randomBytes(32).toString("base64url"),
    remoteRefresh = randomBytes(32).toString("base64url");
  const expired = new Set<string>();
  const reservation = createServer();
  await new Promise<void>((r) => reservation.listen(0, "127.0.0.1", r));
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((r) => reservation.close(() => r()));
  const origin = `http://127.0.0.1:${address.port}`;
  const server = createApi(
    store,
    async (token) => {
      if (!expired.has(token) && token === `desktop-${owner}`) return owner;
      if (!expired.has(token) && token === `desktop-${other}`) return other;
      throw new HttpError(401, "Desktop sign-in required");
    },
    undefined,
    authSettings({ PUBLIC_URL: origin, MCP_ENABLED: "true" }),
  );
  await new Promise<void>((r) => server.listen(address.port, "127.0.0.1", r));
  const request = (token?: string, body?: object) =>
    fetch(origin + "/v2/connector/tools", {
      method: body ? "POST" : "GET",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  const call = (token: string, name: string, args: object = {}) =>
    request(token, { name, arguments: args });
  try {
    await pool.query("insert into orka.mcp_clients values($1,$2)", [
      client,
      { client_id: client, redirect_uris: ["https://client.example/callback"] },
    ]);
    await pool.query(
      "insert into orka.mcp_tokens(access_hash,refresh_hash,family,client_id,user_id,resource,access_expires_at,refresh_expires_at,scopes) values($1,$2,$3,$4,$5,$6,now()+interval '1 hour',now()+interval '1 day',$7)",
      [
        tokenHash(remoteAccess),
        tokenHash(remoteRefresh),
        randomUUID(),
        client,
        owner,
        origin + "/mcp",
        "orka.read orka.write orka.manage",
      ],
    );
    const instance = (await (
      await fetch(origin + "/v2/instance")
    ).json()) as Record<string, unknown>;
    assert.equal(instance.desktopConnector, 1);
    assert.equal(instance.pluginConnection, undefined);
    assert.equal((await request()).status, 401);
    for (const credential of [remoteAccess, remoteRefresh, "expired-session"]) {
      assert.equal((await request(credential)).status, 401);
      assert.equal((await call(credential, "get_profile")).status, 401);
    }
    const inventory = await request(`desktop-${owner}`);
    assert.equal(inventory.status, 200);
    const tools = (await inventory.json()) as {
      tools: { name: string; scope: string; securitySchemes?: unknown }[];
    };
    assert.equal(tools.tools.length, 18);
    assert.deepEqual(
      new Set(tools.tools.map((t) => t.scope)),
      new Set(["orka.read", "orka.write", "orka.manage"]),
    );
    assert.ok(tools.tools.every((t) => t.securitySchemes === undefined));
    for (const account of [owner, other, owner]) {
      const profile = await call(`desktop-${account}`, "get_profile");
      assert.equal(profile.status, 200);
      const data = (await profile.json()) as {
        structuredContent: Record<string, unknown>;
      };
      assert.equal(data.structuredContent.id, account);
      assert.equal(data.structuredContent.serviceOrigin, origin);
      assert.ok(!JSON.stringify(data).includes("connectionProof"));
      const projects = await call(`desktop-${account}`, "list_projects");
      assert.equal(projects.status, 200);
      assert.equal(
        JSON.stringify(await projects.json()).includes(project),
        account === owner,
      );
    }
    for (const body of [
      { name: "get_profile", arguments: {}, accountId: other },
      { name: "get_profile", arguments: { accountId: other } },
      { name: "get_profile", arguments: null },
      { name: "get_profile", arguments: [] },
      { name: "not_a_tool", arguments: {} },
      {
        name: "get_project_context",
        arguments: { projectId: project, scope: "../private" },
      },
    ])
      assert.equal((await request(`desktop-${owner}`, body)).status, 400);
    const spoof = await fetch(origin + "/v2/connector/tools", {
      method: "POST",
      headers: {
        Authorization: `Bearer desktop-${owner}`,
        "Content-Type": "application/json",
        "X-Orka-Account": other,
      },
      body: JSON.stringify({ name: "get_profile", arguments: {} }),
    });
    assert.equal(
      ((await spoof.json()) as { structuredContent: { id: string } })
        .structuredContent.id,
      owner,
    );
    const denied = await call(`desktop-${other}`, "get_project_context", {
      projectId: project,
    });
    assert.equal(denied.status, 403);
    expired.add(`desktop-${owner}`);
    assert.equal((await call(`desktop-${owner}`, "get_profile")).status, 401);
    assert.equal((await call(`desktop-${other}`, "get_profile")).status, 200);
    for (const path of [
      "/mcp",
      "/mcp/connect",
      "/authorize",
      "/register",
      "/token",
      "/revoke",
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
      "/v2/plugin/connection",
      "/v2/plugin/connection/verify",
    ]) {
      for (const method of ["GET", "POST", "OPTIONS"]) {
        const response = await fetch(origin + path, {
          method,
          redirect: "manual",
          headers: { Authorization: `Bearer ${remoteAccess}` },
        });
        assert.equal(response.status, 410, `${method} ${path}`);
        const failure = (await response.json()) as {
          error: string;
          error_description: string;
        };
        assert.equal(failure.error, "desktop_required");
        assert.ok(failure.error_description.includes("Orka desktop"));
        assert.equal(response.headers.get("set-cookie"), null);
        assert.equal(response.headers.get("location"), null);
      }
    }
    assert.equal(
      (
        await pool.query(
          "select count(*)::int n from orka.mcp_tokens where client_id=$1",
          [client],
        )
      ).rows[0].n,
      1,
      "retirement must not delete historical account data",
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await pool.query("delete from orka.mcp_clients where id=$1", [client]);
    await pool.query("delete from orka.projects where id=$1", [project]);
    await store.close();
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
});
