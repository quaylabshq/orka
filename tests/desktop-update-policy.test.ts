import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

void test("desktop publisher promotes, renews and permanently withdraws signed releases", () => {
  const directory = mkdtempSync(join(tmpdir(), "orka-update-publisher-"));
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const env = {
      ...process.env,
      ORKA_UPDATE_SIGNING_KEY: privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
      ORKA_UPDATE_PUBLIC_KEY: Buffer.from(
        publicKey.export({ format: "jwk" }).x!,
        "base64url",
      ).toString("base64"),
    };
    const previous = join(directory, "previous.json");
    const output = join(directory, "policy.json");
    const artifact = join(directory, "release.json");
    const approval = join(directory, "approval.json");
    writeFileSync(previous, "");
    const release = (version: string) =>
      writeFileSync(
        artifact,
        JSON.stringify({
          version,
          url: `https://example.test/${version}.zip`,
          notes: "Fixture",
          sha256: "a".repeat(64),
          size: 42,
          architectures: ["arm64", "x86_64"],
          dataEpoch: 1,
          minimumMacOS: "12.0.0",
        }),
      );
    const execute = (operation: string, withdraw = "") =>
      spawnSync(
        process.execPath,
        [
          "scripts/desktop-update-policy.mjs",
          operation,
          previous,
          output,
          artifact,
          approval,
        ],
        { env: { ...env, ORKA_WITHDRAW_VERSION: withdraw }, encoding: "utf8" },
      );
    const publish = (operation: string, withdraw?: string) => {
      const result = execute(operation, withdraw);
      assert.equal(result.status, 0, result.stderr);
      const envelope = readFileSync(output, "utf8");
      const { payload, signature } = JSON.parse(envelope);
      const bytes = Buffer.from(payload, "base64");
      assert(verify(null, bytes, publicKey, Buffer.from(signature, "base64")));
      writeFileSync(previous, envelope);
      return JSON.parse(bytes.toString());
    };
    const approve = (audience: "early" | "public") => {
      const staged = execute("stage");
      assert.equal(staged.status, 0, staged.stderr);
      const manifest = JSON.parse(readFileSync(output, "utf8"));
      const payload = JSON.parse(
        Buffer.from(manifest.payload, "base64").toString(),
      );
      assert.equal(payload.purpose, "orka-desktop-rollout");
      writeFileSync(approval, JSON.stringify({ audience, manifest }));
    };
    release("0.4.0");
    assert.notEqual(
      execute("promote").status,
      0,
      "missing approval fails closed",
    );
    approve("early");
    assert.notEqual(
      execute("promote").status,
      0,
      "testers-only approval cannot reach the public feed",
    );
    approve("public");
    const published = publish("promote");
    assert.equal(published.release.version, "0.4.0");
    assert.equal(published.release.notes, "Fixture");
    const publishedEnvelope = readFileSync(previous, "utf8");
    assert.equal(publish("promote").sequence, 1);
    assert.equal(readFileSync(output, "utf8"), publishedEnvelope);
    assert.notEqual(execute("stage").status, 0);

    const publicApproval = readFileSync(approval, "utf8");
    const changedApproval = JSON.parse(publicApproval);
    const changedPayload = JSON.parse(
      Buffer.from(changedApproval.manifest.payload, "base64").toString(),
    );
    changedPayload.release.notes = "Changed after publication";
    const changedBytes = Buffer.from(JSON.stringify(changedPayload));
    changedApproval.manifest = {
      payload: changedBytes.toString("base64"),
      signature: sign(null, changedBytes, privateKey).toString("base64"),
    };
    writeFileSync(approval, JSON.stringify(changedApproval));
    assert.notEqual(execute("promote").status, 0);
    writeFileSync(approval, publicApproval);
    assert.equal(publish("renew").sequence, 2);
    const withdrawn = publish("withdraw", "0.4.0");
    assert.deepEqual(withdrawn.withdrawn, ["0.4.0"]);
    assert.equal(withdrawn.release, null);
    assert.notEqual(execute("promote").status, 0);
    release("0.4.1");
    assert.notEqual(
      execute("promote").status,
      0,
      "approval for another version fails",
    );
    approve("public");
    const archive = JSON.parse(readFileSync(artifact, "utf8"));
    writeFileSync(
      artifact,
      JSON.stringify({ ...archive, sha256: "b".repeat(64) }),
    );
    assert.notEqual(
      execute("promote").status,
      0,
      "changed archives require fresh review",
    );
    writeFileSync(artifact, JSON.stringify({ ...archive, notes: "Ignored" }));
    const fixed = publish("promote");
    assert.equal(fixed.release.notes, "Fixture");
    assert.equal(fixed.release.version, "0.4.1");
    assert.deepEqual(fixed.withdrawn, ["0.4.0"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
