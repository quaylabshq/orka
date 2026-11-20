import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const rolloutPurpose = "orka-desktop-rollout";
const rolloutPayloadLimit = 16_384;

const version = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const compare = (a, b) => {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
};
const key = createPrivateKey(process.env.ORKA_UPDATE_SIGNING_KEY ?? "");
const now = Math.floor(Date.now() / 1000);
assert.equal(key.asymmetricKeyType, "ed25519");
const publicKey = createPublicKey(key);
assert.equal(
  publicKey.export({ format: "jwk" }).x,
  Buffer.from(process.env.ORKA_UPDATE_PUBLIC_KEY ?? "", "base64").toString(
    "base64url",
  ),
);

function verifiedPayload(envelope) {
  const payload = Buffer.from(envelope.payload, "base64");
  assert(
    verify(null, payload, publicKey, Buffer.from(envelope.signature, "base64")),
    "The update signature is invalid",
  );
  return JSON.parse(payload);
}

function writeSigned(path, value, limit = Infinity) {
  const payload = Buffer.from(JSON.stringify(value));
  assert(payload.length <= limit, "The signed manifest is too large");
  writeFileSync(
    path,
    JSON.stringify({
      payload: payload.toString("base64"),
      signature: sign(null, payload, key).toString("base64"),
    }) + "\n",
  );
}

const [operation, priorFile, outputFile, releaseFile, approvalFile] =
  process.argv.slice(2);
const input = readFileSync(priorFile, "utf8");
let prior = {
  sequence: 0,
  withdrawn: [],
  minimumVersion: "0.0.0",
  release: null,
};
if (input.trim()) {
  prior = verifiedPayload(JSON.parse(input));
  assert.equal(prior.schema, 1);
}
const policy = {
  schema: 1,
  sequence: prior.sequence + 1,
  expires: now + 2 * 86400,
  release: prior.release,
  withdrawn: prior.withdrawn,
  minimumVersion: process.env.ORKA_MINIMUM_VERSION || prior.minimumVersion,
};
assert(
  version.test(policy.minimumVersion) &&
    compare(policy.minimumVersion, prior.minimumVersion) >= 0,
);
if (operation === "stage" || operation === "promote") {
  const candidate = JSON.parse(readFileSync(releaseFile, "utf8"));
  assert(version.test(candidate.version));
  const alreadyPublished =
    operation === "promote" && prior.release?.version === candidate.version;
  for (const old of [
    ...prior.withdrawn,
    alreadyPublished ? null : prior.release?.version,
  ].filter(Boolean)) {
    assert(
      compare(candidate.version, old) > 0,
      "Publish each release under a new, higher version",
    );
  }
  assert(compare(candidate.version, policy.minimumVersion) >= 0);
  assert(version.test(candidate.minimumMacOS));
  assert(/^[a-f0-9]{64}$/.test(candidate.sha256));
  assert(
    Number.isSafeInteger(candidate.size) &&
      candidate.size > 0 &&
      candidate.size <= 250_000_000,
  );
  assert(Number.isSafeInteger(candidate.dataEpoch) && candidate.dataEpoch > 0);
  assert.deepEqual(
    [...candidate.architectures].sort(),
    ["arm64", "x86_64"],
    "Public updates must be universal",
  );
  const url = new URL(candidate.url);
  assert(
    url.protocol === "https:" && !url.username && !url.password && !url.hash,
  );
  assert(
    typeof candidate.notes === "string" &&
      Buffer.byteLength(candidate.notes) <= 4000,
  );
  if (operation === "stage") {
    writeSigned(
      outputFile,
      { schema: 1, purpose: rolloutPurpose, release: candidate },
      rolloutPayloadLimit,
    );
    process.exit(0);
  }
  const approval = JSON.parse(readFileSync(approvalFile, "utf8"));
  assert.equal(
    approval.audience,
    "public",
    "Approve this release in the Dashboard first",
  );
  const approved = verifiedPayload(approval.manifest);
  assert.equal(approved.schema, 1);
  assert.equal(approved.purpose, rolloutPurpose);
  assert.deepEqual(
    { ...candidate, notes: approved.release.notes },
    approved.release,
    "The verified archive must match the Dashboard's public approval",
  );
  if (alreadyPublished) {
    assert.deepEqual(
      prior.release,
      approved.release,
      "The Dashboard's public approval must match the already published release",
    );
    if (
      policy.minimumVersion === prior.minimumVersion &&
      prior.expires > now + 86400
    ) {
      writeFileSync(outputFile, input);
      process.exit(0);
    }
  }
  policy.release = approved.release;
} else if (operation === "withdraw") {
  const withdrawn = process.env.ORKA_WITHDRAW_VERSION ?? "";
  assert(version.test(withdrawn));
  policy.withdrawn = [...new Set([...prior.withdrawn, withdrawn])].sort();
  if (policy.release?.version === withdrawn) policy.release = null;
} else {
  assert.equal(operation, "renew");
}
if (
  policy.release &&
  compare(policy.release.version, policy.minimumVersion) < 0
)
  policy.release = null;
writeSigned(outputFile, policy);
