// Pins a project source to the Git repository first connected to it, across
// Macs, against a service with the orka-api set-source-remote contract: the
// first pin wins and the service returns the current key.
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";

const binary =
  process.env.ORKA_TEST_NATIVE_BINARY ??
  resolve("apps/mac/src-tauri/target/debug/portable-workspace-mac");
const pins = new Map<string, string>();
let supported = true;
let failNextPin = false;
let rejectNextPin = false;
let omitNextPin = false;
const catalogs = new Map<string, { id: string; name: string }>();
const pinCalls: string[] = [];
const pushed: string[] = [];
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(Buffer.from(c)));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    res.setHeader("Content-Type", "application/json");
    if (req.url?.split("?")[0] === "/v2/projects" && req.method === "GET") {
      const source = catalogs.get(req.headers.authorization?.slice(7) ?? "");
      const remoteKey =
        source && !omitNextPin ? pins.get(source.id) : undefined;
      omitNextPin = false;
      return res.end(
        JSON.stringify(
          source
            ? [
                {
                  id: projectId,
                  name: "Fixture",
                  role: "member",
                  sources: [{ ...source, remoteKey }],
                },
              ]
            : [],
        ),
      );
    }
    if (req.url === "/v2/sync/push") {
      pushed.push(body.id);
      return res.end(
        JSON.stringify({
          event: {
            resource: { ...body.resource, projectId, revision: 1, files: [] },
            conflicts: [],
          },
        }),
      );
    }
    if (req.url?.startsWith("/v2/sync/pull?"))
      return res.end(JSON.stringify({ cursor: 0, events: [] }));
    if (req.url === "/v2/devices" && req.method === "GET") return res.end("[]");
    if (req.url === "/v2/projects/capabilities")
      return res.end(JSON.stringify(supported ? { sourceRemoteKey: 1 } : {}));
    if (
      req.url === "/v2/projects/action" &&
      body.action === "set-source-remote"
    ) {
      pinCalls.push(body.sourceId);
      if (failNextPin) {
        failNextPin = false;
        res.statusCode = 503;
        return res.end(JSON.stringify({ error: "Temporarily unavailable" }));
      }
      if (rejectNextPin) {
        rejectNextPin = false;
        res.statusCode = 409;
        return res.end(
          JSON.stringify({
            error:
              "This Git repository does not match the source's GitHub link.",
          }),
        );
      }
      const remoteKey = pins.get(body.sourceId) ?? body.remoteKey;
      pins.set(body.sourceId, remoteKey);
      return res.end(JSON.stringify({ sourceId: body.sourceId, remoteKey }));
    }
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const service = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const root = await mkdtemp(join(tmpdir(), "orka-pin-probe-"));
const projectId = randomUUID(),
  api = randomUUID();

async function repo(path: string, remote?: string) {
  await mkdir(path, { recursive: true });
  execFileSync("/usr/bin/git", ["init", "-q", path]);
  if (remote)
    execFileSync("/usr/bin/git", [
      "-C",
      path,
      "remote",
      "add",
      "origin",
      remote,
    ]);
  return path;
}
function mac(name: string) {
  const home = join(root, name);
  const user = randomUUID();
  const child = spawn(binary, ["--orka-env-test"], {
    env: {
      ...process.env,
      ORKA_TEST_HOME: home,
      CODEX_HOME: join(home, ".codex"),
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
    },
    stdio: ["pipe", "pipe", "ignore"],
  });
  type Reply = {
    value?: {
      projects: {
        id: string;
        sources: {
          path?: string | null;
          remoteKey?: string;
          folderState?: string;
        }[];
      }[];
    };
    error?: string;
  };
  const pending: ((v: Reply) => void)[] = [];
  createInterface({ input: child.stdout }).on("line", (l) =>
    pending.shift()?.(JSON.parse(l)),
  );
  const call = (input: object) =>
    new Promise<Reply>((r) => {
      pending.push(r);
      child.stdin.write(JSON.stringify(input) + "\n");
    });
  const setup = (source: {
    id: string;
    name: string;
    path: string | null;
    remoteKey?: string;
    repository?: object;
  }) => {
    const { id, name, repository } = source;
    catalogs.set(user, { id, name, ...(repository ? { repository } : {}) });
    return call({
      action: "setup",
      user,
      url: service,
      projectId,
      path: home,
      sources: [source],
    });
  };
  const connect = (path: string, sourceId?: string) =>
    call({
      action: "connect-sources",
      projectId,
      paths: [path],
      ...(sourceId ? { sourceId } : {}),
    });
  const source = async () =>
    (await call({ action: "snapshot" })).value!.projects.find(
      (p) => p.id === projectId,
    )!.sources[0];
  const database = () =>
    new DatabaseSync(
      join(
        home,
        "orka",
        "services",
        createHash("sha256").update(service).digest("hex"),
        user,
        "sync.sqlite",
      ),
    );
  return {
    home,
    call,
    setup,
    connect,
    source,
    database,
    close: () => child.stdin.end(),
  };
}
const results: [string, boolean, string][] = [];
const check = (label: string, ok: boolean, detail: unknown) => {
  results.push([label, ok, JSON.stringify(detail)]);
};

// Mac A, first to connect: pins the source to team/api.
const a = mac("a");
await a.setup({ id: api, name: "api", path: null });
const aApi = await repo(
  join(a.home, "code", "api"),
  "git@github.com:team/api.git",
);
let r = await a.connect(aApi);
const key = pins.get(api);
check("A pins the source on first connect", !r.error && !!key, r);
check(
  "A keeps the pin locally",
  (await a.source()).remoteKey === key,
  (await a.source()).remoteKey,
);

// Mac B knows the pin from the catalog.
const b = mac("b");
await b.setup({ id: api, name: "api", path: null, remoteKey: key });
const bWrong = await repo(
  join(b.home, "code", "api"),
  "git@github.com:someone/other.git",
);
r = await b.connect(bWrong);
check(
  "B: same-named other repo is refused when matching by name",
  /different Git repository/.test(r.error ?? ""),
  r,
);
r = await b.connect(bWrong, api);
check(
  "B: other repo is refused when chosen for the source",
  /Reset Git repository/.test(r.error ?? ""),
  r,
);
const bPlain = join(b.home, "Downloads", "api");
await mkdir(bPlain, { recursive: true });
r = await b.connect(bPlain, api);
check(
  "B: non-Git folder is refused for a pinned source",
  /no Git remote/.test(r.error ?? ""),
  r,
);
const bRight = await repo(
  join(b.home, "work", "api"),
  "https://github.com/Team/API.git",
);
const before = pinCalls.length;
r = await b.connect(bRight, api);
check("B: the same repo over HTTPS in another case connects", !r.error, r);
check(
  "B: an already pinned source is not pinned again",
  pinCalls.length === before,
  pinCalls.length - before,
);

// Mac C has an old catalog without the pin, while the server already has one.
const c = mac("c");
await c.setup({ id: api, name: "api", path: null });
const cWrong = await repo(
  join(c.home, "code", "api"),
  "git@github.com:someone/other.git",
);
// The first response can itself be stale if a teammate pinned during it.
omitNextPin = true;
r = await c.connect(cWrong);
check(
  "C: a stale catalog still gets the server's refusal",
  /Reset Git repository/.test(r.error ?? ""),
  r,
);
check(
  "C: the refused folder is not left connected",
  !(await c.source()).path,
  (await c.source()).path,
);

r = await c.connect(await repo(join(c.home, "no-remote", "api")), api);
check(
  "C: a stale catalog cannot attach a checkout without a remote",
  /no Git remote/.test(r.error ?? "") && !(await c.source()).path,
  r,
);
const linkRace = mac("link-race");
const linkedId = randomUUID();
await linkRace.setup({ id: linkedId, name: "api", path: null });
const linkWrong = await repo(
  join(linkRace.home, "code", "api"),
  "https://github.com/other/api.git",
);
rejectNextPin = true;
r = await linkRace.connect(linkWrong, linkedId);
check(
  "A semantic GitHub-link refusal leaves the new checkout unattached",
  /does not match the source's GitHub link/.test(r.error ?? "") &&
    !(await linkRace.source()).path &&
    !pins.has(linkedId),
  r,
);

// Mac A later repoints its folder at another repository.
execFileSync("/usr/bin/git", [
  "-C",
  aApi,
  "remote",
  "set-url",
  "origin",
  "git@github.com:someone/other.git",
]);
check(
  "A: a connected folder now pointing elsewhere shows a repository conflict",
  (await a.source()).folderState === "repository-conflict",
  (await a.source()).folderState,
);
execFileSync("/usr/bin/git", ["-C", aApi, "remote", "remove", "origin"]);
check(
  "A: a removed remote is not treated as another repository",
  (await a.source()).folderState === "connected",
  (await a.source()).folderState,
);

// An established connection with no saved pin backfills on sync, including a
// failure on the first pass. The source is already saved before either attempt.
const saved = mac("saved");
const savedId = randomUUID();
const monorepo = await repo(
  join(saved.home, "code", "monorepo"),
  "git@github.com:team/monorepo.git",
);
const subfolder = join(monorepo, "packages", "app");
await mkdir(subfolder, { recursive: true });
await saved.setup({ id: savedId, name: "app", path: subfolder });
failNextPin = true;
r = await saved.call({ action: "sync" });
check(
  "Existing monorepo subfolder: failed backfill keeps the folder and no pin",
  !r.error &&
    !!(await saved.source()).path &&
    !pins.has(savedId) &&
    !failNextPin,
  r,
);
r = await saved.call({ action: "sync" });
check(
  "Existing monorepo subfolder: next sync retries the failed pin",
  !r.error &&
    !!pins.get(savedId) &&
    (await saved.source()).remoteKey === pins.get(savedId),
  r,
);

const conflict = mac("conflict");
const original = await repo(
  join(conflict.home, "code", "api"),
  "https://github.com/original/api.git",
);
await conflict.setup({ id: api, name: "api", path: original });
const conflictDb = conflict.database();
const heldRequest = randomUUID();
const healthyRequest = randomUUID();
const healthySource = randomUUID();
const pending = conflictDb.prepare("INSERT INTO outbox VALUES(?,?,?,?,NULL)");
for (const [requestId, sourceId] of [
  [heldRequest, api],
  [healthyRequest, healthySource],
]) {
  pending.run(
    requestId,
    projectId,
    "/v2/sync/push",
    JSON.stringify({
      id: requestId,
      projectId,
      resource: {
        resourceId: randomUUID(),
        sourceId,
        kind: "memory",
        logicalPath: "instructions/AGENTS.md",
      },
    }),
  );
}
r = await conflict.call({ action: "sync" });
const established = await conflict.source();
check(
  "Teammate pin does not disconnect an established same-name folder",
  !r.error &&
    !!established.path &&
    established.remoteKey === key &&
    established.folderState === "repository-conflict",
  established,
);

const remaining = conflictDb.prepare("SELECT id FROM outbox ORDER BY id").all();
check(
  "Only the conflicting source's upload remains queued",
  remaining.length === 1 &&
    remaining[0].id === heldRequest &&
    !pushed.includes(heldRequest) &&
    pushed.includes(healthyRequest),
  { remaining, pushed },
);
conflictDb.close();

const renamed = mac("renamed");
const renamedId = randomUUID();
const fork = await repo(
  join(renamed.home, "code", "api"),
  "https://github.com/fork/api.git",
);
await renamed.setup({
  id: renamedId,
  name: "api",
  path: null,
  repository: {
    cloneUrl: "https://github.com/team/renamed.git",
    previousCloneUrls: ["https://github.com/team/api.git"],
  },
});
r = await renamed.connect(fork, renamedId);
check(
  "Wrong checkout cannot poison a GitHub-linked source",
  !!r.error && !pins.has(renamedId) && !(await renamed.source()).path,
  r,
);
execFileSync("/usr/bin/git", [
  "-C",
  fork,
  "remote",
  "add",
  "upstream",
  "git@github.com:team/api.git",
]);
r = await renamed.connect(fork, renamedId);
const renamedKey = createHash("sha256")
  .update("orka-remote-v1:github.com/team/renamed")
  .digest("hex");
check(
  "Fork with its old upstream URL connects and pins the current GitHub link",
  !r.error &&
    pins.get(renamedId) === renamedKey &&
    (await renamed.source()).folderState === "connected",
  r,
);

// An older server: no pin calls, connecting works as before.
supported = false;
const d = mac("d");
const other = randomUUID();
await d.setup({ id: other, name: "web", path: null });
const dWeb = await repo(
  join(d.home, "code", "web"),
  "git@github.com:team/web.git",
);
const calls = pinCalls.length;
r = await d.connect(dWeb);
check(
  "D: older server connects without pinning",
  !r.error && pinCalls.length === calls,
  r,
);

for (const m of [a, b, c, d, saved, conflict, renamed, linkRace]) m.close();
server.close();
await rm(root, { recursive: true, force: true });
const failed = results.filter(([, ok]) => !ok);
for (const [label, , detail] of failed)
  console.error(`Failed: ${label} ${detail}`);
assert.equal(failed.length, 0);
console.log(
  `Passed native source pinning: ${results.length} checks, including saved folders, retries, forks, renamed repositories and older services.`,
);
