import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ResourceInput, Resource } from "@portable/protocol";
import { Store, HttpError } from "./bridge/store.js";
import { Blobs } from "./fixtures/blobs.js";
import { createApi } from "./bridge/main.js";
import { authSettings } from "./bridge/auth.js";
import { readSession } from "./bridge/mcp.js";
import { addSources } from "./bridge/sources.js";
import { acceptingMemoryResolver } from "./fixtures/memory-fixtures.js";

await test("Desktop connector API preserves project ACLs, teammate sessions, pagination and handoff", async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const directory = await mkdtemp(join(tmpdir(), "orka-mcp-"));
  const store = new Store(
    pool,
    new Blobs(directory),
    acceptingMemoryResolver(),
  );
  const owner = randomUUID(),
    teammate = randomUUID();
  const project = await store.createProject(owner, "Plugin acceptance", true);
  const webSource = randomUUID(),
    apiSource = randomUUID();
  await addSources(store, owner, {
    projectId: project,
    sources: [
      { id: webSource, name: "web" },
      { id: apiSource, name: "api" },
    ],
  });
  await pool.query("insert into orka.members values($1,$2,'member')", [
    project,
    teammate,
  ]);
  await pool.query(
    "insert into orka.env_profiles values($1,'Owner fixture'),($2,'Teammate fixture')",
    [owner, teammate],
  );
  await store.device(owner, owner, "Fixture Mac");
  await store.device(teammate, teammate, "Teammate Mac");
  const reservation = createServer();
  await new Promise<void>((r) => reservation.listen(0, "127.0.0.1", r));
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((r) => reservation.close(() => r()));
  const origin = `http://127.0.0.1:${address.port}`;
  const server = createApi(
    store,
    async (token) => {
      if (token === `native-${teammate}`) return teammate;
      throw new HttpError(401, "Invalid native credentials");
    },
    undefined,
    // Valid configuration may differ from the browser's canonical Origin header.
    authSettings({ PUBLIC_URL: `http://127.0.0.1:0${address.port}` }),
  );
  await new Promise<void>((r) => server.listen(address.port, "127.0.0.1", r));
  const file = async (content: string, path = "content.md") => {
    const bytes = Buffer.from(content),
      hash = await store.blobs.put(project, bytes);
    await pool.query(
      "insert into orka.blobs values($1,$2,$3) on conflict do nothing",
      [project, hash, bytes.length],
    );
    await pool.query(
      "insert into orka.blob_uploads values($1,$2,$3) on conflict do nothing",
      [project, hash, owner],
    );
    return { path, hash, size: bytes.length, executable: false };
  };
  const publish = async (resource: ResourceInput) => {
    const result = await store.mutate(owner, {
      version: 2,
      id: randomUUID(),
      projectId: project,
      deviceId: owner,
      baseRevision: 0,
      resource,
    });
    assert.ok(result);
    return resource.resourceId;
  };
  const hide = async (resourceId: string) => {
    await pool.query(
      "insert into orka.resource_access values($1,$2,$3,$4) on conflict(project_id,resource_id,user_id) do update set rule=excluded.rule",
      [project, resourceId, teammate, { mode: "hidden", canShare: false }],
    );
  };
  const memory = async (content: string, scope = "", sourceId?: string) => {
    const id = randomUUID();
    await publish({
      resourceId: id,
      sourceId,
      kind: "memory",
      source: "shared",
      title: content.slice(0, 80),
      logicalPath: `knowledge/${id}.md`,
      memory: {
        topic: content.slice(0, 80),
        scope,
        provider: "manual",
        supersedes: [],
      },
      deleted: false,
      files: [await file(content)],
    });
    return id;
  };
  const session = async (
    content: string,
    extra: Partial<ResourceInput> = {},
  ) => {
    const id = randomUUID();
    await publish({
      resourceId: id,
      kind: "session",
      source: "claude",
      title: "Authentication decisions",
      logicalPath: `claude/${id}.jsonl`,
      deleted: false,
      files: [await file(content, "session.jsonl")],
      ...extra,
    });
    return id;
  };
  const connect = async (access = `native-${teammate}`) => access;
  const call = async (
    access: string,
    name: string,
    args: Record<string, unknown> = {},
  ) => {
    const response = await fetch(origin + "/v2/connector/tools", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name, arguments: args }),
    });
    const value = await response.json();
    if (!response.ok)
      return { isError: true, data: value as Record<string, unknown> };
    const result = CallToolResultSchema.parse(value);
    return {
      ...result,
      data: result.structuredContent as Record<string, unknown>,
    };
  };
  try {
    const publicMemory = await memory("Use PKCE for authentication");
    const hiddenMemory = await memory("HIDDEN_OWNER_KNOWLEDGE");
    await hide(hiddenMemory);
    const nestedMemory = await memory(
      "Use the UI form component",
      "apps/web",
      webSource,
    );
    const apiMemory = await memory(
      "Use the API validation component",
      "apps/web",
      apiSource,
    );
    const longMemory = await memory("LONG_" + "x".repeat(45000));
    const native = (sessionId: string, content: string) =>
      JSON.stringify({
        type: "user",
        sessionId,
        message: { role: "user", content },
      }) +
      "\n" +
      JSON.stringify({
        type: "assistant",
        sessionId,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "We chose email-first onboarding." }],
        },
      }) +
      "\n";
    const authorSession = await session(
      native(randomUUID(), "Implement login"),
      { sourceId: webSource },
    );
    const apiSession = await session(
      native(randomUUID(), "API source session"),
      { sourceId: apiSource },
    );
    const teammateSession = await session(
      native(randomUUID(), "Team member session"),
    );
    await pool.query(
      "update orka.resources set payload=jsonb_set(payload,'{owner}',$3::jsonb) where project_id=$1 and id=$2",
      [project, teammateSession, JSON.stringify(teammate)],
    );
    const hiddenSession = await session(
      native(randomUUID(), "HIDDEN_SESSION_CONTENT"),
    );
    await hide(hiddenSession);
    const derivedSession = await session(
      native(randomUUID(), "DERIVED_HIDDEN_CONTENT"),
      { contextSources: [hiddenMemory] },
    );

    const client = await connect();
    const inventory = await fetch(origin + "/v2/connector/tools", {
      headers: { Authorization: `Bearer ${client}` },
    });
    assert.equal(inventory.status, 200);
    const tools = (await inventory.json()) as {
      tools: { annotations?: { readOnlyHint?: boolean } }[];
    };
    assert.equal(tools.tools.length, 18);
    assert.equal(
      tools.tools.filter((t) => t.annotations?.readOnlyHint).length,
      13,
    );
    const profile = await call(client, "get_profile");
    assert.equal(profile.data.id, teammate);
    const projects = await call(client, "list_projects");
    assert.ok(JSON.stringify(projects.data).includes("Plugin acceptance"));
    assert.ok(JSON.stringify(projects.data).includes(webSource));
    const context = await call(client, "get_project_context", {
      projectId: project,
    });
    assert.ok(JSON.stringify(context.data).includes("Use PKCE"));
    assert.ok(!JSON.stringify(context.data).includes("HIDDEN_OWNER_KNOWLEDGE"));
    assert.ok(
      !JSON.stringify(context.data).includes("Use the UI form component"),
    );
    const scoped = await call(client, "get_project_context", {
      projectId: project,
      sourceId: webSource,
      scope: "apps/web/components",
    });
    assert.ok(JSON.stringify(scoped.data).includes(nestedMemory));
    assert.ok(!JSON.stringify(scoped.data).includes(apiMemory));
    assert.equal(
      (
        await call(client, "get_project_context", {
          projectId: project,
          scope: "apps/web/components",
        })
      ).isError,
      true,
    );
    assert.equal(
      (
        await call(client, "get_project_context", {
          projectId: project,
          sourceId: randomUUID(),
        })
      ).isError,
      true,
    );
    const webSessions = await call(client, "list_sessions", {
      projectId: project,
      sourceId: webSource,
    });
    assert.ok(JSON.stringify(webSessions.data).includes(authorSession));
    assert.ok(!JSON.stringify(webSessions.data).includes(apiSession));
    const members = await call(client, "list_team_members", {
      projectId: project,
    });
    assert.ok(JSON.stringify(members.data).includes("Teammate fixture"));
    const sessions = await call(client, "list_sessions", {
      projectId: project,
      memberId: teammate,
    });
    assert.ok(JSON.stringify(sessions.data).includes(teammateSession));
    assert.ok(!JSON.stringify(sessions.data).includes(authorSession));
    const allSessions = await call(client, "list_sessions", {
      projectId: project,
    });
    assert.ok(!JSON.stringify(allSessions.data).includes(hiddenSession));
    assert.ok(!JSON.stringify(allSessions.data).includes(derivedSession));
    assert.equal(
      (
        await call(client, "fetch_resource", {
          projectId: project,
          resourceId: hiddenSession,
        })
      ).isError,
      true,
    );
    assert.equal(
      (
        await call(client, "fetch_resource", {
          projectId: project,
          resourceId: derivedSession,
        })
      ).isError,
      true,
    );
    assert.equal(
      (
        await call(client, "fetch_resource", {
          projectId: project,
          resourceId: hiddenMemory,
        })
      ).isError,
      true,
    );
    const first = await call(client, "fetch_resource", {
      projectId: project,
      resourceId: longMemory,
    });
    assert.equal(first.data.nextOffset, 40000);
    assert.equal(
      (
        await call(client, "fetch_resource", {
          projectId: project,
          resourceId: longMemory,
          offset: 40000,
        })
      ).isError,
      true,
    );
    assert.equal(
      (
        await call(client, "fetch_resource", {
          projectId: project,
          resourceId: longMemory,
          offset: 40000,
          expectedRevision: first.data.revision,
        })
      ).isError,
      undefined,
    );
    const handoff = await call(client, "prepare_claude_handoff", {
      projectId: project,
      goal: "Implement onboarding in Claude Code",
      sessionIds: [authorSession],
      resourceIds: [publicMemory],
      currentContext: "We decided to ship email sign-in first.",
      decisions: ["Email first"],
      nextSteps: ["Verify repository, then implement form"],
    });
    assert.equal(handoff.isError, undefined, JSON.stringify(handoff));
    assert.ok(
      String(handoff.data.markdown).includes(
        "We chose email-first onboarding.",
      ),
    );
    assert.ok(
      String(handoff.data.markdown).includes(
        "We decided to ship email sign-in first.",
      ),
    );
    assert.equal(handoff.data.createdSharedResource, false);
    assert.ok(String(handoff.data.delivery).includes("does not launch"));
    assert.equal(
      (
        await call(client, "prepare_claude_handoff", {
          projectId: project,
          goal: "Continue",
          sessionIds: [hiddenSession],
        })
      ).isError,
      true,
    );
    const sourcePage = await (
      await fetch(origin + `/mcp/source/${project}/${hiddenSession}`)
    ).text();
    assert.ok(!sourcePage.includes("HIDDEN_SESSION_CONTENT"));
    assert.ok(
      sourcePage.includes(`orka://project/${project}/${hiddenSession}`),
    );
    const unknown = await call(client, "get_project_context", {
      projectId: randomUUID(),
    });
    assert.equal(unknown.isError, true);
    const beforeCount = (
      await pool.query(
        "select count(*)::int as n from orka.resources where project_id=$1",
        [project],
      )
    ).rows[0].n;
    await call(client, "prepare_claude_handoff", {
      projectId: project,
      goal: "Continue",
      sessionIds: [authorSession],
    });
    assert.equal(
      (
        await pool.query(
          "select count(*)::int as n from orka.resources where project_id=$1",
          [project],
        )
      ).rows[0].n,
      beforeCount,
    );
    const contextIds = [];
    for (let i = 0; i < 21; i++)
      contextIds.push(await memory(`CONTEXT_PAGINATION_${i}`));
    const contextPage = await call(client, "get_project_context", {
      projectId: project,
      query: "CONTEXT_PAGINATION_",
    });
    assert.equal((contextPage.data.items as unknown[]).length, 20);
    assert.ok(contextPage.data.nextCursor);
    const contextNext = await call(client, "get_project_context", {
      projectId: project,
      query: "CONTEXT_PAGINATION_",
      cursor: contextPage.data.nextCursor,
    });
    assert.equal((contextNext.data.items as unknown[]).length, 1);
    assert.equal(contextNext.data.nextCursor, null);
    assert.deepEqual(
      new Set(
        [
          ...(contextPage.data.items as { id: string }[]),
          ...(contextNext.data.items as { id: string }[]),
        ].map((item) => item.id),
      ),
      new Set(contextIds),
    );
    await pool.query(
      "delete from orka.members where project_id=$1 and user_id=$2",
      [project, teammate],
    );
    assert.equal(
      (
        await call(client, "fetch_resource", {
          projectId: project,
          resourceId: authorSession,
        })
      ).isError,
      true,
    );
    assert.equal(
      (await call(client, "list_team_members", { projectId: project })).isError,
      true,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await pool.query("delete from orka.projects where id=$1", [project]);
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("Codex inherited history reads the exact prefix and fails closed for changed boundaries", async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const directory = await mkdtemp(join(tmpdir(), "orka-mcp-lineage-"));
  const store = new Store(pool, new Blobs(directory));
  const project = randomUUID(),
    parent = randomUUID(),
    child = randomUUID();
  const encode = (rows: unknown[]) =>
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const parentText = encode([
    {
      ordinal: 0,
      type: "session_meta",
      payload: { id: parent, history_mode: "paginated" },
    },
    {
      ordinal: 1,
      type: "response_item",
      payload: { type: "message", role: "user", content: "Original request" },
    },
  ]);
  const childText = encode([
    {
      ordinal: 2,
      type: "session_meta",
      payload: {
        id: child,
        history_mode: "paginated",
        history_base: {
          thread_id: parent,
          end_ordinal_exclusive: 2,
          end_byte_offset: Buffer.byteLength(parentText),
        },
      },
    },
    {
      ordinal: 3,
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: "Continued response",
      },
    },
  ]);
  const file = async (path: string, text: string) => ({
    path,
    hash: await store.blobs.put(project, Buffer.from(text)),
    size: Buffer.byteLength(text),
    executable: false,
  });
  try {
    const resource = {
      kind: "session",
      source: "codex",
      projectId: project,
      deleted: false,
      files: [
        await file("session.jsonl", childText),
        await file(`lineage/${parent}/2.jsonl`, parentText),
      ],
    } as Resource;
    assert.deepEqual(await readSession(store, resource), [
      { role: "user", text: "Original request" },
      { role: "assistant", text: "Continued response" },
    ]);
    const extra =
      parentText +
      JSON.stringify({
        ordinal: 2,
        type: "response_item",
        payload: { role: "user", content: "UNINHERITED_SECRET" },
      }) +
      "\n";
    resource.files[1] = await file(`lineage/${parent}/2.jsonl`, extra);
    await assert.rejects(readSession(store, resource), /boundary/);
  } finally {
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
});
