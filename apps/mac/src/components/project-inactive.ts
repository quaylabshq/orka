import type { Project } from "../types.js";

export type InactiveReason = "archived" | "deleted" | "purged" | "removed";

/** Why a project stopped syncing, or null when it is active. */
export function inactiveReason(project: Project): InactiveReason | null {
  if (project.deletedAt) return project.purged ? "purged" : "deleted";
  if (project.archivedAt) return "archived";
  if (project.revoked || project.detachedAt) return "removed";
  return null;
}

function restoreDeadline(project: Project): string | null {
  const value = project.purgeAfter;
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Sidebar badge: what happened, and the date a restore still works. */
export function inactiveBadge(project: Project): string | null {
  switch (inactiveReason(project)) {
    case "archived":
      return "Archived by owner";
    case "deleted": {
      const deadline = restoreDeadline(project);
      return deadline
        ? `Deleted by owner, restorable until ${deadline}`
        : "Deleted by owner";
    }
    case "purged":
      return "Deleted";
    case "removed":
      return "Access removed";
    default:
      return null;
  }
}

/** Banner sentence: the same reason, said once, without a badge. */
export function inactiveMessage(project: Project): string {
  switch (inactiveReason(project)) {
    case "archived":
      return "This project is archived by its owner, so sync is paused.";
    case "deleted": {
      const deadline = restoreDeadline(project);
      return deadline
        ? `This project is deleted by its owner, so sync is paused. It can be restored until ${deadline}.`
        : "This project is deleted by its owner, so sync is paused.";
    }
    case "purged":
      return "This project was deleted and its shared data purged, so sync is paused.";
    case "removed":
      return "Access to this project was removed, so sync is paused.";
    default:
      return "";
  }
}

/** Removal warning: a restore cannot recreate drafts kept only on this Mac. */
export function removalWarning(project: Project): string {
  const reason = inactiveReason(project);
  return reason === "archived" || reason === "deleted"
    ? "Removing it here deletes its cached files and local drafts on this Mac. A later restore won’t bring those drafts back."
    : "Removing it here deletes its cached files on this Mac. Your project folders stay on disk.";
}
