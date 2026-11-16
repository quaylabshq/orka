import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

await test("plugin ZIP uses one desktop stdio bridge in both hosts with no remote auth", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orka-plugin-test-"));
  const script = resolve("plugins/orka/scripts/package.mjs");
  try {
    const output = join(directory, "orka.zip");
    await run(process.execPath, [script, output]);
    const entry = async (path: string) =>
      JSON.parse((await run("unzip", ["-p", output, `orka/${path}`])).stdout);
    const manifest = JSON.parse(
      await readFile("plugins/orka/plugin.json", "utf8"),
    );
    assert.deepEqual(await entry(".mcp.json"), {
      mcpServers: {
        orka: {
          command:
            "/Applications/Orka.app/Contents/MacOS/portable-workspace-mac",
          args: ["--orka-plugin"],
        },
      },
    });
    const codex = await entry(".codex-plugin/plugin.json");
    const claude = await entry(".claude-plugin/plugin.json");
    for (const host of [codex, claude]) {
      assert.equal(host.name, manifest.name);
      assert.equal(host.version, manifest.version);
      assert.equal(host.description, manifest.description);
    }
    assert.equal(codex.mcpServers, "./.mcp.json");
    assert.equal(codex.skills, "./skills/");
    assert.deepEqual(
      codex.interface,
      manifest.extensions["com.openai"].interface,
    );
    const inventory = (await run("unzip", ["-Z1", output])).stdout;
    assert.equal(inventory.match(/\/SKILL\.md$/gm)?.length, 5);
    assert.ok(!inventory.split("\n").includes("orka/plugin.json"));
    assert.ok(!inventory.split("\n").includes("orka/mcp.json"));
    assert.equal(
      (await run("unzip", ["-p", output, "orka/README.md"])).stdout,
      await readFile("plugins/orka/README.md", "utf8"),
    );
    const verification = JSON.parse(
      await readFile(output + ".verification.json", "utf8"),
    );
    assert.equal(verification.transport, "stdio");
    assert.equal(verification.desktopOwnsIdentity, true);
    assert.equal(verification.authenticatedNativeWorkflowVerified, false);
    const custom = join(directory, "custom.zip");
    await run(process.execPath, [
      script,
      custom,
      "/tmp/Orka Development.app/Contents/MacOS/orka-desktop",
      "demo-profile",
    ]);
    assert.deepEqual(
      JSON.parse((await run("unzip", ["-p", custom, "orka/.mcp.json"])).stdout)
        .mcpServers.orka,
      {
        command: "/tmp/Orka Development.app/Contents/MacOS/orka-desktop",
        args: ["--orka-plugin", "--profile", "demo-profile"],
      },
    );
    for (const args of [
      ["https://service.example/mcp", output],
      [output, "--remote-only"],
      [output, "relative-binary"],
      [output, "/tmp/Orka", "../other"],
      [output, "/tmp/Orka", "Upper_case"],
      [output, "/tmp/Orka\nother"],
    ])
      await assert.rejects(run(process.execPath, [script, ...args]));
    for (const name of ["orka-operate", "orka-share-selected"]) {
      const instructions = (
        await run("unzip", ["-p", output, `orka/skills/${name}/SKILL.md`])
      ).stdout;
      assert.match(instructions, /get_connection_status/);
      assert.doesNotMatch(
        instructions,
        /connectionProof|desktopLinked|Use account in Orka|remote `get_profile`/,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
