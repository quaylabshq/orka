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
import type {
  Change,
  Receipt,
  ResourceInput,
  SessionCopy,
} from "@portable/protocol";
import { createApi } from "./bridge/main.js";
import { Store, HttpError } from "./bridge/store.js";
import { Blobs, bytesHash } from "./fixtures/blobs.js";

const binary = process.env.ORKA_TEST_NATIVE_BINARY;
const leaked = "sk-abcdefghijklmnopqrstuvwx";

for (const { operation, wasAccepted } of [
  { operation: "push", wasAccepted: true },
  { operation: "copy", wasAccepted: true },
  { operation: "push", wasAccepted: false },
] as const) {
  await test(
    wasAccepted
      ? `native rebuild acknowledges an accepted ${operation} after its old response was lost`
      : "native rebuild preserves an initial push until the service can fence its old identity",
    { skip: !binary },
    async () => {
      const home = await mkdtemp(join(tmpdir(), "orka-native-outbox-"));
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      const store = new Store(pool, new Blobs(join(home, "server-blobs")));
      const owner = randomUUID(),
        teammate = randomUUID(),
        device = randomUUID();
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
      const requests: { method: string; path: string; body: string }[] = [];
      const outgoingUploads = () =>
        requests.filter(
          (request) =>
            request.method === "PUT" ||
            (request.method === "POST" &&
              ["/v2/sessions/copy", "/v2/sync/push"].includes(request.path)),
        );
      const proxyErrors: unknown[] = [];
      let dropMutationResponse = true;
      let supportsReconciliation = true;
      const mutationPath =
        operation === "push" ? "/v2/sync/push" : "/v2/sessions/copy";
      const proxy = createServer((request, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const body = Buffer.concat(chunks);
          requests.push({
            method: request.method ?? "GET",
            path: request.url ?? "/",
            body: body.toString(),
          });
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(request.headers))
            if (typeof value === "string" && name !== "host")
              headers[name] = value;
          const upstream = await fetch(bridgeOrigin + (request.url ?? "/"), {
            method: request.method,
            headers,
            body: body.length ? body : undefined,
          });
          let bytes = Buffer.from(await upstream.arrayBuffer());
          if (
            dropMutationResponse &&
            request.url === mutationPath &&
            upstream.ok
          ) {
            // Model the pre-redaction desktop: the real Go mutation committed,
            // but neither the caller nor its durable outbox received the ACK.
            response.destroy();
            return;
          }
          if (
            !supportsReconciliation &&
            request.url === "/v2/projects/capabilities"
          ) {
            const capabilities = JSON.parse(bytes.toString()) as Record<
              string,
              unknown
            >;
            delete capabilities.sessionUploadReconcile;
            bytes = Buffer.from(JSON.stringify(capabilities));
          }
          const responseHeaders = Object.fromEntries(upstream.headers);
          delete responseHeaders["content-length"];
          response.writeHead(upstream.status, responseHeaders);
          response.end(bytes);
        })().catch((error: unknown) => {
          proxyErrors.push(error);
          response.writeHead(500, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({ error: "Native fixture proxy failed" }),
          );
        });
      });
      await new Promise<void>((resolve) =>
        proxy.listen(0, "127.0.0.1", resolve),
      );
      const address = proxy.address();
      assert.ok(address && typeof address !== "string");
      const origin = `http://127.0.0.1:${address.port}`;
      const native = async (input: unknown) => {
        const child = spawn(binary!, ["--orka-test"], {
          env: {
            ...process.env,
            ORKA_TEST_HOME: home,
            CODEX_HOME: join(home, ".codex"),
            CLAUDE_CONFIG_DIR: join(home, ".claude"),
          },
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
        assert.equal(code, 0, error || output);
        return JSON.parse(output) as unknown;
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
          "Native outbox reconciliation",
          true,
        );
        await pool.query("insert into orka.members values($1,$2,'member')", [
          projectId,
          owner,
        ]);
        await store.device(teammate, teammate, "Teammate Mac");
        await store.device(owner, device, "Original Mac");
        const sourceId = randomUUID();
        await pool.query(
          "update orka.projects set source_model=1 where id=$1",
          [projectId],
        );
        await pool.query(
          "insert into orka.project_sources(project_id,id,name) values($1,$2,'Fixture repository')",
          [projectId, sourceId],
        );
        const directory = join(home, "project");
        await mkdir(directory);
        const root = await realpath(directory);
        const nativeId = randomUUID();
        const line = (content: string) =>
          JSON.stringify({
            type: "user",
            uuid: randomUUID(),
            parentUuid: null,
            sessionId: nativeId,
            cwd: root,
            version: "2.1.284",
            message: { role: "user", content },
          }) + "\n";
        const baseline = line("Previously acknowledged conversation");
        const original = baseline + line(`Use ${leaked}`);
        const continuation = original + line("Private unsent continuation");
        const remote = original + line("A later turn from another Mac");
        const manifest = (text: string) => ({
          path: "session.jsonl",
          hash: bytesHash(Buffer.from(text)),
          size: Buffer.byteLength(text),
          executable: false,
        });
        const upload = async (text: string, user: string) => {
          const bytes = Buffer.from(text),
            hash = bytesHash(bytes);
          const response = await fetch(
            `${bridgeOrigin}/v2/blobs/${projectId}/${hash}`,
            {
              method: "PUT",
              headers: {
                Authorization: `Bearer ${user}`,
                "X-Orka-Governance": "1",
              },
              body: bytes,
            },
          );
          assert.equal(response.status, 200);
          return {
            path: "session.jsonl",
            hash,
            size: bytes.length,
            executable: false,
          };
        };
        const sourceOwner = operation === "copy" ? teammate : owner;
        const source: ResourceInput = {
          resourceId: randomUUID(),
          sourceId,
          kind: "session",
          source: "claude",
          logicalPath: `claude/${nativeId}`,
          title:
            operation === "copy" || !wasAccepted ? `Use ${leaked}` : "Baseline",
          files: [
            wasAccepted
              ? await upload(
                  operation === "copy" ? original : baseline,
                  sourceOwner,
                )
              : manifest(original),
          ],
          deleted: false,
        };
        const base: Receipt = wasAccepted
          ? await store.mutate(sourceOwner, {
              version: 2,
              id: randomUUID(),
              projectId,
              deviceId: sourceOwner === owner ? device : teammate,
              baseRevision: 0,
              resource: source,
            })
          : {
              event: {
                revision: 0,
                resource: {
                  ...source,
                  projectId,
                  revision: 0,
                  owner,
                  updatedBy: owner,
                  updatedAt: new Date().toISOString(),
                  hash: bytesHash(
                    Buffer.from(
                      JSON.stringify({ deleted: false, files: source.files }),
                    ),
                  ),
                },
                conflicts: [],
                activity: null,
              },
              conflict: false,
            };
        const raw: ResourceInput = {
          ...source,
          title: `Use ${leaked}`,
          files: [
            wasAccepted ? await upload(original, owner) : manifest(original),
          ],
        };
        const requestId = randomUUID();
        const queued: Change | SessionCopy =
          operation === "push"
            ? {
                version: 2,
                id: requestId,
                projectId,
                deviceId: device,
                baseRevision: base.event.resource.revision,
                resource: raw,
              }
            : {
                version: 2,
                id: requestId,
                projectId,
                deviceId: device,
                resourceId: source.resourceId,
                expectedRevision: base.event.resource.revision,
                sourceSnapshot: raw,
              };
        let accepted: Receipt | undefined;
        let latest: Receipt | undefined;
        if (wasAccepted) {
          await assert.rejects(
            fetch(origin + mutationPath, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${owner}`,
                "Content-Type": "application/json",
                "X-Orka-Governance": "1",
              },
              body: JSON.stringify(queued),
            }),
            /fetch failed/,
          );
          const receipts = await pool.query<{ payload: Receipt }>(
            "select payload from orka.receipts where project_id=$1 and author=$2 and id=$3",
            [projectId, owner, requestId],
          );
          assert.equal(receipts.rowCount, 1);
          accepted = receipts.rows[0].payload;
          assert.equal(accepted.event.resource.owner, owner);
          assert.deepEqual(accepted.event.resource.files, raw.files);

          // Another Mac advances the accepted resource. Recovery must use the
          // immutable receipt, not this newer state as the native baseline.
          const acceptedInput: ResourceInput = {
            ...raw,
            resourceId: accepted.event.resource.resourceId,
            logicalPath: accepted.event.resource.logicalPath,
            title: "A later server conversation",
            files: [await upload(remote, owner)],
          };
          latest = await store.mutate(owner, {
            version: 2,
            id: randomUUID(),
            projectId,
            deviceId: device,
            baseRevision: accepted.event.resource.revision,
            resource: acceptedInput,
          });
        } else {
          assert.equal(
            (
              await pool.query(
                "select 1 from orka.resources where project_id=$1",
                [projectId],
              )
            ).rowCount,
            0,
          );
        }
        dropMutationResponse = false;
        const paths = await readdir(join(home, "orka"), { recursive: true });
        const database = paths.find(
          (path) => path.includes(owner) && path.endsWith("sync.sqlite"),
        );
        assert.ok(database);
        const databasePath = join(home, "orka", database);
        const localBlobs = join(home, "orka", "blobs");
        await mkdir(localBlobs, { recursive: true });
        await writeFile(join(localBlobs, raw.files[0].hash), original);
        const sessionDirectory = join(home, ".claude", "projects", "fixture");
        await mkdir(sessionDirectory, { recursive: true });
        const nativePath = join(sessionDirectory, `${nativeId}.jsonl`);
        await writeFile(nativePath, continuation);
        const manifestHash = bytesHash(
          Buffer.from(
            JSON.stringify(
              raw.files.map(({ executable, hash, path, size }) => ({
                executable,
                hash,
                path,
                size,
              })),
            ),
          ),
        );
        const local = new DatabaseSync(databasePath);
        local
          .prepare("insert into meta values('device',?)")
          .run(JSON.stringify(device));
        local.prepare("insert into projects values(?,?)").run(
          projectId,
          JSON.stringify({
            id: projectId,
            name: "Native outbox reconciliation",
            path: root,
            governed: true,
            sourceModel: 1,
            sources: [{ id: sourceId, name: "Fixture repository", path: root }],
            sharing: {
              memory: false,
              skill: false,
              plan: false,
              session: true,
              env: false,
            },
          }),
        );
        local
          .prepare("insert into resources values(?,?,?)")
          .run(
            source.resourceId,
            projectId,
            JSON.stringify(base.event.resource),
          );
        const seededBinding = {
          base: wasAccepted
            ? base.event.resource
            : { ...base.event.resource, files: [] },
          nativeId,
          paths: [nativePath],
          managed: true,
          lastSeenHash: manifestHash,
          guards: [manifestHash],
          writeGuard: manifestHash,
          ...(operation === "copy"
            ? { needsCopy: true, copyRequest: requestId }
            : {}),
        };
        local
          .prepare("insert into bindings values(?,?,?)")
          .run(source.resourceId, projectId, JSON.stringify(seededBinding));
        local
          .prepare("insert into outbox values(?,?,?,?,?)")
          .run(
            requestId,
            projectId,
            mutationPath,
            JSON.stringify(queued),
            operation === "copy"
              ? "422: Session upload blocked because the snapshot still contains a recognized secret"
              : "Cloud unavailable; local work stays queued",
          );
        if (operation === "copy") {
          local
            .prepare("insert into meta values(?,?)")
            .run(
              `sessionCopy:${requestId}`,
              JSON.stringify({ source: base.event.resource, negotiate: false }),
            );
        }
        local.close();
        supportsReconciliation = false;
        requests.length = 0;

        // An older service cannot establish the old request's outcome. Keep the
        // exact uncertain retry until an upgraded service can reconcile it.
        for (let attempt = 0; attempt < (wasAccepted ? 1 : 2); attempt++) {
          await native({ action: "sync" });
          const waiting = new DatabaseSync(databasePath);
          try {
            const retained = waiting
              .prepare("select value,error from outbox where id=?")
              .get(requestId) as { value: string; error: string } | undefined;
            assert.ok(
              retained,
              "An old service must retain the unfenced request",
            );
            assert.equal(retained.value, JSON.stringify(queued));
            assert.match(
              retained.error,
              /Update the service to safely rebuild queued session uploads/,
            );
            if (!wasAccepted) {
              const binding = waiting
                .prepare("select value from bindings where id=?")
                .get(source.resourceId) as { value: string } | undefined;
              assert.ok(binding);
              assert.deepEqual(JSON.parse(binding.value), seededBinding);
              assert.equal(
                waiting
                  .prepare("select value from meta where key=?")
                  .get(`policyRevision:${projectId}`),
                undefined,
                "The missing initial upload must not be discarded by a permission-feed reset",
              );
            }
          } finally {
            waiting.close();
          }
        }
        assert.equal(await readFile(nativePath, "utf8"), continuation);
        assert.deepEqual(outgoingUploads(), []);
        assert.ok(
          requests.every(
            (request) =>
              request.path !== "/v2/sessions/reconcile" &&
              !request.body.includes(leaked),
          ),
        );

        supportsReconciliation = true;
        requests.length = 0;
        await native({ action: "sync" });

        const recovered = new DatabaseSync(databasePath);
        try {
          assert.equal(
            recovered
              .prepare("select id,error from outbox where id=?")
              .get(requestId),
            undefined,
            "The old request must be acknowledged or safely replaced, not stranded with a changed-payload 409",
          );
          const adopted = recovered
            .prepare("select value from bindings where id=?")
            .get(accepted?.event.resource.resourceId ?? source.resourceId) as {
            value: string;
          };
          assert.ok(adopted);
          const binding = JSON.parse(adopted.value) as {
            base: Receipt["event"]["resource"];
            needsCopy?: boolean;
          };
          if (accepted && latest) {
            assert.equal(
              binding.base.revision,
              accepted.event.resource.revision,
            );
            assert.deepEqual(binding.base.files, accepted.event.resource.files);
            assert.notEqual(
              binding.base.revision,
              latest.event.resource.revision,
            );
          } else {
            assert.ok(binding.base.revision > 0);
            assert.equal(binding.base.resourceId, source.resourceId);
            assert.ok(!binding.base.title.includes(leaked));
            assert.notDeepEqual(binding.base.files, raw.files);
          }
          assert.notEqual(binding.needsCopy, true);
        } finally {
          recovered.close();
        }
        assert.equal(await readFile(nativePath, "utf8"), continuation);
        const reconciliation = requests.filter(
          (request) => request.path === "/v2/sessions/reconcile",
        );
        assert.equal(reconciliation.length, 1);
        assert.deepEqual(JSON.parse(reconciliation[0].body), {
          projectId,
          deviceId: device,
          id: requestId,
        });
        assert.ok(requests.every((request) => !request.body.includes(leaked)));
        if (wasAccepted) {
          assert.deepEqual(
            outgoingUploads(),
            [],
            "Reconciliation must not resend raw uploads or create a duplicate copy",
          );
        } else {
          const replacements = requests.filter(
            (request) =>
              request.method === "POST" && request.path === "/v2/sync/push",
          );
          assert.equal(replacements.length, 1);
          const replacement = JSON.parse(replacements[0].body) as Change;
          assert.notEqual(replacement.id, requestId);
          assert.equal(replacement.resource.resourceId, source.resourceId);
          assert.ok(!replacement.resource.title.includes(leaked));
          assert.notDeepEqual(replacement.resource.files, raw.files);
          const blob = await store.blobs.read(
            projectId,
            replacement.resource.files[0].hash,
          );
          assert.ok(!blob.toString().includes(leaked));
          assert.ok(blob.toString().includes("[REDACTED]"));
          assert.ok(
            requests.indexOf(reconciliation[0]) <
              requests.indexOf(replacements[0]),
          );

          const late = await fetch(bridgeOrigin + mutationPath, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${owner}`,
              "Content-Type": "application/json",
              "X-Orka-Governance": "1",
            },
            body: JSON.stringify(queued),
          });
          assert.equal(late.status, 409);
          assert.deepEqual(await late.json(), {
            error: "Session upload request was cancelled",
          });
        }
        const resources = await pool.query<{ id: string; revision: string }>(
          "select id,revision from orka.resources where project_id=$1 order by id",
          [projectId],
        );
        assert.equal(resources.rowCount, operation === "copy" ? 2 : 1);
        if (accepted && latest) {
          assert.equal(
            resources.rows.find(
              (resource) => resource.id === accepted.event.resource.resourceId,
            )?.revision,
            String(latest.event.resource.revision),
          );
        }
        assert.deepEqual(proxyErrors, []);
      } finally {
        if (signedIn)
          await native({ action: "sign-out" }).catch(() => undefined);
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
        await new Promise<void>((resolve) => bridge.close(() => resolve()));
        await store.close();
        if (projectId)
          await pool.query("delete from orka.projects where id=$1", [
            projectId,
          ]);
        await pool.end();
        await rm(home, { recursive: true, force: true });
      }
    },
  );
}
