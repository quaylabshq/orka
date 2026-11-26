import { describe, expect, it } from "vitest";
import {
  canConfirm,
  confirmLabel,
  sendingPill,
  shareStatus,
  shareStatuses,
  type ShareFacts,
  type ShareStep,
} from "./share-status.js";

const preview = {
  previewToken: "token",
  title: "Shared API client",
  kind: "memory",
  note: "",
  files: [{ path: "content.md", size: 120 }],
};
const facts: ShareFacts = {
  stale: false,
  access: "publish",
  pi: false,
  update: false,
};
const review: ShareStep = { step: "review", preview };
const pill = (step: ShareStep, overrides: Partial<ShareFacts> = {}) =>
  shareStatuses[shareStatus(step, { ...facts, ...overrides })].pill;

describe("share status", () => {
  it("shows where a reviewed item will go before confirming", () => {
    expect(pill(review)).toBe("On your Mac");
    expect(pill(review, { update: true })).toBe("Updates shared copy");
    expect(pill(review, { access: "suggest" })).toBe("Needs approval");
    expect(pill(review, { access: "read" })).toBe("Owners only");
    expect(pill(review, { pi: true })).toBe("Includes all branches");
    expect(pill({ step: "review", preview: { ...preview, files: [] } })).toBe(
      "Nothing to share",
    );
    expect(pill({ step: "preparing", progress: null })).toBe(
      "Preparing preview",
    );
  });

  it("ranks blocking states above the share outcome", () => {
    expect(pill(review, { stale: true, access: "suggest" })).toBe(
      "Account changed",
    );
    expect(pill(review, { access: "read", pi: true })).toBe("Owners only");
    expect(pill(review, { access: "suggest", pi: true })).toBe(
      "Includes all branches",
    );
    expect(pill(review, { access: "suggest", update: true })).toBe(
      "Needs approval",
    );
  });

  it("names the confirm button after the outcome, not the warning", () => {
    expect(confirmLabel(facts)).toBe("Share with team");
    expect(confirmLabel({ ...facts, update: true })).toBe("Share update");
    expect(confirmLabel({ ...facts, access: "suggest", pi: true })).toBe(
      "Send for approval",
    );
  });

  it("only lets a reviewed, permitted item be confirmed", () => {
    const allowed = (step: ShareStep, extra: Partial<ShareFacts> = {}) =>
      canConfirm(step, shareStatus(step, { ...facts, ...extra }));
    expect(allowed(review)).toBe(true);
    expect(allowed(review, { access: "suggest" })).toBe(true);
    expect(allowed(review, { access: "read" })).toBe(false);
    expect(allowed(review, { stale: true })).toBe(false);
    expect(allowed({ step: "preparing", progress: null })).toBe(false);
  });

  it("turns preview errors into states with a next step", () => {
    const failed = (error: string) => pill({ step: "preview-failed", error });
    expect(failed("Share preview expired; preview this item again")).toBe(
      "Preview expired",
    );
    expect(failed("Connect this repository's folder on this Mac")).toBe(
      "Repo not connected",
    );
    expect(failed("Local resource no longer matches the selected item")).toBe(
      "Item changed",
    );
    expect(failed("Disk full")).toBe("Preview failed");
    expect(
      shareStatuses[
        shareStatus({ step: "preview-failed", error: "Disk full" }, facts)
      ].actions,
    ).toEqual(["preview"]);
  });

  it("keeps the result in the dialog after sending", () => {
    const sent = (
      status: "approval_required" | "conflict" | "queued",
      error?: string,
    ) =>
      shareStatuses[
        shareStatus({ step: "sent", preview, status, error }, facts)
      ];
    expect(sent("approval_required")).toMatchObject({
      pill: "Awaiting approval",
      heading: "Sent for approval",
      actions: ["requests", "close"],
    });
    expect(sent("conflict")).toMatchObject({
      pill: "Version conflict",
      actions: ["compare"],
    });
    expect(sent("queued").pill).toBe("Sends when online");
    expect(
      sent(
        "queued",
        "Update the Orka service to share Pi sessions. The selected snapshot is queued on this Mac.",
      ).pill,
    ).toBe("Not supported yet");
  });

  it("does not call a finished share stale once the item's revision moves on", () => {
    expect(
      pill(
        { step: "sent", preview, status: "approval_required" },
        { stale: true },
      ),
    ).toBe("Awaiting approval");
  });

  it("separates an unreachable service from other send failures", () => {
    const failed = (error: string) =>
      shareStatuses[
        shareStatus({ step: "send-failed", preview, error }, facts)
      ];
    expect(failed("Cloud unavailable; local work stays queued")).toMatchObject({
      pill: "Can’t reach Orka",
      heading: "Couldn’t share",
      actions: ["resend"],
    });
    expect(
      failed("Share preview expired; preview this item again"),
    ).toMatchObject({ pill: "Preview expired", actions: ["preview"] });
    expect(failed("Invalid selected share receipt").pill).toBe("Share failed");
  });

  it("counts sent files when the native command reports a total", () => {
    expect(sendingPill(null)).toBe("Sending");
    expect(sendingPill({ label: "x", completed: 2, total: 3 })).toBe(
      "Sending 2 of 3",
    );
    expect(sendingPill({ label: "x", completed: 9, total: 3 })).toBe(
      "Sending 3 of 3",
    );
  });
});
