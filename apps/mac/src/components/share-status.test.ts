import { describe, expect, it } from "vitest";
import { shareStatus, type ShareFacts } from "./share-status.js";

const local = {
  local: true as const,
  localChanges: false,
  revision: 0,
  source: "codex" as const,
};
const facts = (overrides: Partial<ShareFacts> = {}): ShareFacts => ({
  phase: { step: "ready" },
  resource: local,
  stale: false,
  files: 1,
  online: true,
  ...overrides,
});
const pick = (overrides: Partial<ShareFacts>) => {
  const { pill, actionLabel, actionDisabled, heading, tone } = shareStatus(
    facts(overrides),
  );
  return { pill, actionLabel, actionDisabled, heading, tone };
};

describe("shareStatus before sending", () => {
  it("names where the item lives and what the button does", () => {
    expect(pick({})).toEqual({
      pill: "On your Mac",
      actionLabel: "Share with team",
      actionDisabled: false,
      heading: "Share with team",
      tone: "neutral",
    });
    expect(
      pick({
        resource: { localChanges: true, revision: 3, source: "codex" },
      }),
    ).toMatchObject({
      pill: "Updates shared copy",
      actionLabel: "Share update",
    });
    expect(pick({ access: "suggest" })).toMatchObject({
      pill: "Needs approval",
      actionLabel: "Send for approval",
    });
    expect(pick({ access: "read" })).toMatchObject({
      pill: "Owners only",
      actionDisabled: true,
    });
    expect(pick({ files: 0 })).toMatchObject({
      pill: "Nothing to share",
      actionDisabled: true,
    });
  });

  it("warns that a Pi session sends every branch, without hiding approval", () => {
    expect(
      pick({ resource: { ...local, source: "pi" }, access: "suggest" }),
    ).toMatchObject({
      pill: "Includes all branches",
      tone: "warning",
      actionLabel: "Send for approval",
    });
  });

  it("lets failures and changed items outrank progress and permissions", () => {
    expect(
      pick({ phase: { step: "preparing" }, access: "read" }),
    ).toMatchObject({ pill: "Preparing preview", actionDisabled: true });
    expect(
      pick({ phase: { step: "preview-failed", error: "x" }, files: 0 }),
    ).toMatchObject({ pill: "Preview failed", actionLabel: "Try again" });
    expect(
      pick({ phase: { step: "preview-failed", error: "x" }, stale: true }),
    ).toMatchObject({ pill: "Item changed", actionLabel: "Close" });
  });
});

describe("shareStatus while and after sending", () => {
  it("counts files while sending and keeps the button busy", () => {
    expect(
      pick({
        phase: {
          step: "sending",
          progress: { label: "Sending", completed: 2, total: 3 },
        },
      }),
    ).toMatchObject({
      pill: "Sending 2 of 3",
      actionLabel: "Sharing…",
      actionDisabled: true,
      tone: "info",
    });
    expect(pick({ phase: { step: "sending", progress: null } }).pill).toBe(
      "Sending",
    );
  });

  it("keeps results in the dialog with their own heading", () => {
    expect(pick({ phase: { step: "approval" } })).toMatchObject({
      heading: "Sent for approval",
      pill: "Awaiting approval",
      actionLabel: "Done",
    });
    expect(pick({ phase: { step: "conflict" } })).toMatchObject({
      heading: "Someone changed it first",
      pill: "Version conflict",
      tone: "warning",
      actionLabel: "Review changes",
    });
    expect(
      pick({ phase: { step: "share-failed", error: "x" }, stale: true }),
    ).toMatchObject({
      heading: "Couldn’t share",
      tone: "danger",
      actionLabel: "Try again",
    });
  });

  it("tells a queued share apart from one the service cannot take yet", () => {
    expect(
      pick({ phase: { step: "queued", unsupported: false }, online: false })
        .pill,
    ).toBe("Sends when online");
    expect(pick({ phase: { step: "queued", unsupported: false } }).pill).toBe(
      "Queued to send",
    );
    expect(
      pick({ phase: { step: "queued", unsupported: true } }),
    ).toMatchObject({ pill: "Not supported yet", tone: "warning" });
  });

  it("keeps every pill to three words or fewer", () => {
    const phases: ShareFacts["phase"][] = [
      { step: "preparing" },
      { step: "preview-failed", error: "x" },
      { step: "ready" },
      { step: "sending", progress: null },
      { step: "share-failed", error: "x" },
      { step: "approval" },
      { step: "conflict" },
      { step: "queued", unsupported: true },
      { step: "queued", unsupported: false },
    ];
    for (const phase of phases)
      for (const extra of [
        {},
        { stale: true },
        { files: 0 },
        { access: "read" as const },
        { access: "suggest" as const },
        { online: false },
        { resource: { ...local, source: "pi" as const } },
      ])
        expect(
          shareStatus(facts({ phase, ...extra })).pill.split(" ").length,
        ).toBeLessThanOrEqual(3);
  });
});
