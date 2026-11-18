import test from "node:test";
import assert from "node:assert/strict";
import {
  joinErrorMessage,
  parseProjectInvite,
  sameServiceUrl,
} from "../apps/mac/src/components/project-invite.js";

const token = "ab".repeat(24);

await test("project invites accept browser, desktop and legacy token formats", () => {
  assert.deepEqual(parseProjectInvite(` ${token} `), { token });
  assert.deepEqual(parseProjectInvite(`orka://join/${token}`), { token });
  for (const serviceUrl of [
    "https://api.tryorka.ai",
    "https://team.example:8443",
    "http://127.0.0.1:8080",
  ]) {
    assert.deepEqual(parseProjectInvite(`${serviceUrl}/join/${token}`), {
      token,
      serviceUrl,
    });
    assert.deepEqual(
      parseProjectInvite(
        `orka://join/${token}?server=${encodeURIComponent(serviceUrl)}`,
      ),
      { token, serviceUrl },
    );
  }
  assert.deepEqual(
    parseProjectInvite(`https://TEAM.example:443/join/${token}`),
    { token, serviceUrl: "https://team.example" },
  );
});

await test("invite parsing rejects ambiguous links, unsafe services and malformed tokens", () => {
  for (const input of [
    "",
    "bad-token",
    token.toUpperCase(),
    token + "a",
    `http://team.example/join/${token}`,
    `https://user:secret@team.example/join/${token}`,
    `https://team.example/nested/join/${token}`,
    `https://team.example/join/${token}?server=https://other.example`,
    `https://team.example/join/${token}#secret`,
    `orka://join/${token}/extra`,
    `orka://join/${token}?server=`,
    `orka://join/${token}?server=https://team.example&server=https://other.example`,
    `orka://join/${token}?profile=other`,
    `orka://join/${token}?server=${encodeURIComponent("https://team.example/path")}`,
    `orka://join/${token}?server=${encodeURIComponent("javascript:alert(1)")}`,
    `orka://join/${token}?server=${encodeURIComponent("https://user:secret@team.example")}`,
  ])
    assert.throws(() => parseProjectInvite(input), /valid Orka invite/);
});

await test("service comparisons normalize origins while retaining service boundaries", () => {
  assert.equal(
    sameServiceUrl("https://TEAM.example:443/", "https://team.example"),
    true,
  );
  for (const service of [
    "https://other.example",
    "http://team.example",
    "https://team.example/path",
    "https://team.example:8443",
    "not a URL",
  ])
    assert.equal(sameServiceUrl(service, "https://team.example"), false);
});

const expired =
  "This invite has expired. Ask the project owner for a new invite.";
const used =
  "This invite was already used or is no longer valid. Ask the project owner for a new invite.";
const expiredOrUsed =
  "This invite has expired or was already used. Ask the project owner for a new invite.";
const archived = "This project is archived, so its invites no longer work.";
const wrongAccount = (email: string) =>
  `This invite was sent to ${email}. Sign in with that email address to join.`;

await test("join errors drop the status prefix and say what to do next", () => {
  const cases: [string, string][] = [
    [
      "400: This invite has expired. Ask the project owner for a new invite.",
      expired,
    ],
    ["400: Invite expired or already used", expiredOrUsed],
    [
      "400: This invite was already used or is no longer valid. Ask the project owner for a new invite.",
      used,
    ],
    ["400: This project is archived, so its invites no longer work.", archived],
    [
      "403: This invite was sent to mira@example.com. Sign in with that verified email address to join.",
      wrongAccount("mira@example.com"),
    ],
    [
      "403: This invite was sent to first.last@team.example. Sign in with that verified email address to join.",
      wrongAccount("first.last@team.example"),
    ],
    [
      "409: Update Orka to join a project with resource permissions",
      "Update Orka to join a project with resource permissions",
    ],
    [
      "Cloud unavailable; local work stays queued",
      "Cloud unavailable; local work stays queued",
    ],
  ];
  for (const [error, expected] of cases)
    assert.equal(joinErrorMessage(error), expected);
  assert.equal(
    joinErrorMessage(new Error("400: Invite expired or already used")),
    expiredOrUsed,
  );
});

await test("join messages are the same when the dialog maps them again", () => {
  for (const message of [
    expired,
    used,
    expiredOrUsed,
    archived,
    wrongAccount("mira@example.com"),
    "Update Orka to join a project with resource permissions",
  ])
    assert.equal(joinErrorMessage(message), message);
});

await test("join errors with nothing to say fall back to one clear line", () => {
  for (const error of ["", "   ", "400: ", new Error(""), undefined, null])
    assert.equal(
      joinErrorMessage(error),
      "Couldn’t join this project. Try again.",
    );
});
