import { describe, expect, it } from "vitest";
import {
  accessSentence,
  audienceLabel,
  localStatus,
  relativeSent,
  requestKind,
  requestStatus,
  requestTitle,
  versionChange,
} from "./review-presentation.js";

const now = new Date("2026-11-20T10:30:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
const hour = 3_600_000;

describe("relativeSent", () => {
  it("counts in words for a week, then shows a date", () => {
    expect(relativeSent(ago(20_000), now)).toBe("Just now");
    expect(relativeSent(ago(60_000), now)).toBe("1 minute ago");
    expect(relativeSent(ago(2 * hour), now)).toBe("2 hours ago");
    expect(relativeSent(ago(25 * hour), now)).toBe("1 day ago");
    expect(relativeSent(ago(6 * 24 * hour), now)).toBe("6 days ago");
    expect(relativeSent(ago(8 * 24 * hour), now)).not.toContain("ago");
  });
  it("stays empty for a date it cannot read", () => {
    expect(relativeSent("", now)).toBe("");
  });
});

describe("requests", () => {
  it("names an access request for what it opens", () => {
    expect(
      requestTitle({
        type: "access",
        requestedClass: "session",
        title: "Sessions access request",
      }),
    ).toBe("Access to Sessions");
    expect(
      requestTitle(
        { type: "access", title: "Resource access request" },
        { title: "release-checklist" },
      ),
    ).toBe("Access to release-checklist");
  });
  it("never shows a blank title", () => {
    expect(requestTitle({ type: "change", title: "  " })).toBe("Untitled");
  });
  it("takes the kind from the shared item when the request has no class", () => {
    expect(requestKind({ type: "change" }, { kind: "plan" })).toBe("plan");
    expect(requestKind({ type: "change" })).toBeUndefined();
    expect(requestKind({ type: "access", requestedClass: "skill" })).toBe(
      "access",
    );
  });
  it("maps every decided status to an outcome", () => {
    expect(requestStatus("approved").label).toBe("Approved");
    expect(requestStatus("rejected").label).toBe("Rejected");
    expect(requestStatus("stale").label).toBe("Needs refresh");
    expect(requestStatus("pending").label).toBe("Awaiting approval");
  });
});

describe("localStatus", () => {
  const draft = (status: string) =>
    ({ status }) as Parameters<typeof localStatus>[0]["draft"];
  it("reads a waiting shared version as an update", () => {
    expect(
      localStatus({ binding: { installationState: "update_available" } }).id,
    ).toBe("update");
    expect(
      localStatus({ binding: { installationState: "review_pending" } }).id,
    ).toBe("update");
  });
  it("treats edits alone as local edits, and edits under a newer version as blocked", () => {
    expect(
      localStatus({ binding: { installationState: "locally_modified" } }).id,
    ).toBe("edits");
    expect(
      localStatus({
        binding: {
          installationState: "locally_modified",
          availableRevision: 3,
          base: { revision: 2 } as never,
        },
      }).id,
    ).toBe("blocked");
    expect(
      localStatus({
        binding: { installationState: "update_available" },
        draft: draft("local"),
      }).id,
    ).toBe("blocked");
  });
  it("separates a stale draft from a fresh one", () => {
    expect(localStatus({ draft: draft("stale") }).id).toBe("stale");
    expect(localStatus({ draft: draft("local") }).id).toBe("edits");
  });
});

describe("review details", () => {
  it("says what approving does to the shared version", () => {
    expect(versionChange({ baseRevision: 0 }, false)).toBe("New");
    expect(versionChange({ baseRevision: 2 }, false)).toBe("2 to 3");
    expect(versionChange({ baseRevision: 3 }, true)).toBe("3 to removed");
  });
  it("names the audience without listing a whole project", () => {
    const members = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const name = (id: string) => id.toUpperCase();
    expect(audienceLabel(undefined, members, name)).toBeUndefined();
    expect(audienceLabel(["a", "b", "c"], members, name)).toBe("Everyone");
    expect(audienceLabel(["a", "b"], members, name)).toBe("A, B");
    expect(audienceLabel(["a", "b", "x"], members, name)).toBe("3 people");
    expect(audienceLabel([], members, name)).toBe("No one");
  });
  it("writes the access request as one sentence", () => {
    expect(
      accessSentence({
        name: "Ana Souza",
        sent: "1 day ago",
        target: "Sessions",
        requested: "suggest",
        current: "read",
      }),
    ).toBe(
      "Ana Souza asked 1 day ago to suggest changes to Sessions. Today they can only view.",
    );
    expect(
      accessSentence({ name: "Ana Souza", sent: "Just now", target: "Skills" }),
    ).toBe("Ana Souza asked just now for access to Skills.");
  });
});
