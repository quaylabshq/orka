// Grade the native backtest's synthetic output. Only --live contacts JEV.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const localJSON = async (file) =>
  JSON.parse(await readFile(new URL(file, import.meta.url), "utf8"));
const [resultPath, mode] = process.argv.slice(2);
assert.ok(
  resultPath && (!mode || mode === "--live"),
  "Use skills.mjs <native-result.json> [--live]",
);
const cases = await localJSON("skills.json");
const expected = await localJSON("expected.json");
const question = await localJSON("question.json");
const native = JSON.parse(await readFile(resultPath, "utf8"));
assert.deepEqual(
  native.map((r) => r.id),
  cases.map((r) => r.id),
);
const key =
  process.env.JEV_API_KEY?.trim() || process.env.TYPESAFE_API_KEY?.trim();
if (mode) assert.ok(key, "Live replay needs the JEV fixture credential");

async function veto(state) {
  const reply = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(5000),
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "jev-1.13.0",
      state,
      questions: { merge: question },
    }),
  });
  assert.ok(reply.ok);
  const body = await reply.json();
  const answer = body.answers?.merge;
  assert.equal(body.model, "jev-1.13.0");
  assert.deepEqual(Object.keys(body.answers), ["merge"]);
  assert.equal(answer.type, "choice");
  assert.ok(["allow", "hold"].includes(answer.choice));
  const p = answer.probabilities;
  assert.deepEqual(Object.keys(p).sort(), ["allow", "hold"]);
  for (const n of [p.allow, p.hold, answer.confidence]) {
    assert.ok(Number.isFinite(n) && n >= 0 && n <= 1);
  }
  assert.ok(Math.abs(p.allow + p.hold - 1) <= 0.01);
  assert.ok(p[answer.choice] >= Math.max(p.allow, p.hold) - 0.01);
  return (
    answer.choice === "allow" && p.allow >= 0.65 && p.allow - p.hold >= 0.15
  );
}

const counts = () => ({ correct: 0, wrong: 0, deferred: 0, failures: 0 });
const deterministic = counts(),
  withVeto = counts(),
  timings = [],
  controls = [],
  excluded = [],
  results = [];
for (const [i, row] of native.entries()) {
  const c = cases[i];
  assert.ok(
    ["excluded", "installed", "queued", "review"].includes(row.disposition),
  );
  if (!c.context.publish || !c.context.auto_share) {
    assert.equal(row.disposition, "excluded");
    controls.push(c.id);
    continue;
  }
  if (row.disposition === "excluded") {
    excluded.push(c.id);
    continue;
  }
  const accepted =
    row.disposition === "queued" || row.disposition === "installed";
  const quality = expected[c.id].includes(row.candidate) ? "correct" : "wrong";
  const local = accepted ? quality : "deferred";
  deterministic[local]++;
  let shadow = local;
  if (
    mode &&
    row.disposition === "review" &&
    typeof row.candidate === "string"
  ) {
    const start = performance.now();
    try {
      const allow = await veto({
        kind: c.kind,
        base: c.base,
        current: c.current,
        incoming: c.incoming,
        candidate: row.candidate,
      });
      if (allow) shadow = quality;
    } catch {
      shadow = "failures";
    }
    timings.push(Math.round(performance.now() - start));
  }
  withVeto[shadow]++;
  results.push({
    id: c.id,
    disposition: row.disposition,
    local,
    ...(mode && { shadow }),
  });
}
timings.sort((a, b) => a - b);
const percentile = (p) =>
  timings[Math.ceil((timings.length * p) / 100) - 1] ?? null;
console.log(
  JSON.stringify(
    {
      cases: results.length,
      excluded,
      controls,
      deterministic,
      ...(mode && {
        withVeto,
        providerCalls: timings.length,
        p50_ms: percentile(50),
        p95_ms: percentile(95),
      }),
      results,
    },
    null,
    2,
  ),
);
if (withVeto.failures) process.exitCode = 1;
