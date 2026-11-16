import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

/** Runs against disposable image-test accounts. */
export async function checkMcpImage(
  base: string,
  project: string,
  nativeToken: string,
) {
  const instance = await fetch(base + "/v2/instance");
  assert.equal(instance.status, 200);
  assert.equal(
    ((await instance.json()) as { desktopConnector?: number }).desktopConnector,
    1,
  );
  const jsonPost = (path: string, body: unknown) =>
    fetch(base + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${nativeToken}`,
        "X-Orka-Governance": "1",
      },
      body: JSON.stringify(body),
    });
  const device = randomUUID();
  assert.equal(
    (
      await jsonPost("/v2/devices", {
        id: device,
        name: "Plugin image fixture",
      })
    ).status,
    200,
  );
  const publish = async (kind: "plan" | "session", content: string) => {
    const resourceId = randomUUID(),
      hash = createHash("sha256").update(content).digest("hex");
    assert.equal(
      (
        await fetch(`${base}/v2/blobs/${project}/${hash}`, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${nativeToken}`,
            "X-Orka-Governance": "1",
          },
          body: content,
        })
      ).status,
      200,
    );
    const response = await jsonPost("/v2/sync/push", {
      version: 2,
      id: randomUUID(),
      projectId: project,
      deviceId: device,
      baseRevision: 0,
      resource: {
        resourceId,
        kind,
        source: "claude",
        title: `Plugin image ${kind}`,
        logicalPath: `claude/${resourceId}.${kind === "plan" ? "md" : "jsonl"}`,
        deleted: false,
        files: [
          {
            path: kind === "plan" ? "content.md" : "session.jsonl",
            hash,
            size: Buffer.byteLength(content),
            executable: false,
          },
        ],
      },
    });
    assert.equal(response.status, 200, await response.text());
    return resourceId;
  };
  const planId = await publish(
    "plan",
    "Use the existing account and project permissions.",
  );
  const sessionId = await publish(
    "session",
    JSON.stringify({
      type: "user",
      message: { role: "user", content: "Continue onboarding in Claude Code." },
    }) + "\n",
  );

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await jsonPost("/v2/connector/tools", {
      name,
      arguments: args,
    });
    assert.equal(response.status, 200, await response.clone().text());
    const result = CallToolResultSchema.parse(await response.json());
    assert.ok(!result.isError);
    return result.structuredContent!;
  };
  const inventory = await fetch(base + "/v2/connector/tools", {
    headers: { Authorization: `Bearer ${nativeToken}` },
  });
  assert.equal(inventory.status, 200);
  const tools = (await inventory.json()) as {
    tools: { scope: string; securitySchemes?: unknown }[];
  };
  assert.equal(tools.tools.length, 18);
  assert.ok(tools.tools.every((t) => t.securitySchemes === undefined));
  const profile = await call("get_profile");
  assert.equal(
    profile.id,
    (
      JSON.parse(
        Buffer.from(nativeToken.split(".")[1], "base64url").toString(),
      ) as { sub: string }
    ).sub,
  );
  assert.equal(profile.serviceOrigin, base);
  assert.equal(profile.connectionProof, undefined);
  assert.ok(JSON.stringify(await call("list_projects")).includes(project));
  assert.ok(
    JSON.stringify(
      await call("get_project_context", { projectId: project }),
    ).includes(planId),
  );
  await call("list_team_members", { projectId: project });
  assert.ok(
    JSON.stringify(
      await call("list_sessions", { projectId: project }),
    ).includes(sessionId),
  );
  assert.ok(
    JSON.stringify(
      await call("fetch_resource", {
        projectId: project,
        resourceId: sessionId,
      }),
    ).includes("Continue onboarding"),
  );
  const handoff = await call("prepare_claude_handoff", {
    projectId: project,
    goal: "Continue onboarding",
    sessionIds: [sessionId],
    resourceIds: [planId],
    currentContext: "Container acceptance with actual GoTrue desktop sign-in.",
  });
  assert.equal(handoff.createdSharedResource, false);
  assert.ok(String(handoff.markdown).includes("Continue onboarding"));
  const write = {
    projectId: project,
    requestId: randomUUID(),
    title: "Desktop connector image memory",
    text: "Only the desktop account executes this operation.",
  };
  const created = await call("create_memory", write);
  assert.equal(created.status, "published");
  assert.deepEqual(await call("create_memory", write), created);
  assert.equal(
    (
      await jsonPost("/v2/connector/tools", {
        name: "get_profile",
        arguments: {},
        accountId: randomUUID(),
      })
    ).status,
    400,
  );
  for (const token of [
    randomBytes(32).toString("base64url"),
    "expired-session",
  ]) {
    assert.equal(
      (
        await fetch(base + "/v2/connector/tools", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name: "get_profile", arguments: {} }),
        })
      ).status,
      401,
    );
  }
  for (const path of [
    "/mcp",
    "/authorize",
    "/register",
    "/mcp/connect",
    "/token",
    "/revoke",
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-protected-resource/mcp",
    "/v2/plugin/connection",
    "/v2/plugin/connection/verify",
  ]) {
    const retired = await jsonPost(path, {});
    assert.equal(retired.status, 410, path);
    assert.equal(
      ((await retired.json()) as { error: string }).error,
      "desktop_required",
    );
  }
}
