import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

/** Runs against disposable image-test accounts. */
export async function checkMcpImage(
  base: string,
  project: string,
  nativeToken: string,
  login: { email: () => Promise<string> } | { password: string },
) {
  const instance = await fetch(base + "/v2/instance");
  assert.equal(instance.status, 200);
  assert.equal(
    ((await instance.json()) as { pluginConnection?: number }).pluginConnection,
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
  const registration = await jsonPost("/register", {
    client_name: "Orka image acceptance",
    redirect_uris: ["https://client.example/callback"],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
  assert.equal(registration.status, 201);
  const { client_id } = (await registration.json()) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URL(base + "/authorize");
  authorize.search = new URLSearchParams({
    client_id,
    redirect_uri: "https://client.example/callback",
    response_type: "code",
    scope: "orka.read",
    resource: base + "/mcp",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "image-acceptance",
  }).toString();
  const consent = await fetch(authorize, { redirect: "manual" });
  assert.equal(consent.status, 200);
  const html = await consent.text(),
    transaction = html.match(
      /name="transaction" value="([A-Za-z0-9_-]+)"/,
    )?.[1];
  assert.ok(transaction);
  const cookie = consent.headers.get("set-cookie")!.split(";")[0];
  const submit = (fields: Record<string, string>) =>
    fetch(base + "/mcp/connect", {
      method: "POST",
      headers: { Origin: base, Cookie: cookie },
      body: new URLSearchParams({
        transaction,
        email: "owner@example.test",
        ...fields,
      }),
      redirect: "manual",
    });
  let credentials: Record<string, string>;
  if ("email" in login) {
    const sent = await submit({ action: "send-code" });
    assert.equal(sent.status, 200, await sent.text());
    const code = (await login.email()).match(/<h1>(\d+)<\/h1>/)?.[1];
    assert.ok(code);
    credentials = { code };
  } else {
    credentials = login;
  }
  const connected = await submit({ action: "connect", ...credentials });
  assert.equal(connected.status, 303, await connected.text());
  const callback = new URL(connected.headers.get("location")!);
  assert.equal(callback.searchParams.get("state"), "image-acceptance");
  const formPost = (path: string, fields: Record<string, string>) =>
    fetch(base + path, { method: "POST", body: new URLSearchParams(fields) });
  const exchanged = await formPost("/token", {
    client_id,
    grant_type: "authorization_code",
    code: callback.searchParams.get("code")!,
    code_verifier: verifier,
    redirect_uri: "https://client.example/callback",
    resource: base + "/mcp",
  });
  assert.equal(exchanged.status, 200, await exchanged.clone().text());
  const tokens = (await exchanged.json()) as {
    access_token: string;
    refresh_token: string;
  };
  assert.equal(
    (
      await fetch(base + "/v2/projects", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      })
    ).status,
    401,
  );
  const client = new Client({
    name: "Orka image acceptance",
    version: "0.1.0",
  });
  const refreshedClient = new Client({
    name: "Orka refreshed connection",
    version: "0.1.0",
  });
  const linkedClient = new Client({
    name: "Orka desktop connection",
    version: "0.1.0",
  });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
        requestInit: {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        },
      }),
    );
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = CallToolResultSchema.parse(
        await client.callTool({ name, arguments: args }),
      );
      assert.ok(!result.isError, JSON.stringify(result.content));
      return result.structuredContent!;
    };
    assert.equal((await client.listTools()).tools.length, 18);
    const cloudProfile = await call("get_profile");
    assert.equal(cloudProfile.desktopLinked, false);
    assert.equal(cloudProfile.connectionProof, undefined);

    const desktopConsent = await fetch(authorize, { redirect: "manual" });
    assert.equal(desktopConsent.status, 200);
    const desktopHtml = await desktopConsent.text();
    const desktopTransaction = desktopHtml.match(
      /name="transaction" value="([A-Za-z0-9_-]+)"/,
    )?.[1];
    assert.ok(desktopTransaction);
    const desktopCookie = desktopConsent.headers
      .get("set-cookie")!
      .split(";")[0];
    const desktopSubmit = (action: string) =>
      fetch(base + "/mcp/connect", {
        method: "POST",
        headers: { Origin: base, Cookie: desktopCookie },
        body: new URLSearchParams({ transaction: desktopTransaction, action }),
        redirect: "manual",
      });
    const desktopPage = await desktopSubmit("desktop");
    assert.equal(desktopPage.status, 200);
    const desktopLink = (await desktopPage.text())
      .match(/href="(orka:\/\/mcp\/authorize\?[^"]+)"/)?.[1]
      ?.replaceAll("&amp;", "&");
    assert.ok(desktopLink);
    const handoffToken = new URL(desktopLink).searchParams.get("handoff")!;
    const preview = await fetch(
      base + "/v2/plugin/connection?handoff=" + handoffToken,
      { headers: { Authorization: `Bearer ${nativeToken}` } },
    );
    assert.equal(preview.status, 200);
    const previewBody = (await preview.json()) as {
      accountId: string;
      scopes: string[];
    };
    assert.equal(previewBody.accountId, cloudProfile.id);
    assert.deepEqual(previewBody.scopes, ["orka.read"]);
    const generation = randomUUID();
    const approved = await jsonPost("/v2/plugin/connection", {
      handoff: handoffToken,
      deviceId: device,
      generation,
      action: "approve",
    });
    assert.equal(approved.status, 200, await approved.text());
    assert.deepEqual(await (await desktopSubmit("desktop-status")).json(), {
      status: "approved",
    });
    const completed = await desktopSubmit("complete");
    assert.equal(completed.status, 303);
    const linkedTokensResponse = await formPost("/token", {
      client_id,
      grant_type: "authorization_code",
      code: new URL(completed.headers.get("location")!).searchParams.get(
        "code",
      )!,
      code_verifier: verifier,
      redirect_uri: "https://client.example/callback",
      resource: base + "/mcp",
    });
    assert.equal(linkedTokensResponse.status, 200);
    const linkedTokens = (await linkedTokensResponse.json()) as {
      access_token: string;
    };
    await linkedClient.connect(
      new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
        requestInit: {
          headers: { Authorization: `Bearer ${linkedTokens.access_token}` },
        },
      }),
    );
    const linkedProfileResult = CallToolResultSchema.parse(
      await linkedClient.callTool({ name: "get_profile", arguments: {} }),
    );
    assert.ok(!linkedProfileResult.isError);
    const linkedProfile = linkedProfileResult.structuredContent!;
    assert.equal(linkedProfile.desktopLinked, true);
    assert.equal(linkedProfile.id, cloudProfile.id);
    const proofInput = {
      proof: linkedProfile.connectionProof,
      deviceId: device,
      generation,
    };
    const verified = await jsonPost("/v2/plugin/connection/verify", proofInput);
    assert.equal(verified.status, 200, await verified.clone().text());
    const verifiedBody = (await verified.json()) as {
      accountId: string;
      serviceOrigin: string;
      scopes: string[];
    };
    assert.equal(verifiedBody.accountId, cloudProfile.id);
    assert.equal(verifiedBody.serviceOrigin, base);
    assert.deepEqual(verifiedBody.scopes, ["orka.read"]);
    assert.equal(
      (
        await jsonPost("/v2/plugin/connection/verify", {
          ...proofInput,
          generation: randomUUID(),
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await formPost("/revoke", {
          client_id,
          token: linkedTokens.access_token,
        })
      ).status,
      200,
    );
    assert.equal(
      (await jsonPost("/v2/plugin/connection/verify", proofInput)).status,
      401,
    );
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
      currentContext: "Container acceptance with actual GoTrue sign-in.",
    });
    assert.equal(handoff.createdSharedResource, false);
    assert.ok(String(handoff.markdown).includes("Continue onboarding"));
    const refresh = await formPost("/token", {
      client_id,
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      resource: base + "/mcp",
    });
    assert.equal(refresh.status, 200);
    const rotated = (await refresh.json()) as {
      access_token: string;
      refresh_token: string;
    };
    await refreshedClient.connect(
      new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
        requestInit: {
          headers: { Authorization: `Bearer ${rotated.access_token}` },
        },
      }),
    );
    assert.ok(
      !CallToolResultSchema.parse(
        await refreshedClient.callTool({ name: "get_profile", arguments: {} }),
      ).isError,
    );
    assert.equal(
      (
        await formPost("/revoke", {
          client_id,
          token: rotated.refresh_token,
          token_type_hint: "refresh_token",
        })
      ).status,
      200,
    );
    await assert.rejects(
      refreshedClient.callTool({ name: "list_projects", arguments: {} }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === 401,
    );
  } finally {
    await client.close();
    await refreshedClient.close();
    await linkedClient.close();
  }
}
