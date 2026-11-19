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

/** Use the same restore deadline format in the banner and sidebar badge. */
function restoreDeadline(project: Project): string | null {
  const value = project.purgeAfter;
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function changeCount(count = 0): number {
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
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
      return "This project is archived by its owner. Sync will resume when it’s restored.";
    case "deleted": {
      const deadline = restoreDeadline(project);
      const reason = "This project is deleted by its owner.";
      if (!deadline) return reason;
      const held = changeCount(project.heldChanges);
      const waiting =
        held > 0
          ? `${held} ${held === 1 ? "change is" : "changes are"} queued to sync if restored by ${deadline}.`
          : `Sync can resume if the project is restored by ${deadline}.`;
      return `${reason} Orka keeps capturing your changes on this Mac. ${waiting} Captured edits become local drafts if the project is purged.`;
    }
    case "purged":
      return "This project was permanently deleted. Its shared content is no longer available.";
    case "removed":
      return "Access to this project was removed.";
    default:
      return "";
  }
}

/** Local removal clears the reading cache and queue, while retaining drafts. */
export function removalWarning(project?: Project): string {
  const pending = changeCount(project?.pendingChanges);
  const included = pending
    ? `${pending} pending ${pending === 1 ? "change" : "changes"}`
    : "pending changes";
  const encrypted = changeCount(project?.pendingEnvPublications);
  const env = encrypted
    ? ` The export excludes ${encrypted} encrypted ENV ${encrypted === 1 ? "publication" : "publications"}.`
    : "";
  return `Export first to save captured project content.${env} Removing this project clears cached files and ${included} on this Mac. Saved local drafts and your project folders stay on disk.`;
}
