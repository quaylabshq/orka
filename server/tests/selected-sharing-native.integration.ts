import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  writeFile,
  appendFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Store, HttpError } from "./bridge/store.js";
import { Blobs } from "./fixtures/blobs.js";
import { createApi } from "./bridge/main.js";
import { startEnvMac, type EnvMac } from "./fixtures/env-native.js";

const binary = process.env.ORKA_TEST_NATIVE_BINARY;
const records = (text: string): unknown[] =>
  text
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
await test(
  "native plugin shares and updates only selected frozen sessions while automation stays off",
  { skip: !binary },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "orka-native-selected-"));
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const store = new Store(pool, new Blobs(join(home, "blobs")));
    const owner = randomUUID();
    const server = createApi(store, async (token) => {
      if (token !== owner)
        throw new HttpError(401, "Fixture credentials required");
      return owner;
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    let mac: EnvMac | undefined;
    const native = <T = Record<string, unknown>>(input: unknown) =>
      mac!.request<T>(input);
    let client: Client | undefined;
    try {
      const projectId = await store.createProject(
        owner,
        "Native selected fixture",
        true,
      );
      mac = await startEnvMac({
        home,
        name: "selected",
        user: owner,
        url: origin,
        project: projectId,
        binary,
        enable: false,
      });
      const root = await realpath(mac.path);
      const env = {
        ...process.env,
        ORKA_TEST_HOME: mac.root,
        CODEX_HOME: join(mac.root, ".codex"),
        CLAUDE_CONFIG_DIR: join(mac.root, ".claude"),
      };
      const paths = await readdir(join(mac.root, "orka"), { recursive: true });
      const database = paths.find(
        (path) => path.includes(owner) && path.endsWith("sync.sqlite"),
      );
      assert.ok(database);
      const sharing = {
        memory: false,
        skill: false,
        plan: false,
        session: false,
        env: false,
      };
      await native({
        action: "project",
        operation: "sharing",
        input: { projectId, sharing },
      });
      const nativeId = randomUUID();
      const sessions = join(mac.root, ".codex/sessions");
      await mkdir(sessions, { recursive: true });
      const session = join(sessions, `rollout-${nativeId}.jsonl`);
      const original =
        [
          {
            type: "session_meta",
            payload: {
              id: nativeId,
              cwd: root,
              source: "cli",
              cli_version: "0.159.2",
            },
          },
          {
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ text: "Explicitly share this snapshot" }],
            },
          },
        ]
          .map((record) => JSON.stringify(record))
          .join("\n") + "\n";
      await writeFile(session, original);
      await native({ action: "plugin-start" });
      client = new Client({
        name: "Orka native selected fixture",
        version: "0.2.0",
      });
      await client.connect(
        new StdioClientTransport({
          command: binary!,
          args: ["--orka-plugin"],
          env,
        }),
      );
      const status = await client.callTool({
        name: "get_connection_status",
        arguments: {},
      });
      assert.ok(!status.isError, JSON.stringify(status));
      const connection = status.structuredContent as {
        connection: { id: string };
      };
      const pending = await native<
        { requestId: string; client: { id: string } }[]
      >({ action: "plugin-requests" });
      const request = pending.find(
        (item) => item.client.id === connection.connection.id,
      );
      assert.ok(request, JSON.stringify(pending));
      const approvedScopes = ["orka.read", "orka.write"];
      const approval = await native<{
        account: { id: string };
        serviceOrigin: string;
      }>({
        action: "plugin-authorization",
        operation: "preview",
        input: { requestId: request.requestId },
      });
      assert.equal(approval.account.id, owner);
      assert.equal(approval.serviceOrigin, origin);
      assert.deepEqual(
        await native({
          action: "plugin-authorization",
          operation: "approve",
          input: { requestId: request.requestId, scopes: approvedScopes },
        }),
        { approved: true },
      );
      const scope = { projectId };
      const call = async (name: string, input: Record<string, unknown>) => {
        const result = await client!.callTool({
          name,
          arguments: { ...scope, ...input },
        });
        assert.ok(!result.isError, JSON.stringify(result));
        return result.structuredContent as Record<string, unknown>;
      };
      const catalog = await call("list_local_resources", {
        kind: "session",
        nativeId,
      });
      const item = (
        catalog.items as { resourceId: string; sourceId: string }[]
      )[0];
      assert.ok(item, JSON.stringify(catalog));
      assert.equal(item.sourceId, mac.sources[0].id);
      const preview = await call("preview_share", {
        kind: "session",
        resourceId: item.resourceId,
      });
      const future =
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ text: "Future private turn" }],
          },
        }) + "\n";
      await appendFile(session, future);
      const published = await call("share_selected", {
        previewToken: preview.previewToken,
      });
      assert.equal(published.status, "published");
      assert.deepEqual(
        await call("share_selected", { previewToken: preview.previewToken }),
        published,
      );
      const resources = await pool.query<{
        payload: { files: { hash: string }[] };
      }>("select payload from orka.resources where project_id=$1", [projectId]);
      assert.equal(resources.rowCount, 1);
      const oldHash = resources.rows[0].payload.files[0].hash;
      const frozen = (await store.blobs.read(projectId, oldHash)).toString();
      assert.deepEqual(records(frozen), records(original));
      const updated = await call("preview_share", {
        kind: "session",
        resourceId: item.resourceId,
      });
      assert.notEqual(updated.snapshotHash, preview.snapshotHash);
      assert.equal(
        (await call("share_selected", { previewToken: updated.previewToken }))
          .status,
        "published",
      );
      const current = await pool.query<{
        payload: { files: { hash: string }[] };
      }>("select payload from orka.resources where project_id=$1", [projectId]);
      assert.equal(current.rowCount, 1);
      assert.deepEqual(
        records(
          (
            await store.blobs.read(
              projectId,
              current.rows[0].payload.files[0].hash,
            )
          ).toString(),
        ),
        records(original + future),
      );
      assert.equal(
        (await store.blobs.read(projectId, oldHash)).toString(),
        frozen,
      );
      assert.equal(await readFile(session, "utf8"), original + future);
      const check = new DatabaseSync(join(mac.root, "orka", database));
      const saved = check
        .prepare("select value from projects where id=?")
        .get(projectId) as { value: string };
      assert.deepEqual(JSON.parse(saved.value).sharing, sharing);
      assert.equal(
        (
          check.prepare("select count(*) as count from outbox").get() as {
            count: number;
          }
        ).count,
        0,
      );
      check.close();
      const snapshot = await native<{
        projects: {
          id: string;
          sources: { id: string; path: string }[];
          sharing: typeof sharing;
        }[];
      }>({ action: "snapshot" });
      const mapped = snapshot.projects.filter(
        (project) => project.id === projectId,
      );
      assert.equal(mapped.length, 1);
      assert.deepEqual(
        mapped[0].sources.map((source) => source.id),
        [mac.sources[0].id],
      );
      assert.equal(mapped[0].sources[0].path, root);
      assert.deepEqual(mapped[0].sharing, sharing);
    } finally {
      await client?.close();
      if (mac) {
        try {
          await native({ action: "plugin-stop" });
          await native({ action: "plugin-sign-out" });
        } finally {
          await mac.close();
        }
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
      await rm(home, { recursive: true, force: true });
    }
  },
);
