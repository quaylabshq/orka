import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { Store, HttpError } from "./bridge/store.js";
import { Blobs } from "./fixtures/blobs.js";
import { createApi } from "./bridge/main.js";
import { authSettings } from "./bridge/auth.js";
import { tokenHash } from "./bridge/mcp.js";

await test("desktop consent binds PKCE grants and expiring local proofs without changing cloud-only connections", async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const directory = await mkdtemp(join(tmpdir(), "orka-plugin-connection-"));
  const store = new Store(pool, new Blobs(directory));
  const owner = randomUUID(),
    other = randomUUID();
  const deviceId = randomUUID(),
    otherDevice = randomUUID();
  const generation = randomUUID();
  await store.device(owner, deviceId, "Approved Mac");
  await store.device(other, otherDevice, "Other Mac");
  let passwordGate: Promise<void> | undefined;
  let passwordStarted: (() => void) | undefined;
  const fakeAuth = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/token?grant_type=password") {
      passwordStarted?.();
      void Promise.resolve(passwordGate).then(() =>
        res.end(JSON.stringify({ access_token: `native-${other}` })),
      );
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise<void>((r) => fakeAuth.listen(0, "127.0.0.1", r));
  const authAddress = fakeAuth.address();
  assert.ok(authAddress && typeof authAddress !== "string");
  const reservation = createServer();
  await new Promise<void>((r) => reservation.listen(0, "127.0.0.1", r));
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((r) => reservation.close(() => r()));
  const origin = `http://127.0.0.1:${address.port}`;
  const server = createApi(
    store,
    async (token) => {
      if (token === `native-${owner}`) return owner;
      if (token === `native-${other}`) return other;
      throw new HttpError(401, "Invalid native credentials");
    },
    `http://127.0.0.1:${authAddress.port}`,
    authSettings({ PUBLIC_URL: origin }),
    true,
  );
  await new Promise<void>((r) => server.listen(address.port, "127.0.0.1", r));
  const verifier = "a".repeat(43);
  const challenge = Buffer.from(tokenHash(verifier), "hex").toString(
    "base64url",
  );
  const native = (path: string, account: string, body?: object) =>
    fetch(origin + path, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer native-${account}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  const profile = async (token: string) => {
    const response = await fetch(origin + "/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_profile", arguments: {} },
      }),
    });
    assert.equal(response.status, 200);
    const result = (await response.json()) as {
      result: {
        isError?: boolean;
        structuredContent: {
          id: string;
          desktopLinked: boolean;
          connectionProof?: string;
          connectionProofExpiresAt?: string;
        };
      };
    };
    assert.notEqual(result.result.isError, true, JSON.stringify(result));
    return result.result.structuredContent;
  };
  try {
    const registration = await fetch(origin + "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Account-link fixture",
        redirect_uris: ["https://client.example/callback"],
        token_endpoint_auth_method: "none",
      }),
    });
    const client = (await registration.json()) as { client_id: string };
    const begin = async () => {
      const query = new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: "https://client.example/callback",
        response_type: "code",
        scope: "orka.read orka.write",
        resource: origin + "/mcp",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "preserved-state",
      });
      const response = await fetch(origin + "/authorize?" + query, {
        redirect: "manual",
      });
      const html = await response.text();
      assert.equal(response.status, 200, html);
      assert.ok(html.includes(">Use account in Orka</button>"));
      const transaction = html.match(
        /name="transaction" value="([A-Za-z0-9_-]+)"/,
      )?.[1];
      assert.ok(transaction);
      const cookie = response.headers.get("set-cookie")!.split(";")[0];
      const post = (
        action: string,
        fields: Record<string, string> = {},
        headers: Record<string, string> = {},
      ) =>
        fetch(origin + "/mcp/connect", {
          method: "POST",
          redirect: "manual",
          headers: { Origin: origin, Cookie: cookie, ...headers },
          body: new URLSearchParams({ transaction, action, ...fields }),
        });
      const desktop = async () => {
        const response = await post("desktop");
        const html = await response.text();
        assert.equal(response.status, 200, html);
        const link = html
          .match(/href="(orka:\/\/mcp\/authorize\?[^"]+)"/)?.[1]
          ?.replaceAll("&amp;", "&");
        assert.ok(link);
        const url = new URL(link);
        assert.equal(url.searchParams.get("service"), origin);
        return url.searchParams.get("handoff")!;
      };
      return { transaction, post, desktop };
    };
    const exchange = async (
      location: string,
      fields: Record<string, string> = {},
    ) => {
      const redirect = new URL(location);
      assert.equal(redirect.origin, "https://client.example");
      assert.equal(redirect.searchParams.get("state"), "preserved-state");
      assert.equal(redirect.searchParams.get("iss"), origin + "/");
      const response = await fetch(origin + "/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: client.client_id,
          code: redirect.searchParams.get("code")!,
          code_verifier: verifier,
          redirect_uri: "https://client.example/callback",
          resource: origin + "/mcp",
          ...fields,
        }),
      });
      return {
        response,
        tokens: (await response.json()) as {
          access_token: string;
          refresh_token: string;
        },
      };
    };
    const flow = await begin();
    assert.equal(
      (await flow.post("desktop", {}, { Origin: "https://evil.example" }))
        .status,
      403,
    );
    assert.equal((await flow.post("desktop", {}, { Cookie: "" })).status, 403);
    const handoff = await flow.desktop();
    assert.deepEqual(await (await flow.post("desktop-status")).json(), {
      status: "pending",
    });
    // A native review lasting more than 40 seconds must not spend the
    // credential/consent budget used by the final top-level completion.
    for (let poll = 0; poll < 45; poll++) {
      const response = await flow.post("desktop-status");
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("ratelimit-limit"), "120");
      assert.deepEqual(await response.json(), { status: "pending" });
    }
    assert.equal((await flow.post("complete")).status, 200);
    assert.equal(
      (
        await flow.post("connect", {
          email: "other@example.com",
          password: "synthetic",
        })
      ).status,
      409,
    );
    assert.equal(
      (await fetch(origin + "/v2/plugin/connection?handoff=" + handoff)).status,
      401,
    );
    const preview = await native(
      "/v2/plugin/connection?handoff=" + handoff,
      owner,
    );
    assert.equal(preview.status, 200);
    const details = (await preview.json()) as {
      client: { id: string; name: string };
      accountId: string;
      serviceOrigin: string;
      scopes: string[];
      permissionDescriptions: string[];
      expiresAt: string;
    };
    assert.deepEqual(details.client, {
      id: client.client_id,
      name: "Account-link fixture",
    });
    assert.equal(details.accountId, owner);
    assert.equal(details.serviceOrigin, origin);
    assert.deepEqual(details.scopes, ["orka.read", "orka.write"]);
    assert.ok(
      details.permissionDescriptions.some((p) => p.includes("local resource")),
    );
    assert.ok(Date.parse(details.expiresAt) > Date.now());
    const approval = { handoff, deviceId, generation, action: "approve" };
    assert.equal(
      (await native("/v2/plugin/connection", other, approval)).status,
      403,
    );
    assert.equal(
      (
        await native("/v2/plugin/connection", owner, {
          ...approval,
          deviceId: randomUUID(),
        })
      ).status,
      403,
    );
    assert.deepEqual(
      await (await native("/v2/plugin/connection", owner, approval)).json(),
      { approved: true },
    );
    assert.equal(
      (await native("/v2/plugin/connection", owner, approval)).status,
      409,
    );
    assert.deepEqual(await (await flow.post("desktop-status")).json(), {
      status: "approved",
    });
    assert.deepEqual(await (await flow.post("desktop-status")).json(), {
      status: "approved",
    });
    const completed = await flow.post("complete");
    assert.equal(completed.status, 303);
    assert.equal(completed.headers.get("ratelimit-limit"), "30");
    const location = completed.headers.get("location")!;
    assert.equal(
      (await exchange(location, { code_verifier: "b".repeat(43) })).response
        .status,
      400,
    );
    assert.equal(
      (await exchange(location, { resource: "https://evil.example/mcp" }))
        .response.status,
      400,
    );
    assert.equal(
      (
        await exchange(location, {
          redirect_uri: "https://evil.example/callback",
        })
      ).response.status,
      400,
    );
    const issued = await exchange(location);
    assert.equal(issued.response.status, 200);
    assert.equal((await exchange(location)).response.status, 400);
    assert.equal((await flow.post("complete")).status, 403);
    assert.deepEqual(await (await flow.post("desktop-status")).json(), {
      status: "expired",
    });
    assert.equal(
      (await native("/v2/plugin/connection", owner, approval)).status,
      404,
    );
    const connected = await profile(issued.tokens.access_token);
    assert.equal(
      connected.id,
      owner,
      "Desktop approval chooses the account, not browser credentials",
    );
    assert.equal(connected.desktopLinked, true);
    assert.ok(connected.connectionProof);
    assert.notEqual(connected.connectionProof, issued.tokens.access_token);
    assert.ok(Date.parse(connected.connectionProofExpiresAt!) > Date.now());
    const proofInput = {
      proof: connected.connectionProof,
      deviceId,
      generation,
    };
    const verified = await native(
      "/v2/plugin/connection/verify",
      owner,
      proofInput,
    );
    assert.equal(verified.status, 200);
    const grant = (await verified.json()) as {
      connectionId: string;
      accountId: string;
      serviceOrigin: string;
      deviceId: string;
      generation: string;
      scopes: string[];
      expiresAt: string;
    };
    assert.equal(grant.accountId, owner);
    assert.equal(grant.serviceOrigin, origin);
    assert.equal(grant.deviceId, deviceId);
    assert.equal(grant.generation, generation);
    assert.deepEqual(grant.scopes, ["orka.read", "orka.write"]);
    assert.ok(
      Date.parse(grant.expiresAt) <=
        Date.parse(connected.connectionProofExpiresAt!),
    );
    assert.equal(
      (await native("/v2/plugin/connection/verify", other, proofInput)).status,
      403,
    );
    assert.equal(
      (
        await native("/v2/plugin/connection/verify", owner, {
          ...proofInput,
          deviceId: otherDevice,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await native("/v2/plugin/connection/verify", owner, {
          ...proofInput,
          generation: randomUUID(),
        })
      ).status,
      409,
      "A→B→A must reconnect even when the account ID returns",
    );
    assert.equal(
      (
        await native("/v2/plugin/connection/verify", owner, {
          ...proofInput,
          proof: "x".repeat(43),
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(origin + "/v2/plugin/connection/verify", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${issued.tokens.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(proofInput),
        })
      ).status,
      401,
      "Remote access tokens cannot authenticate native proof validation",
    );
    await pool.query(
      "update orka.mcp_connection_proofs set expires_at=now()-interval '1 second' where hash=$1",
      [tokenHash(connected.connectionProof)],
    );
    assert.equal(
      (await native("/v2/plugin/connection/verify", owner, proofInput)).status,
      401,
    );
    const beforeRefresh = await profile(issued.tokens.access_token);
    const refreshed = await fetch(origin + "/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.client_id,
        refresh_token: issued.tokens.refresh_token,
        resource: origin + "/mcp",
        scope: "orka.read",
      }),
    });
    assert.equal(refreshed.status, 200);
    const rotated = (await refreshed.json()) as {
      access_token: string;
      refresh_token: string;
    };
    const escalation = await fetch(origin + "/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.client_id,
        refresh_token: rotated.refresh_token,
        resource: origin + "/mcp",
        scope: "orka.read orka.write",
      }),
    });
    assert.equal(
      escalation.status,
      400,
      "Linked grants cannot recover removed write scopes through refresh",
    );
    assert.equal(
      (
        await native("/v2/plugin/connection/verify", owner, {
          ...proofInput,
          proof: beforeRefresh.connectionProof,
        })
      ).status,
      401,
    );
    const afterRefresh = await profile(rotated.access_token);
    const reverified = await native("/v2/plugin/connection/verify", owner, {
      ...proofInput,
      proof: afterRefresh.connectionProof,
    });
    assert.equal(reverified.status, 200);
    const narrowedGrant = (await reverified.json()) as {
      connectionId: string;
      scopes: string[];
    };
    assert.equal(narrowedGrant.connectionId, grant.connectionId);
    assert.deepEqual(narrowedGrant.scopes, ["orka.read"]);
    const revoked = await fetch(origin + "/revoke", {
      method: "POST",
      body: new URLSearchParams({
        client_id: client.client_id,
        token: rotated.access_token,
      }),
    });
    assert.equal(revoked.status, 200);
    assert.equal(
      (
        await native("/v2/plugin/connection/verify", owner, {
          ...proofInput,
          proof: afterRefresh.connectionProof,
        })
      ).status,
      401,
    );

    const cloud = await begin();
    const cloudConsent = await cloud.post("connect", {
      email: "other@example.com",
      password: "synthetic",
    });
    assert.equal(cloudConsent.status, 303);
    const cloudTokens = await exchange(cloudConsent.headers.get("location")!);
    assert.equal(cloudTokens.response.status, 200);
    const cloudProfile = await profile(cloudTokens.tokens.access_token);
    assert.equal(cloudProfile.id, other);
    assert.equal(cloudProfile.desktopLinked, false);
    assert.equal(cloudProfile.connectionProof, undefined);

    let releasePassword!: () => void;
    passwordGate = new Promise<void>((resolve) => {
      releasePassword = resolve;
    });
    const passwordEntered = new Promise<void>((resolve) => {
      passwordStarted = resolve;
    });
    const raced = await begin();
    const signingIn = raced.post("connect", {
      email: "other@example.com",
      password: "synthetic",
    });
    await passwordEntered;
    const racedHandoff = await raced.desktop();
    releasePassword();
    assert.equal(
      (await signingIn).status,
      409,
      "In-flight browser sign-in cannot overwrite desktop approval",
    );
    passwordGate = undefined;
    passwordStarted = undefined;
    assert.equal(
      (
        await native("/v2/plugin/connection", owner, {
          ...approval,
          handoff: racedHandoff,
        })
      ).status,
      200,
    );
    const racedCompletion = await raced.post("complete");
    const racedGrant = await exchange(racedCompletion.headers.get("location")!);
    assert.equal((await profile(racedGrant.tokens.access_token)).id, owner);

    const cancelled = await begin();
    const cancelledHandoff = await cancelled.desktop();
    assert.deepEqual(
      await (
        await native("/v2/plugin/connection", owner, {
          ...approval,
          handoff: cancelledHandoff,
          action: "cancel",
        })
      ).json(),
      { cancelled: true },
    );
    assert.deepEqual(await (await cancelled.post("desktop-status")).json(), {
      status: "expired",
    });
    const cancelledComplete = await cancelled.post("complete");
    assert.equal(cancelledComplete.status, 303);
    assert.equal(
      new URL(cancelledComplete.headers.get("location")!).searchParams.get(
        "error",
      ),
      "access_denied",
    );
    const expired = await begin();
    const expiredHandoff = await expired.desktop();
    await pool.query(
      "update orka.mcp_pending set expires_at=now()-interval '1 second' where hash=$1",
      [tokenHash(expired.transaction)],
    );
    assert.deepEqual(await (await expired.post("desktop-status")).json(), {
      status: "expired",
    });
    assert.equal(
      (await native("/v2/plugin/connection?handoff=" + expiredHandoff, owner))
        .status,
      404,
    );
    assert.equal(
      (
        await native("/v2/plugin/connection", owner, {
          ...approval,
          handoff: expiredHandoff,
        })
      ).status,
      404,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => fakeAuth.close(() => r()));
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
});
