// Pins a project source to the Git repository first connected to it, across
// Macs, against a service with the orka-api set-source-remote contract: the
// first pin wins and a different key is refused with 409.
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";

const binary =
  process.env.ORKA_TEST_NATIVE_BINARY ??
  resolve("apps/mac/src-tauri/target/debug/portable-workspace-mac");
const pins = new Map<string, string>();
let supported = true;
const pinCalls: string[] = [];
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(Buffer.from(c)));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v2/projects/capabilities")
      return res.end(JSON.stringify(supported ? { sourceRemoteKey: 1 } : {}));
    if (
      req.url === "/v2/projects/action" &&
      body.action === "set-source-remote"
    ) {
      pinCalls.push(body.sourceId);
      const current = pins.get(body.sourceId);
      if (current && current !== body.remoteKey) {
        res.statusCode = 409;
        return res.end(
          JSON.stringify({
            error:
              "This source is linked to a different Git repository. Choose that repository's checkout, or ask a project owner to reset the source.",
          }),
        );
      }
      pins.set(body.sourceId, body.remoteKey);
      return res.end(
        JSON.stringify({ sourceId: body.sourceId, remoteKey: body.remoteKey }),
      );
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
  const setup = (source: object) =>
    call({
      action: "setup",
      user,
      url: service,
      projectId,
      path: home,
      sources: [source],
    });
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
  return { home, call, setup, connect, source, close: () => child.stdin.end() };
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
  /different Git repository/.test(r.error ?? ""),
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
r = await c.connect(cWrong);
check(
  "C: a stale catalog still gets the server's refusal",
  /different Git repository/.test(r.error ?? ""),
  r,
);
check(
  "C: the refused folder is not left connected",
  !(await c.source()).path,
  (await c.source()).path,
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
  "A: a connected folder now pointing elsewhere needs reconnecting",
  (await a.source()).folderState === "reconnect",
  (await a.source()).folderState,
);
execFileSync("/usr/bin/git", ["-C", aApi, "remote", "remove", "origin"]);
check(
  "A: a removed remote is not treated as another repository",
  (await a.source()).folderState === "connected",
  (await a.source()).folderState,
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

for (const m of [a, b, c, d]) m.close();
server.close();
await rm(root, { recursive: true, force: true });
const failed = results.filter(([, ok]) => !ok);
for (const [label, , detail] of failed)
  console.error(`Failed: ${label} ${detail}`);
assert.equal(failed.length, 0);
console.log(
  `Passed native source pinning: ${results.length} cases across four Macs, including stale catalogs, repointed checkouts and older services.`,
);
