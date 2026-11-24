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
import {
  isSkillConflictMessage,
  type AttentionItem,
} from "./sync-attention.js";
import { isTerminalUploadError } from "./sync-issues.js";

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

/** The one pill an index row shows. */
export interface IndexStatus<Key extends string = string> {
  key: Key;
  label: string;
  tone: SkillStatusTone;
  icon: IconGlyph;
}

type SkillStatus = IndexStatus<SkillStatusKey>;

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

/** Sort rank: most urgent first, and rows with no status last. */
export const statusRank = (value: IndexStatus | null) =>
  value ? tones.indexOf(value.tone) : tones.length;

export interface SkillStatusInput {
  resource: ProjectResource;
  conflicted: boolean;
  /** This skill's entry in the project's attention list, when it has one. */
  attention?: AttentionItem;
  review: SkillReviewState;
}

const unreadable =
  /^(Cannot|Could not|Couldn’t|Couldn't) (read|scan)\b|^Cannot inspect skill folder$/i;

// Native records a bare OS error for files outside a skill package, and
// previously recorded skill scan failures may only have it too.
const legacyReadError =
  /^(?:IO error for operation on .+: )?(?:Operation not permitted|No such file or directory|Input\/output error|Permission denied|Not a directory|Is a directory) \(os error (?:1|2|5|13|20|21)\)$/;

/** Whether a scan error says the file or folder could not be read. */
export const isReadFailure = (error: string) =>
  unreadable.test(error) || legacyReadError.test(error);

function couldNotRead(
  resource: ProjectResource,
  { source, error }: AttentionItem["errors"][number],
) {
  return (
    unreadable.test(error) ||
    (source.endsWith(`:scan:skills/${resource.logicalPath}`) &&
      legacyReadError.test(error))
  );
}

/** Show the most urgent issue, then sharing and review progress. */
export function skillStatus({
  resource,
  conflicted,
  attention,
  review,
}: SkillStatusInput): SkillStatus | null {
  const pick = (key: SkillStatusKey) => byKey.get(key) ?? null;
  if (conflicted) return pick("conflict");

  const sharingBlocked = resource.local && resource.sharing === "blocked";
  const uploads = attention?.uploads ?? [];
  // Native marks a local share blocked from its terminal upload error.
  const blockedUpload =
    sharingBlocked &&
    uploads.length === 1 &&
    isTerminalUploadError(uploads[0].error);
  if (uploads.length && !blockedUpload) return pick("upload-failed");

  // Mirror and local-edit diagnostics already explain an update's blocked state.
  const errors = attention?.errors.filter(
    ({ error }) => !review.incomingBlocked || !isSkillConflictMessage(error),
  );
  if (errors?.length)
    return pick(
      errors.every((error) => couldNotRead(resource, error))
        ? "could-not-read"
        : "sync-issue",
    );

  if (resource.local) {
    if (sharingBlocked) return pick("sharing-blocked");
    if (resource.sharing === "approval") return pick("awaiting-approval");
    if (resource.sharing === "queued") return pick("sharing-queued");
    if (resource.sharing === "paused") return pick("sharing-paused");
    return null;
  }
  if (review.incomingBlocked) return pick("update-blocked");
  if (review.pending) return pick("awaiting-approval");
  if (review.incoming)
    return pick(
      review.binding?.installationState === "review_pending"
        ? "ready-to-install"
        : "update-available",
    );
  if (attention?.requests.some((request) => request.canReview))
    return pick("suggestion");
  return review.outgoing || resource.localChanges ? pick("local-edits") : null;
}
