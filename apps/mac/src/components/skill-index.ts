import type { ProjectResource } from "../types.js";
import type { IndexFilters, IndexSortDirection } from "./index-toolbar.js";
import { skillStatusRank, type SkillStatus } from "./skill-status.js";

/** The member a skill row credits: you for skills only on this Mac. */
export const skillSharedBy = (skill: ProjectResource, user: string | null) =>
  skill.local ? (user ?? skill.owner) : skill.owner;

/** Recently updated reads newest first; every other sort reads A to Z. */
export const sortDirection = (filters: IndexFilters): IndexSortDirection =>
  filters.direction ?? (filters.sort === "updated" ? "desc" : "asc");

export const skillFiltersActive = (filters: IndexFilters) =>
  Boolean(
    filters.statuses?.length ||
    filters.sharedBy?.length ||
    filters.repositories?.length ||
    filters.locations?.length,
  );

export const clearSkillFilters = (filters: IndexFilters): IndexFilters => ({
  ...filters,
  statuses: [],
  sharedBy: [],
  repositories: [],
  locations: [],
});

interface SkillIndexContext {
  displayTitle: (skill: ProjectResource) => string;
  user: string | null;
  memberName: (id: string) => string;
  statusOf: (skill: ProjectResource) => SkillStatus | null;
}

const compareText = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: "base" });

/** Search matches skill names only; filters narrow within each category. */
export function applySkillFilters(
  skills: ProjectResource[],
  filters: IndexFilters,
  { displayTitle, user, memberName, statusOf }: SkillIndexContext,
): ProjectResource[] {
  const query = filters.query.trim().toLocaleLowerCase();
  const includes = (list: string[] | undefined, value: string | undefined) =>
    !list?.length || (value !== undefined && list.includes(value));
  const matches = skills.filter(
    (skill) =>
      (!query ||
        [displayTitle(skill), skill.title].some((text) =>
          text.toLocaleLowerCase().includes(query),
        )) &&
      includes(filters.statuses, statusOf(skill)?.key) &&
      includes(filters.sharedBy, skillSharedBy(skill, user)) &&
      includes(filters.repositories, skill.sourceId ?? undefined) &&
      includes(filters.locations, skill.local ? "mac" : "shared"),
  );
  const byName = (a: ProjectResource, b: ProjectResource) =>
    compareText(displayTitle(a), displayTitle(b));
  const byUpdated = (a: ProjectResource, b: ProjectResource) =>
    Date.parse(a.updatedAt) - Date.parse(b.updatedAt);
  const primary = (a: ProjectResource, b: ProjectResource) => {
    switch (filters.sort) {
      case "status":
        return skillStatusRank(statusOf(a)) - skillStatusRank(statusOf(b));
      case "repository":
        return compareText(a.repositoryName ?? "", b.repositoryName ?? "");
      case "author":
        return compareText(
          memberName(skillSharedBy(a, user)),
          memberName(skillSharedBy(b, user)),
        );
      case "updated":
        return byUpdated(a, b);
      default:
        return byName(a, b);
    }
  };
  const flip = sortDirection(filters) === "desc" ? -1 : 1;
  // Ties always fall back to name A to Z, so same-name copies stay together.
  return [...matches].sort(
    (a, b) =>
      flip * primary(a, b) ||
      byName(a, b) ||
      compareText(a.repositoryName ?? "", b.repositoryName ?? "") ||
      a.resourceId.localeCompare(b.resourceId),
  );
}
