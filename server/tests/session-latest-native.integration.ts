import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import type { Change, ResourceInput, SessionCopy } from "@portable/protocol";
import { createApi } from "./bridge/main.js";
import { Store, HttpError } from "./bridge/store.js";
import { Blobs, bytesHash } from "./fixtures/blobs.js";

const binary = process.env.ORKA_TEST_NATIVE_BINARY;
const records = (text: string) =>
  text
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);

await test(
  "native latest-only copies preserve frozen selections and uncertain retries after source updates",
  { skip: !binary },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "orka-native-latest-"));
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const store = new Store(pool, new Blobs(join(home, "server-blobs")));
    const teammate = randomUUID(),
      owner = randomUUID();
    const bridge = createApi(store, async (token) => {
      if (token !== owner && token !== teammate)
        throw new HttpError(401, "Fixture credentials required");
      return token;
    });
    await new Promise<void>((resolve) =>
      bridge.listen(0, "127.0.0.1", resolve),
    );
    const bridgeAddress = bridge.address();
    assert.ok(bridgeAddress && typeof bridgeAddress !== "string");
    const bridgeOrigin = `http://127.0.0.1:${bridgeAddress.port}`;
    let dropCopyResponses = true;
    const copyBodies: string[] = [];
    const proxyErrors: unknown[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        const isCopy = request.url === "/v2/sessions/copy";
        if (isCopy) copyBodies.push(body.toString());
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(request.headers))
          if (typeof value === "string" && name !== "host")
            headers[name] = value;
        const upstream = await fetch(bridgeOrigin + (request.url ?? "/"), {
          method: request.method,
          headers,
          body: body.length ? body : undefined,
        });
        const bytes = Buffer.from(await upstream.arrayBuffer());
        if (isCopy && upstream.ok && dropCopyResponses) {
          // The Go mutation succeeded, but the native process cannot know its
          // outcome. Its next process must retry the same frozen request.
          response.destroy();
          return;
        }
        response.writeHead(
          upstream.status,
          Object.fromEntries(upstream.headers),
        );
        response.end(bytes);
      })().catch((error: unknown) => {
        proxyErrors.push(error);
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "Native fixture proxy failed" }));
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const env = {
      ...process.env,
      ORKA_TEST_HOME: home,
      CODEX_HOME: join(home, ".codex"),
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
    };
    const runNative = async (input: unknown) => {
      const child = spawn(binary!, ["--orka-test"], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "",
        error = "";
      child.stdout.on("data", (chunk) => (output += String(chunk)));
      child.stderr.on("data", (chunk) => (error += String(chunk)));
      child.stdin.end(JSON.stringify(input));
      const timer = setTimeout(() => child.kill("SIGTERM"), 30000);
      const code = await new Promise<number | null>((resolve) =>
        child.once("exit", resolve),
      );
      clearTimeout(timer);
      return { code, output, error };
    };
    const native = async (input: unknown) => {
      const result = await runNative(input);
      assert.equal(result.code, 0, result.error || result.output);
      return JSON.parse(result.output) as unknown;
    };
    let projectId: string | undefined;
    let signedIn = false;
    try {
      await native({
        action: "configure",
        config: { apiUrl: origin, syncMinutes: 15 },
      });
      await native({
        action: "test-session",
        session: {
          access_token: owner,
          refresh_token: "fixture-refresh",
          expires_in: 3600,
          user: { id: owner },
        },
      });
      signedIn = true;
      projectId = await store.createProject(
        teammate,
        "Native latest-only fixture",
        true,
      );
      await pool.query("insert into orka.members values($1,$2,'member')", [
        projectId,
        owner,
      ]);
      await store.device(teammate, teammate, "Teammate Mac");
      const sourceId = randomUUID();
      await pool.query("update orka.projects set source_model=1 where id=$1", [
        projectId,
      ]);
      await pool.query(
        "insert into orka.project_sources(project_id,id,name) values($1,$2,'Fixture repository')",
        [projectId, sourceId],
      );
      const directory = join(home, "project");
      await mkdir(directory);
      const root = await realpath(directory);
      const nativeId = randomUUID();
      const firstTurn = {
        type: "user",
        uuid: randomUUID(),
        parentUuid: null,
        sessionId: nativeId,
        cwd: root,
        version: "2.1.284",
        message: { role: "user", content: "The complete cached conversation" },
      };
      const line = (record: unknown) => JSON.stringify(record) + "\n";
      const original = line(firstTurn);
      const remote =
        original +
        line({
          ...firstTurn,
          type: "assistant",
          uuid: randomUUID(),
          parentUuid: firstTurn.uuid,
          message: { role: "assistant", content: "A newer teammate turn" },
        });
      const continuation =
        original +
        line({
          ...firstTurn,
          uuid: randomUUID(),
          parentUuid: firstTurn.uuid,
          message: { role: "user", content: "My private local continuation" },
        });
      const upload = async (text: string) => {
        const bytes = Buffer.from(text),
          hash = bytesHash(bytes);
        const result = await fetch(
          `${bridgeOrigin}/v2/blobs/${projectId}/${hash}`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${teammate}`,
              "X-Orka-Governance": "1",
            },
            body: bytes,
          },
        );
        assert.equal(result.status, 200);
        return {
          path: "session.jsonl",
          hash,
          size: bytes.length,
          executable: false,
        };
      };
      const source: ResourceInput = {
        resourceId: randomUUID(),
        sourceId,
        kind: "session",
        source: "claude",
        logicalPath: `claude/${nativeId}`,
        title: "Complete cached conversation",
        files: [await upload(original)],
        deleted: false,
      };
      const first: Change = {
        version: 2,
        id: randomUUID(),
        projectId,
        deviceId: teammate,
        baseRevision: 0,
        resource: source,
      };
      const firstAck = await store.mutate(teammate, first);
      const latest: Change = {
        ...first,
        id: randomUUID(),
        baseRevision: firstAck.event.resource.revision,
        resource: { ...source, files: [await upload(remote)] },
      };
      const latestAck = await store.mutate(teammate, latest);
      // Force the native copy path to restore bytes from its retained cache.
      await pool.query(
        "delete from orka.blobs where project_id=$1 and hash=$2",
        [projectId, source.files[0].hash],
      );
      await rm(join(store.blobs.root, projectId, source.files[0].hash));

      const paths = await readdir(join(home, "orka"), { recursive: true });
      const database = paths.find(
        (path) => path.includes(owner) && path.endsWith("sync.sqlite"),
      );
      assert.ok(database);
      const databasePath = join(home, "orka", database);
      const localBlobs = join(home, "orka", "blobs");
      await mkdir(localBlobs, { recursive: true });
      await writeFile(join(localBlobs, source.files[0].hash), original);
      const sessionDirectory = join(home, ".claude", "projects", "fixture");
      await mkdir(sessionDirectory, { recursive: true });
      const nativePath = join(sessionDirectory, `${nativeId}.jsonl`);
      await writeFile(nativePath, continuation);
      const canonicalFiles = source.files.map(
        ({ executable, hash, path, size }) => ({
          executable,
          hash,
          path,
          size,
        }),
      );
      const manifestHash = bytesHash(
        Buffer.from(JSON.stringify(canonicalFiles)),
      );
      const local = new DatabaseSync(databasePath);
      const project = {
        id: projectId,
        name: "Native latest-only fixture",
        path: root,
        sourceModel: 1,
        sources: [{ id: sourceId, name: "Fixture repository", path: root }],
        governed: true,
        sharing: {
          memory: false,
          skill: false,
          plan: false,
          session: true,
          env: false,
        },
      };
      local
        .prepare("insert into projects values(?,?)")
        .run(projectId, JSON.stringify(project));
      local
        .prepare("insert into resources values(?,?,?)")
        .run(
          source.resourceId,
          projectId,
          JSON.stringify(firstAck.event.resource),
        );
      local.prepare("insert into bindings values(?,?,?)").run(
        source.resourceId,
        projectId,
        JSON.stringify({
          base: firstAck.event.resource,
          nativeId,
          paths: [nativePath],
          needsCopy: true,
          managed: true,
          lastSeenHash: manifestHash,
          guards: [manifestHash],
          writeGuard: manifestHash,
        }),
      );
      local.close();

      const uncertain = await runNative({ action: "sync" });
      assert.notEqual(
        uncertain.code,
        0,
        "The first successful copy response must be lost",
      );
      assert.match(uncertain.error, /Cloud unavailable|unreadable response/);
      assert.ok(copyBodies.length >= 1);
      assert.deepEqual(proxyErrors, []);
      const copyRequest = JSON.parse(copyBodies[0]) as SessionCopy;
      assert.deepEqual(copyRequest.sourceSnapshot?.files, source.files);
      assert.equal(
        copyRequest.expectedRevision,
        firstAck.event.resource.revision,
      );
      assert.equal(copyRequest.resourceId, source.resourceId);
      assert.equal(
        (await store.blobs.read(projectId, source.files[0].hash)).toString(),
        original,
      );
      assert.equal(
        (
          await pool.query(
            "select 1 from orka.blob_uploads where project_id=$1 and hash=$2 and author=$3",
            [projectId, source.files[0].hash, owner],
          )
        ).rowCount,
        1,
      );
      const copiedBeforeRetry = await pool.query<{
        payload: typeof firstAck.event.resource;
      }>("select payload from orka.resources where project_id=$1 and id=$2", [
        projectId,
        copyRequest.id,
      ]);
      assert.equal(copiedBeforeRetry.rowCount, 1);
      assert.equal(copiedBeforeRetry.rows[0].payload.owner, owner);
      assert.deepEqual(copiedBeforeRetry.rows[0].payload.files, source.files);
      assert.equal(await readFile(nativePath, "utf8"), continuation);

      const remoteAgain =
        remote +
        line({
          ...firstTurn,
          uuid: randomUUID(),
          parentUuid: firstTurn.uuid,
          message: {
            role: "user",
            content: "The teammate advanced again during the lost ACK",
          },
        });
      await store.mutate(teammate, {
        ...latest,
        id: randomUUID(),
        baseRevision: latestAck.event.resource.revision,
        resource: { ...source, files: [await upload(remoteAgain)] },
      });
      dropCopyResponses = false;
      // A fresh process reopens the durable outbox; the complete request body
      // must be identical to the uncertain attempt even after a remote advance.
      await native({ action: "sync" });
      assert.ok(copyBodies.length >= 2);
      for (const body of copyBodies) assert.equal(body, copyBodies[0]);
      assert.equal(await readFile(nativePath, "utf8"), continuation);
      const afterRetry = new DatabaseSync(databasePath);
      const adopted = afterRetry
        .prepare("select value from bindings where id=?")
        .get(copyRequest.id) as { value: string };
      assert.ok(adopted);
      assert.equal(JSON.parse(adopted.value).base.owner, owner);
      assert.deepEqual(JSON.parse(adopted.value).base.files, source.files);
      afterRetry.close();
      // The next ordinary sync publishes the local continuation in full as the
      // owned copy, without changing the teammate's current conversation.
      await native({ action: "sync" });
      const final = await pool.query<{
        id: string;
        payload: typeof firstAck.event.resource;
      }>(
        "select id,payload from orka.resources where project_id=$1 order by id",
        [projectId],
      );
      assert.equal(final.rowCount, 2);
      const ownedCopy = final.rows.find(
        (resource) => resource.id === copyRequest.id,
      )!;
      const currentSource = final.rows.find(
        (resource) => resource.id === source.resourceId,
      )!;
      assert.deepEqual(
        records(
          (
            await store.blobs.read(projectId, ownedCopy.payload.files[0].hash)
          ).toString(),
        ),
        records(continuation),
      );
      assert.deepEqual(
        records(
          (
            await store.blobs.read(
              projectId,
              currentSource.payload.files[0].hash,
            )
          ).toString(),
        ),
        records(remoteAgain),
      );
      assert.equal(await readFile(nativePath, "utf8"), continuation);

      // The explicit Create copy command freezes its selected cache revision
      // independently of a native binding, just like automatic promotion.
      await native({
        action: "session-action",
        operation: "copy",
        id: source.resourceId,
      });
      const manualLocal = new DatabaseSync(databasePath);
      const manualRow = manualLocal
        .prepare("select value from outbox where path='/v2/sessions/copy'")
        .get() as { value: string };
      assert.ok(manualRow);
      const manualRequest = JSON.parse(manualRow.value) as SessionCopy;
      assert.equal(
        manualRequest.expectedRevision,
        currentSource.payload.revision,
      );
      assert.deepEqual(
        manualRequest.sourceSnapshot?.files,
        currentSource.payload.files,
      );
      manualLocal.close();
      const finalRemote =
        remoteAgain +
        line({
          ...firstTurn,
          uuid: randomUUID(),
          parentUuid: firstTurn.uuid,
          message: {
            role: "user",
            content: "New teammate turn after the explicit offline selection",
          },
        });
      await store.mutate(teammate, {
        ...latest,
        id: randomUUID(),
        baseRevision: currentSource.payload.revision,
        resource: { ...source, files: [await upload(finalRemote)] },
      });
      await pool.query(
        "delete from orka.blobs where project_id=$1 and hash=$2",
        [projectId, currentSource.payload.files[0].hash],
      );
      await rm(
        join(store.blobs.root, projectId, currentSource.payload.files[0].hash),
      );
      await native({ action: "sync" });
      const manualWire = JSON.parse(copyBodies.at(-1)!) as SessionCopy;
      assert.deepEqual(manualWire, manualRequest);
      const manualCopy = await pool.query<{
        payload: typeof firstAck.event.resource;
      }>("select payload from orka.resources where project_id=$1 and id=$2", [
        projectId,
        manualRequest.id,
      ]);
      assert.equal(manualCopy.rowCount, 1);
      assert.equal(manualCopy.rows[0].payload.owner, owner);
      assert.deepEqual(
        records(
          (
            await store.blobs.read(
              projectId,
              manualCopy.rows[0].payload.files[0].hash,
            )
          ).toString(),
        ),
        records(remoteAgain),
      );
      const afterManual = new DatabaseSync(databasePath);
      const keptSource = afterManual
        .prepare("select value from bindings where id=?")
        .get(source.resourceId) as { value: string };
      assert.ok(keptSource);
      const keptBinding = JSON.parse(keptSource.value) as {
        nativeId: string;
        paths: string[];
        base: { resourceId: string; owner: string };
      };
      // Receiving a newer Claude revision may create a fresh native import.
      // The source binding must still describe the teammate's resource,
      // independently of the new manual owned copy.
      assert.equal(keptBinding.base.resourceId, source.resourceId);
      assert.equal(keptBinding.base.owner, teammate);
      afterManual.close();
      assert.equal(await readFile(nativePath, "utf8"), continuation);
      assert.deepEqual(proxyErrors, []);
    } finally {
      if (signedIn) await native({ action: "sign-out" });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => bridge.close(() => resolve()));
      if (projectId)
        await pool.query("delete from orka.projects where id=$1", [projectId]);
      await pool.end();
      await rm(home, { recursive: true, force: true });
    }
  },
);
