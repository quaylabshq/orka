import type { ReviewRequest } from "@portable/protocol";
import type { ProjectResource } from "../types.js";
import { permissionSections } from "./project-permissions.js";
import { displayText } from "./resource-presentation.js";
import type { AttentionItem } from "./sync-attention.js";

export type ReviewKind = ProjectResource["kind"] | "access";
export type ReviewTone = "neutral" | "info" | "warning" | "success" | "danger";
export type ReviewStatusId =
  | "awaiting"
  | "approved"
  | "rejected"
  | "stale"
  | "update"
  | "blocked"
  | "edits"
  | "unsent"
  | "removal";
export interface ReviewRowStatus {
  id: ReviewStatusId;
  label: string;
  tone: ReviewTone;
}

const shortDate = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});
const shortDateWithYear = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const plural = (count: number, unit: string) =>
  `${count} ${unit}${count === 1 ? "" : "s"} ago`;

/** "2 hours ago" for the last week, then a calendar date. */
export function relativeSent(value: string, now = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const seconds = Math.max(
    0,
    Math.round((now.getTime() - date.getTime()) / 1000),
  );
  if (seconds < 60) return "Just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return plural(hours, "hour");
  const days = Math.round(hours / 24);
  if (days < 7) return plural(days, "day");
  return (
    date.getFullYear() === now.getFullYear() ? shortDate : shortDateWithYear
  ).format(date);
}

const classKinds: Record<string, ProjectResource["kind"]> = {
  instructions: "memory",
  memory: "memory",
  skill: "skill",
  plan: "plan",
  session: "session",
};

/** What a request is for, which picks its leading icon. */
export function requestKind(
  request: Pick<ReviewRequest, "type" | "requestedClass">,
  resource?: Pick<ProjectResource, "kind">,
): ReviewKind | undefined {
  if (request.type === "access") return "access";
  return resource?.kind ?? classKinds[request.requestedClass ?? ""];
}

/** Access requests are named for what they open; an empty title never renders blank. */
export function requestTitle(
  request: Pick<ReviewRequest, "type" | "requestedClass" | "title">,
  resource?: Pick<ProjectResource, "title">,
) {
  if (request.type === "access") {
    const target =
      permissionSections.find((item) =>
        item.classes.some((category) => category === request.requestedClass),
      )?.label ?? displayText(resource?.title ?? "").trim();
    if (target) return `Access to ${target}`;
  }
  return displayText(request.title).trim() || "Untitled";
}

export const requestStatus = (
  status: ReviewRequest["status"],
): ReviewRowStatus =>
  status === "approved"
    ? { id: "approved", label: "Approved", tone: "success" }
    : status === "rejected"
      ? { id: "rejected", label: "Rejected", tone: "danger" }
      : status === "stale"
        ? { id: "stale", label: "Needs refresh", tone: "warning" }
        : { id: "awaiting", label: "Awaiting approval", tone: "warning" };

/** One status per local change; a shared update outranks the edits it would replace. */
export function localStatus(
  item: Pick<AttentionItem, "binding" | "draft">,
): ReviewRowStatus {
  const { binding, draft } = item;
  const edited = binding?.installationState === "locally_modified";
  const incoming = Boolean(
    binding &&
    (!edited ||
      binding.skillReviewFingerprint ||
      (binding.availableRevision !== undefined &&
        binding.availableRevision !== binding.base?.revision)),
  );
  if (incoming && (edited || draft))
    return { id: "blocked", label: "Update blocked", tone: "warning" };
  if (incoming)
    return { id: "update", label: "Update available", tone: "info" };
  if (draft?.status === "stale")
    return { id: "stale", label: "Needs refresh", tone: "warning" };
  return { id: "edits", label: "Local edits", tone: "neutral" };
}

export const unsentStatus: ReviewRowStatus = {
  id: "unsent",
  label: "Not sent",
  tone: "danger",
};
export const removalStatus: ReviewRowStatus = {
  id: "removal",
  label: "Removal",
  tone: "danger",
};

/** Future revisions are assigned from the project counter at publication. */
export function baseVersion(request: Pick<ReviewRequest, "baseRevision">) {
  const base = request.baseRevision;
  if (!base) return "New";
  return `Based on revision ${base}`;
}

/** Who sees the item once approved, without listing a whole project. */
export function audienceLabel(
  audience: readonly string[] | undefined,
  members: readonly { id: string }[],
  name: (id: string) => string,
) {
  if (!audience) return undefined;
  if (members.length > 0 && members.every(({ id }) => audience.includes(id)))
    return "Everyone";
  if (audience.length === 0) return "No one";
  if (audience.length <= 2) return audience.map(name).join(", ");
  return `${audience.length} people`;
}

const accessAsk: Record<string, string> = {
  read: "to view",
  suggest: "to suggest changes to",
  publish: "to edit",
};
const accessNow: Record<string, string> = {
  hidden: "Today they have no access.",
  read: "Today they can only view.",
  suggest: "Today they can suggest changes.",
  publish: "Today they can edit.",
};

/** The one sentence an owner reads before granting access. */
export function accessSentence({
  name,
  sent,
  target,
  requested,
  current,
}: {
  name: string;
  sent: string;
  target: string;
  requested?: string;
  current?: string;
}) {
  // "1 day ago" and "just now" read as they are; a date needs "on".
  const when = !sent
    ? ""
    : /ago$|^Just now$/.test(sent)
      ? ` ${sent.charAt(0).toLowerCase()}${sent.slice(1)}`
      : ` on ${sent}`;
  const ask = (requested && accessAsk[requested]) || "for access to";
  const now =
    current && current !== requested ? (accessNow[current] ?? "") : "";
  return `${name} asked${when} ${ask} ${target}.${now ? ` ${now}` : ""}`;
}
