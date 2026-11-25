import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, request, type Server } from "node:http";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import {
  appendFile,
  mkdtemp,
  mkdir,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { Store } from "./bridge/store.js";
import { createApi } from "./bridge/main.js";
import { authSettings } from "./bridge/auth.js";
import { Blobs } from "./fixtures/blobs.js";

const binary = process.env.ORKA_TEST_NATIVE_BINARY;
const relayBinary = process.env.ORKA_TEST_LIVE_RELAY_BINARY;

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  return "http://127.0.0.1:" + addr.port;
}

async function native(env: NodeJS.ProcessEnv, args: string[], body: unknown) {
  const p = spawn(binary!, args, { env });
  const done = once(p, "close");
  let out = "",
    err = "";
  p.stdout.on("data", (b) => {
    out += b.toString();
  });
  p.stderr.on("data", (b) => {
    err += b.toString();
  });
  p.stdin.end(JSON.stringify(body));
  assert.equal((await done)[0], 0, err || out);
  return JSON.parse(out);
}

function resident(env: NodeJS.ProcessEnv) {
  const child = spawn(binary!, ["--orka-live-fixture"], { env });
  const lines = createInterface({ input: child.stdout })[
    Symbol.asyncIterator
  ]();
  const exit = once(child, "close");
  return {
    call: async (action: string, input: object) => {
      child.stdin.write(JSON.stringify({ action, input }) + "\n");
      const line = await lines.next();
      assert.ok(!line.done, "Native actor exited");
      const reply = JSON.parse(line.value);
      assert.ok(reply.ok, reply.error);
      return reply.value;
    },
    close: async () => {
      child.stdin.end();
      await exit;
    },
  };
}

for (const publisher of ["claude", "codex"] as const)
  await test(
    publisher +
      " live session delivers redacted turns to a native teammate and next-prompt hook",
    {
      skip: !binary || !relayBinary,
      timeout: 90_000,
    },
    async (t) => {
      const home = await mkdtemp(join(tmpdir(), "orka-live-native-"));
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      const store = new Store(pool, new Blobs(join(home, "blobs")));
      const writer = randomUUID(),
        reader = randomUUID(),
        sourceId = randomUUID(),
        id = randomUUID(),
        nativeId = randomUUID(),
        targetId = randomUUID(),
        secret = randomUUID();
      const projectId = await store.createProject(
        writer,
        "Live experiment",
        true,
      );
      const core = createApi(store, async (bearer) => {
        assert.ok(bearer === writer || bearer === reader);
        return bearer;
      });
      const coreOrigin = await listen(core);
      const empty = createServer();
      const relayOrigin = await listen(empty);
      await new Promise<void>((resolve) => empty.close(() => resolve()));
      await fetch(coreOrigin + "/v2/projects/capabilities", {
        headers: { Authorization: "Bearer " + writer },
      }).then((r) => r.text());
      await store.invoke("configure", {
        settings: authSettings({ DEPLOYMENT_MODE: "self-hosted" }),
        environment: {
          ORKA_EXPERIMENTAL_LIVE_SESSIONS: "1",
          ORKA_LIVE_SESSION_RELAY_SECRET: secret,
        },
      });
      const relay = spawn(relayBinary!, [], {
        env: {
          ...process.env,
          ORKA_EXPERIMENTAL_LIVE_SESSIONS: "1",
          ORKA_LIVE_SESSION_CORE_URL: coreOrigin,
          ORKA_LIVE_SESSION_RELAY_SECRET: secret,
          ORKA_LIVE_SESSION_JOURNAL_DIR: join(home, "journal"),
          ORKA_LIVE_SESSION_LISTEN: new URL(relayOrigin).host,
        },
      });
      const relayExit = once(relay, "close");
      const writes: string[] = [];
      const edge = createServer((req, res) => {
        const route = req.url ?? "/";
        const live = route.startsWith("/v1/live/rooms/");
        if (live && req.method !== "GET") writes.push(route.split("/").at(-1)!);
        const upstream = request(
          new URL(route, live ? relayOrigin : coreOrigin),
          { headers: req.headers, method: req.method },
          (response) => {
            res.writeHead(response.statusCode!, response.headers);
            response.pipe(res);
          },
        );
        upstream.on("error", () => {
          res.writeHead(502);
          res.end();
        });
        res.once("close", () => upstream.destroy());
        req.pipe(upstream);
      });
      const origin = await listen(edge);
      const actors: ReturnType<typeof resident>[] = [];
      t.after(async () => {
        for (const actor of actors) await actor.close();
        edge.closeAllConnections();
        edge.close();
        relay.kill();
        await relayExit;
        core.closeAllConnections();
        core.close();
        await store.close();
        await pool.end();
        await rm(home, { recursive: true, force: true });
      });
      for (let i = 0; i < 100; i++) {
        try {
          await fetch(relayOrigin + "/").then((r) => r.text());
          break;
        } catch {
          await delay(30);
        }
      }
      await pool.query("insert into orka.members values($1,$2,'member')", [
        projectId,
        reader,
      ]);
      await pool.query(
        "insert into orka.project_sources(project_id,id,name) values($1,$2,'Fixture repository')",
        [projectId, sourceId],
      );
      const resource = {
        resourceId: id,
        projectId,
        sourceId,
        source: publisher,
        kind: "session",
        owner: writer,
        updatedBy: writer,
        revision: 1,
        deleted: false,
        contextSources: [],
        files: [],
        logicalPath: publisher + "/" + nativeId,
        title: "Live migration review",
      };
      await pool.query("insert into orka.resources values($1,$2,$3,$4)", [
        projectId,
        id,
        1,
        resource,
      ]);
      const recipient = publisher === "claude" ? "codex" : "claude";
      const record = (role: string, text: string, root: string) =>
        JSON.stringify(
          publisher === "codex"
            ? {
                type: "response_item",
                payload: {
                  type: "message",
                  role,
                  content: [
                    {
                      type: role === "user" ? "input_text" : "output_text",
                      text,
                    },
                  ],
                },
              }
            : {
                type: role,
                uuid: randomUUID(),
                parentUuid: null,
                sessionId: nativeId,
                cwd: root,
                version: "2.1.284",
                message: { role, content: text },
              },
        ) + "\n";
      const setup = async (userId: string) => {
        const isolated = join(home, userId);
        const root = join(isolated, "project");
        await mkdir(root, { recursive: true });
        const cwd = await realpath(root);
        const env = {
          ...process.env,
          ORKA_TEST_HOME: isolated,
          CODEX_HOME: join(isolated, "codex"),
          CLAUDE_CONFIG_DIR: join(isolated, "claude"),
        };
        const rpc = (body: unknown) => native(env, ["--orka-test"], body);
        await rpc({
          action: "configure",
          config: { apiUrl: origin, syncMinutes: 15 },
        });
        await rpc({
          action: "test-session",
          session: {
            access_token: userId,
            refresh_token: "fixture",
            expires_in: 3600,
            user: { id: userId },
          },
        });
        const snapshot = await rpc({ action: "snapshot" });
        await store.device(userId, snapshot.deviceId, "Fixture Mac");
        const database = (
          await readdir(join(isolated, "orka"), { recursive: true })
        ).find((name) => name.includes(userId) && name.endsWith("sync.sqlite"));
        assert.ok(database);
        const local = new DatabaseSync(join(isolated, "orka", database));
        const project = {
          id: projectId,
          name: "Test",
          path: cwd,
          sourceModel: 1,
          sources: [{ id: sourceId, path: cwd, name: "Fixture repository" }],
          governed: true,
          sharing: {
            session: false,
            memory: false,
            plan: false,
            skill: false,
            env: false,
          },
        };
        local
          .prepare("insert into projects values(?,?)")
          .run(projectId, JSON.stringify(project));
        local
          .prepare("insert into resources values(?,?,?)")
          .run(id, projectId, JSON.stringify(resource));
        const folder =
          publisher === "codex"
            ? join(env.CODEX_HOME, "sessions", "2026", "11", "25")
            : join(env.CLAUDE_CONFIG_DIR, "projects", "fixture");
        const path = join(
          folder,
          (publisher === "codex" ? "rollout-2026-11-25T10-00-00-" : "") +
            nativeId +
            ".jsonl",
        );
        if (userId === writer) {
          await mkdir(folder, { recursive: true });
          const metadata =
            publisher === "codex"
              ? JSON.stringify({
                  type: "session_meta",
                  payload: {
                    id: nativeId,
                    cwd,
                    timestamp: "2026-11-25T10:00:00Z",
                  },
                }) + "\n"
              : "";
          await writeFile(
            path,
            metadata + record("user", "Review the migration.", cwd),
          );
          local.prepare("insert into bindings values(?,?,?)").run(
            id,
            projectId,
            JSON.stringify({
              base: resource,
              nativeId,
              paths: [path],
              managed: false,
            }),
          );
        }
        local.close();
        const actor = resident(env);
        actors.push(actor);
        return {
          cwd,
          path,
          env,
          run: (action: string, extra: object = {}) =>
            actor.call(action, { id, projectId, userId, ...extra }),
        };
      };
      const author = await setup(writer),
        viewer = await setup(reader);
      assert.equal((await author.run("status")).eligible, true);
      const start = await author.run("start");
      assert.equal(start.active, true);
      const episode = { episodeId: start.episodeId };
      await viewer.run("follow", episode);
      const first = await viewer.run("read", episode);
      assert.deepEqual(
        first.messages.map((m: { text: string }) => m.text),
        ["Review the migration."],
      );
      const hook = (event: string) =>
        native(viewer.env, ["--orka-hook", recipient], {
          hook_event_name: event,
          session_id: targetId,
          cwd: viewer.cwd,
        });
      await hook("SessionStart");
      const targets = await viewer.run("targets", episode);
      assert.ok(
        targets.targets.some(
          (r: { nativeId: string }) => r.nativeId === targetId,
        ),
      );
      await viewer.run("agent_follow", {
        ...episode,
        provider: recipient,
        nativeId: targetId,
      });
      const syntheticCredential = "sk-" + "fixture".repeat(6);
      const started = performance.now();
      const next = viewer.run("wait", { ...episode, cursor: first.cursor });
      await appendFile(
        author.path,
        record(
          "assistant",
          "Existing sessions keep their IDs. " + syntheticCredential,
          author.cwd,
        ),
      );
      const delivered = await next;
      const latency = performance.now() - started;
      assert.equal(
        delivered.messages.at(-1)?.text,
        "Existing sessions keep their IDs. [REDACTED]",
      );
      assert.equal(delivered.messages.length, 2);
      assert.ok(delivered.cursor > first.cursor);
      assert.ok(writes.includes("append"));
      t.diagnostic(
        "native file append to authorized reader " +
          Math.round(latency) +
          " ms",
      );
      const prompt = JSON.stringify(await hook("UserPromptSubmit"));
      assert.match(prompt, /Existing sessions keep their IDs/);
      assert.ok(!prompt.includes(syntheticCredential));
      assert.doesNotMatch(
        JSON.stringify(await hook("UserPromptSubmit")),
        /Existing sessions keep their IDs/,
      );
      await viewer.run("unfollow", episode);
      await viewer.run("follow", episode);
      assert.deepEqual(
        (await viewer.run("read", episode)).messages,
        delivered.messages,
      );
      await pool.query(
        "delete from orka.members where project_id=$1 and user_id=$2",
        [projectId, reader],
      );
      await appendFile(
        author.path,
        record("assistant", "A turn after membership removal.", author.cwd),
      );
      await assert.rejects(viewer.run("read", episode));
      assert.doesNotMatch(
        JSON.stringify(await hook("UserPromptSubmit")),
        /after membership removal/,
      );
      await pool.query("insert into orka.members values($1,$2,'member')", [
        projectId,
        reader,
      ]);
      await viewer.run("follow", episode);
      assert.equal((await author.run("stop", episode)).active, false);
      await assert.rejects(viewer.run("read", episode));
      assert.doesNotMatch(
        JSON.stringify(await hook("UserPromptSubmit")),
        /Existing sessions keep their IDs/,
      );
    },
  );
