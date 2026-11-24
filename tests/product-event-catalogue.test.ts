import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

await test("desktop event names match the native contract and each connector tool has an outcome", () => {
  const native = new URL("../apps/mac/src-tauri/src/", import.meta.url);
  const rows = readFileSync(new URL("product-events.txt", native), "utf8")
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split(/\s+/));
  const renderer = readFileSync(
    new URL("../apps/mac/src/components/product-event.ts", import.meta.url),
    "utf8",
  );
  assert.deepEqual(
    [...renderer.matchAll(/\| "([^"]+)"/g)].map((match) => match[1]),
    rows
      .filter(([origins]) => origins.split(",").includes("desktop"))
      .map(([, name]) => name),
  );
  const shared: { name: string }[] = JSON.parse(
    readFileSync(new URL("connector-tools.json", native), "utf8"),
  );
  const local = [
    "get_profile",
    "list_local_resources",
    "preview_share",
    "share_selected",
    "list_local_skills",
    "install_skill",
    "get_sync_status",
    "retry_sync",
    "repair_sync",
  ];
  const names = [
    ...new Set([...shared.map((tool) => tool.name), ...local]),
  ].sort();
  for (const event of ["connector_tool_completed", "connector_tool_failed"]) {
    const tools = rows
      .find((row) => row[1] === event)?.[2]
      .slice(5)
      .split(",")
      .sort();
    assert.deepEqual(tools, names);
  }
});
