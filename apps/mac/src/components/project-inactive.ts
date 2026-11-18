import type { Project } from "../types.js";

export type InactiveReason = "archived" | "deleted" | "purged" | "removed";

/** Why a project stopped syncing, or null when it is active. */
export function inactiveReason(project: Project): InactiveReason | null {
  if (project.purged) return "purged";
  if (project.revoked || project.detachedAt) return "removed";
  if (project.deletedAt) return "deleted";
  if (project.archivedAt) return "archived";
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

/** Local removal clears the reading cache and queue, while retaining drafts. */
export function removalWarning(): string {
  return "Export first to keep pending changes and private content. Removing this project clears its cached files and pending changes on this Mac. Saved local drafts and your project folders stay on disk.";
}
