import {
  ArrowDownToLineIcon,
  BanIcon,
  CircleAlertIcon,
  ClockIcon,
  CloudAlertIcon,
  FileWarningIcon,
  HourglassIcon,
  MessageSquareIcon,
  MonitorDownIcon,
  PauseIcon,
  PencilIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { ProjectResource } from "../types.js";
import type { IconGlyph } from "./icons.js";
import type { SkillReviewState } from "./skill-review-state.js";
import type { AttentionItem } from "./sync-attention.js";

/** Red: something failed. Amber: blocked or waiting. Blue: new from the team. */
export type SkillStatusTone = "red" | "amber" | "blue" | "neutral";

export type SkillStatusKey =
  | "conflict"
  | "upload-failed"
  | "could-not-read"
  | "sync-issue"
  | "sharing-blocked"
  | "update-blocked"
  | "awaiting-approval"
  | "update-available"
  | "ready-to-install"
  | "suggestion"
  | "sharing-queued"
  | "sharing-paused"
  | "local-edits";

export interface SkillStatus {
  key: SkillStatusKey;
  label: string;
  tone: SkillStatusTone;
  icon: IconGlyph;
}

const status = (
  key: SkillStatusKey,
  label: string,
  tone: SkillStatusTone,
  icon: IconGlyph,
): SkillStatus => ({ key, label, tone, icon });

/** Every status a skill row can show, in the order the Filter menu lists them. */
export const skillStatuses: SkillStatus[] = [
  status("conflict", "Conflict", "red", TriangleAlertIcon),
  status("upload-failed", "Upload failed", "red", CloudAlertIcon),
  status("could-not-read", "Could not read", "red", FileWarningIcon),
  status("sync-issue", "Sync issue", "red", CircleAlertIcon),
  status("sharing-blocked", "Sharing blocked", "amber", BanIcon),
  status("update-blocked", "Update blocked", "amber", BanIcon),
  status("awaiting-approval", "Awaiting approval", "amber", HourglassIcon),
  status("update-available", "Update available", "blue", MonitorDownIcon),
  status("ready-to-install", "Ready to install", "blue", ArrowDownToLineIcon),
  status("suggestion", "Suggestion", "blue", MessageSquareIcon),
  status("sharing-queued", "Sharing queued", "neutral", ClockIcon),
  status("sharing-paused", "Sharing paused", "neutral", PauseIcon),
  status("local-edits", "Local edits", "neutral", PencilIcon),
];

const byKey = new Map(skillStatuses.map((item) => [item.key, item]));
const tones: SkillStatusTone[] = ["red", "amber", "blue", "neutral"];

/** Sort rank: most urgent first, and skills with no status last. */
export const skillStatusRank = (value: SkillStatus | null) =>
  value ? tones.indexOf(value.tone) : tones.length;

export interface SkillStatusInput {
  resource: ProjectResource;
  conflicted: boolean;
  /** This skill's entry in the project's attention list, when it has one. */
  attention?: AttentionItem;
  review: SkillReviewState;
}

/** Native wording for a skill folder or file that could not be read. */
const unreadable = /^(Cannot|Could not|Couldn’t|Couldn't) (read|scan)\b/i;

/**
 * The one status a skill row shows. A skill can be in several states at once;
 * the most urgent wins, in the same order the sort uses.
 *
 * Sharing and review states come first because native reports some of them as
 * errors on the same skill too: a blocked update or a blocked share is that
 * state, not an unreadable file. A removed skill never reaches the index, so
 * a removal has no status here.
 */
export function skillStatus({
  resource,
  conflicted,
  attention,
  review,
}: SkillStatusInput): SkillStatus | null {
  const pick = (key: SkillStatusKey) => byKey.get(key) ?? null;
  const issue = () =>
    attention?.messages.length
      ? pick(
          attention.messages.every((message) => unreadable.test(message))
            ? "could-not-read"
            : "sync-issue",
        )
      : null;
  if (conflicted) return pick("conflict");
  if (resource.local) {
    if (resource.sharing === "blocked") return pick("sharing-blocked");
    if (resource.sharing === "approval") return pick("awaiting-approval");
    if (resource.sharing === "queued") return pick("sharing-queued");
    if (resource.sharing === "paused") return pick("sharing-paused");
    if (attention?.uploads.length) return pick("upload-failed");
    return issue();
  }
  if (review.incomingBlocked) return pick("update-blocked");
  if (attention?.uploads.length) return pick("upload-failed");
  if (review.pending) return pick("awaiting-approval");
  if (review.incoming)
    return pick(
      review.binding?.installationState === "review_pending"
        ? "ready-to-install"
        : "update-available",
    );
  if (attention?.requests.some((request) => request.canReview))
    return pick("suggestion");
  return (
    issue() ??
    (review.outgoing || resource.localChanges ? pick("local-edits") : null)
  );
}
