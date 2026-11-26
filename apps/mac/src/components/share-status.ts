import type { AccessMode } from "@portable/protocol";
import type { ProjectResource, SyncProgress } from "../types.js";

/** Where the share flow is. Exactly one phase holds at a time. */
export type SharePhase =
  | { step: "preparing" }
  | { step: "preview-failed"; error: string }
  | { step: "ready" }
  | { step: "sending"; progress: SyncProgress | null }
  | { step: "share-failed"; error: string }
  | { step: "approval" }
  | { step: "conflict"; requestId: string }
  | { step: "held" }
  | { step: "queued"; unsupported: boolean };

export type ShareTone = "neutral" | "info" | "warning" | "success" | "danger";
export type ShareIcon =
  | "laptop"
  | "loader"
  | "shield"
  | "refresh"
  | "lock"
  | "warning"
  | "file"
  | "clock"
  | "compare"
  | "cloud-off";
export type ShareAction =
  "share" | "close" | "retry" | "requests" | "compare" | "none";

export interface ShareStatus {
  heading: string;
  pill: string;
  tone: ShareTone;
  icon: ShareIcon;
  /** The footer's primary button. */
  action: ShareAction;
  actionLabel: string;
  actionDisabled: boolean;
  /** A second footer button, only where a result has a real second action. */
  secondary?: { action: ShareAction; label: string };
}

export interface ShareFacts {
  phase: SharePhase;
  source: ProjectResource["source"];
  update: boolean;
  /** The item or its account changed after the dialog opened. */
  stale: boolean;
  /** Files in the reviewed snapshot, once the preview exists. */
  files?: number;
  /** This member's access to the item's kind; undefined when unknown. */
  access?: AccessMode;
  online: boolean;
}

/** The label the confirm button carries before anything is sent. */
function shareLabel(facts: ShareFacts) {
  if (facts.access === "suggest") return "Send for approval";
  if (facts.update) return "Share update";
  return "Share with team";
}

const status = (
  heading: string,
  pill: string,
  tone: ShareTone,
  icon: ShareIcon,
  action: ShareAction,
  actionLabel: string,
  actionDisabled = false,
): ShareStatus => ({
  heading,
  pill,
  tone,
  icon,
  action,
  actionLabel,
  actionDisabled,
});

/**
 * One status for the Status row, its heading and its button. When several
 * conditions hold, the earliest check here wins: results and failures
 * outrank progress, and progress outranks what the review would do.
 */
export function shareStatus(facts: ShareFacts): ShareStatus {
  const { phase } = facts;
  const label = shareLabel(facts);
  switch (phase.step) {
    case "approval":
      return {
        ...status(
          "Sent for approval",
          "Awaiting approval",
          "neutral",
          "clock",
          "close",
          "Done",
        ),
        secondary: { action: "requests", label: "View request" },
      };
    case "conflict":
      return status(
        "Someone changed it first",
        "Version conflict",
        "warning",
        "compare",
        "compare",
        "Review changes",
      );
    case "held":
      return status(
        "Queued until project restore",
        "Project inactive",
        "warning",
        "clock",
        "close",
        "Done",
      );
    case "queued":
      return phase.unsupported
        ? status(
            "Waiting for Orka update",
            "Not supported yet",
            "warning",
            "warning",
            "close",
            "Done",
          )
        : status(
            "Queued to share",
            facts.online ? "Queued to send" : "Sends when online",
            "neutral",
            "cloud-off",
            "close",
            "Done",
          );
    case "share-failed":
      return status(
        "Couldn’t share",
        "Couldn’t share",
        "danger",
        "cloud-off",
        "retry",
        "Try again",
      );
    case "sending": {
      const { completed, total } = phase.progress ?? {};
      const count =
        total && completed !== undefined
          ? `Sending ${Math.min(total, Math.max(0, completed))} of ${total}`
          : "Sending";
      return status(
        "Share with team",
        count,
        "info",
        "loader",
        "none",
        "Sharing…",
        true,
      );
    }
  }
  if (facts.stale)
    return status(
      "Share with team",
      "Item changed",
      "warning",
      "refresh",
      "close",
      "Close",
    );
  if (phase.step === "preview-failed")
    return status(
      "Share with team",
      "Preview failed",
      "danger",
      "warning",
      "retry",
      "Try again",
    );
  if (phase.step === "preparing")
    return status(
      "Share with team",
      "Preparing preview",
      "info",
      "loader",
      "share",
      label,
      true,
    );
  if (facts.files === 0)
    return status(
      "Share with team",
      "Nothing to share",
      "neutral",
      "file",
      "share",
      label,
      true,
    );
  if (facts.access === "hidden" || facts.access === "read")
    return status(
      "Share with team",
      "Owners only",
      "neutral",
      "lock",
      "share",
      "Share with team",
      true,
    );
  if (facts.source === "pi")
    return status(
      "Share with team",
      "Includes all branches",
      "warning",
      "warning",
      "share",
      label,
    );
  if (facts.access === "suggest")
    return status(
      "Share with team",
      "Needs approval",
      "neutral",
      "shield",
      "share",
      label,
    );
  if (label === "Share update")
    return status(
      "Share with team",
      "Updates shared copy",
      "neutral",
      "refresh",
      "share",
      label,
    );
  return status(
    "Share with team",
    "On your Mac",
    "neutral",
    "laptop",
    "share",
    label,
  );
}
