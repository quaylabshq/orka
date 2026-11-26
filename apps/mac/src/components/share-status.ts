import type { AccessMode } from "@portable/protocol";
import type { SyncProgress } from "../types.js";

export interface SharePreview {
  previewToken: string;
  title: string;
  kind: string;
  note: string;
  expiresAt?: number;
  files?: { path: string; size: number }[];
  totalBytes?: number;
}

/** Where the dialog is in one share attempt. Plain success closes the dialog. */
export type ShareStep =
  | { step: "preparing"; progress: SyncProgress | null }
  | { step: "preview-failed"; error: string }
  | { step: "review"; preview: SharePreview }
  | { step: "sending"; preview: SharePreview; progress: SyncProgress | null }
  | { step: "send-failed"; preview: SharePreview; error: string }
  | {
      step: "sent";
      preview: SharePreview;
      status: "approval_required" | "conflict" | "queued";
      error?: string | null;
    };

/** Facts about the item and account that hold for the whole dialog. */
export interface ShareFacts {
  stale: boolean;
  access: AccessMode;
  pi: boolean;
  update: boolean;
}

export type ShareTone = "neutral" | "blue" | "amber" | "green" | "red";
export type ShareIcon =
  | "lock"
  | "folder"
  | "refresh"
  | "warning"
  | "loader"
  | "file"
  | "clock"
  | "shield"
  | "laptop"
  | "compare"
  | "cloud-off";
export type ShareAction =
  "confirm" | "preview" | "resend" | "requests" | "compare" | "close";

interface StatusSpec {
  pill: string;
  tone: ShareTone;
  icon: ShareIcon;
  heading?: string;
  /** Footer buttons, primary last. */
  actions: ShareAction[];
}

/** Every status the Status row can show, in the handover's priority order. */
export const shareStatuses = {
  "account-changed": {
    pill: "Account changed",
    tone: "red",
    icon: "lock",
    actions: ["close"],
  },
  "repo-not-connected": {
    pill: "Repo not connected",
    tone: "amber",
    icon: "folder",
    actions: ["preview"],
  },
  "item-changed": {
    pill: "Item changed",
    tone: "amber",
    icon: "refresh",
    actions: ["preview"],
  },
  "preview-expired": {
    pill: "Preview expired",
    tone: "amber",
    icon: "warning",
    actions: ["preview"],
  },
  "preview-failed": {
    pill: "Preview failed",
    tone: "red",
    icon: "warning",
    actions: ["preview"],
  },
  preparing: {
    pill: "Preparing preview",
    tone: "blue",
    icon: "loader",
    actions: ["confirm"],
  },
  "nothing-to-share": {
    pill: "Nothing to share",
    tone: "neutral",
    icon: "file",
    actions: ["confirm"],
  },
  "owners-only": {
    pill: "Owners only",
    tone: "neutral",
    icon: "lock",
    actions: ["confirm"],
  },
  "all-branches": {
    pill: "Includes all branches",
    tone: "amber",
    icon: "warning",
    actions: ["confirm"],
  },
  "needs-approval": {
    pill: "Needs approval",
    tone: "neutral",
    icon: "shield",
    actions: ["confirm"],
  },
  update: {
    pill: "Updates shared copy",
    tone: "neutral",
    icon: "refresh",
    actions: ["confirm"],
  },
  local: {
    pill: "On your Mac",
    tone: "neutral",
    icon: "laptop",
    actions: ["confirm"],
  },
  sending: {
    pill: "Sending",
    tone: "blue",
    icon: "loader",
    actions: ["confirm"],
  },
  "awaiting-approval": {
    pill: "Awaiting approval",
    tone: "neutral",
    icon: "clock",
    heading: "Sent for approval",
    actions: ["requests", "close"],
  },
  conflict: {
    pill: "Version conflict",
    tone: "amber",
    icon: "compare",
    heading: "Someone changed it first",
    actions: ["compare"],
  },
  queued: {
    pill: "Sends when online",
    tone: "neutral",
    icon: "cloud-off",
    heading: "Share queued",
    actions: ["close"],
  },
  "not-supported": {
    pill: "Not supported yet",
    tone: "amber",
    icon: "warning",
    heading: "Share queued",
    actions: ["close"],
  },
  unreachable: {
    pill: "Can’t reach Orka",
    tone: "red",
    icon: "cloud-off",
    heading: "Couldn’t share",
    actions: ["resend"],
  },
  "share-failed": {
    pill: "Share failed",
    tone: "red",
    icon: "warning",
    heading: "Couldn’t share",
    actions: ["resend"],
  },
} satisfies Record<string, StatusSpec>;

export type ShareStatusKey = keyof typeof shareStatuses;

const rank: Record<AccessMode, number> = {
  hidden: 0,
  read: 1,
  suggest: 2,
  publish: 3,
};

/**
 * Native command errors are strings, so this is the one place that reads them.
 * Order matters: an expired preview also says "preview this item again".
 */
function classifyError(error: string): ShareStatusKey | null {
  if (/expired/i.test(error)) return "preview-expired";
  if (
    /source folder|repository's folder|folder temporarily unavailable/i.test(
      error,
    )
  )
    return "repo-not-connected";
  if (
    /no longer matches|changed while|repository changed|local source is unavailable/i.test(
      error,
    )
  )
    return "item-changed";
  if (
    /cloud unavailable|network|connection|reconnect|offline|timed out/i.test(
      error,
    )
  )
    return "unreachable";
  return null;
}

/** The one status the Status row shows for this step, highest priority first. */
export function shareStatus(
  state: ShareStep,
  facts: ShareFacts,
): ShareStatusKey {
  // After a send the item's revision moves on, so only a pending review can go stale.
  if (facts.stale && state.step !== "sending" && state.step !== "sent")
    return "account-changed";
  switch (state.step) {
    case "preparing":
      return "preparing";
    case "preview-failed": {
      const known = classifyError(state.error);
      return known && known !== "unreachable" ? known : "preview-failed";
    }
    case "sending":
      return "sending";
    case "send-failed":
      return classifyError(state.error) ?? "share-failed";
    case "sent":
      if (state.status === "approval_required") return "awaiting-approval";
      if (state.status === "conflict") return "conflict";
      return state.error && /pi sessions/i.test(state.error)
        ? "not-supported"
        : "queued";
    case "review":
      if (!state.preview.files?.length) return "nothing-to-share";
      if (rank[facts.access] < rank.suggest) return "owners-only";
      if (facts.pi) return "all-branches";
      if (facts.access === "suggest") return "needs-approval";
      return facts.update ? "update" : "local";
  }
}

/** The confirm label follows access, so a Pi warning never hides that approval is needed. */
export function confirmLabel(facts: ShareFacts) {
  if (facts.access === "suggest") return "Send for approval";
  return facts.update ? "Share update" : "Share with team";
}

/** "Sending 2 of 3" when the native command reports a total. */
export function sendingPill(progress: SyncProgress | null) {
  const total = progress?.total;
  if (!total || progress.completed === undefined) return "Sending";
  return `Sending ${Math.min(total, Math.max(0, progress.completed))} of ${total}`;
}

export function canConfirm(state: ShareStep, status: ShareStatusKey) {
  return (
    state.step === "review" &&
    status !== "nothing-to-share" &&
    status !== "owners-only" &&
    status !== "account-changed"
  );
}
