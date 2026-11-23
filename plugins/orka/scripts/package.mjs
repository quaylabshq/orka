import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (
  args.length > 3 ||
  args.some((arg) => arg.startsWith("--") || /^https?:/i.test(arg))
)
  throw new Error(
    "Desktop only. Usage: node plugins/orka/scripts/package.mjs [output.zip] [orka-executable] [profile]",
  );
const output = resolve(args[0] ?? "artifacts/orka-plugin-0.3.2.zip");
if (!output.endsWith(".zip")) throw new Error("Output must end in .zip");
const appBinary =
  args[1] ?? "/Applications/Orka.app/Contents/MacOS/portable-workspace-mac";
if (!appBinary.startsWith("/") || /[\r\n\0]/.test(appBinary))
  throw new Error("Use an absolute path to the installed Orka executable");
const profile = args[2];
if (profile && !/^[a-z][a-z0-9-]{0,47}$/.test(profile))
  throw new Error("Use a valid Orka profile name");
const manifest = JSON.parse(await readFile(join(root, "plugin.json"), "utf8"));
if (manifest.extensions["com.openai"].interface.shortDescription.length > 30)
  throw new Error("Plugin subtitle exceeds 30 characters");
const directory = await mkdtemp(join(tmpdir(), "orka-plugin-package-"));
try {
  const staged = join(directory, "orka");
  await mkdir(staged);
  for (const name of ["README.md", "skills", "assets"])
    await cp(join(root, name), join(staged, name), {
      recursive: true,
      dereference: false,
    });
  await cp(join(root, "../../LICENSE"), join(staged, "LICENSE"));
  await cp(
    join(root, "../../licenses/Orka-MIT.txt"),
    join(staged, "Orka-MIT.txt"),
  );
  // Codex and Claude Code load this manifest. Pi registers the same bridge via `pi mcp add`.
  await writeFile(
    join(staged, ".mcp.json"),
    JSON.stringify(
      {
        mcpServers: {
          orka: {
            command: appBinary,
            args: ["--orka-plugin", ...(profile ? ["--profile", profile] : [])],
          },
        },
      },
      null,
      2,
    ) + "\n",
  );
  const hostManifest = {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    author: manifest.author,
    license: manifest.license,
    keywords: manifest.keywords,
  };
  await writeFile(
    join(staged, "package.json"),
    JSON.stringify(
      { ...hostManifest, private: true, pi: { skills: ["./skills"] } },
      null,
      2,
    ) + "\n",
  );
  await mkdir(join(staged, ".claude-plugin"));
  await writeFile(
    join(staged, ".claude-plugin", "plugin.json"),
    JSON.stringify(hostManifest, null, 2) + "\n",
  );
  await mkdir(join(staged, ".codex-plugin"));
  await writeFile(
    join(staged, ".codex-plugin", "plugin.json"),
    JSON.stringify(
      {
        ...hostManifest,
        skills: "./skills/",
        mcpServers: "./.mcp.json",
        interface: manifest.extensions["com.openai"].interface,
      },
      null,
      2,
    ) + "\n",
  );
  for (const skill of await readdir(join(staged, "skills"))) {
    const text = await readFile(
      join(staged, "skills", skill, "SKILL.md"),
      "utf8",
    );
    if (
      !text.startsWith(`---\nname: ${skill}\n`) ||
      !text.includes("\ndescription: ")
    )
      throw new Error(`Invalid skill: ${skill}`);
  }
  const archive = join(directory, "orka.zip");
  const packed = spawnSync("zip", ["-q", "-r", archive, "orka"], {
    cwd: directory,
    encoding: "utf8",
  });
  if (packed.status !== 0)
    throw new Error(packed.stderr || "ZIP creation failed");
  const inventory = spawnSync("unzip", ["-Z1", archive], { encoding: "utf8" });
  if (
    inventory.status !== 0 ||
    inventory.stdout
      .split("\n")
      .some(
        (p) =>
          p.includes("..") ||
          p.includes("node_modules") ||
          p.includes(".app.json") ||
          p.includes(".env") ||
          p.includes(".DS_Store"),
      )
  )
    throw new Error("Archive inventory validation failed");
  await mkdir(dirname(output), { recursive: true });
  await cp(archive, output);
  await writeFile(
    output + ".verification.json",
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        transport: "stdio",
        desktopRequired: true,
        desktopOwnsIdentity: true,
        executable: appBinary,
        profile: profile ?? "default",
        authenticatedNativeWorkflowVerified: false,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `Created ${output}. One desktop bridge; authenticated native acceptance is a separate check.`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
