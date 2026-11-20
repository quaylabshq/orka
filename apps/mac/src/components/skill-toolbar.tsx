import {
  ArrowDownAZIcon,
  CircleCheckIcon,
  ClockIcon,
  FolderIcon,
  LaptopIcon,
  MapPinIcon,
  UserIcon,
  UsersIcon,
} from "lucide-react";
import React, { useMemo } from "react";
import type { ProjectResource } from "../types.js";
import {
  ActiveFilters,
  FilterMenu,
  SortButton,
  type FilterCategory,
  type SortOption,
} from "./index-menus.js";
import type { IndexFilters, IndexSort } from "./index-toolbar.js";
import { SearchField } from "./search-field.js";
import {
  clearSkillFilters,
  skillSharedBy,
  sortDirection,
} from "./skill-index.js";
import { skillStatuses } from "./skill-status.js";

type FilterKey = "statuses" | "sharedBy" | "repositories" | "locations";

const sorts: SortOption<IndexSort>[] = [
  {
    value: "title",
    label: "Name",
    icon: ArrowDownAZIcon,
    directions: ["A to Z", "Z to A"],
  },
  {
    value: "status",
    label: "Status",
    icon: CircleCheckIcon,
    directions: ["Most urgent first", "Least urgent first"],
  },
  {
    value: "repository",
    label: "Repository",
    icon: FolderIcon,
    directions: ["A to Z", "Z to A"],
  },
  {
    value: "author",
    label: "Shared by",
    icon: UserIcon,
    directions: ["A to Z", "Z to A"],
  },
  {
    value: "updated",
    label: "Recently updated",
    icon: ClockIcon,
    directions: ["Oldest first", "Newest first"],
  },
];

/** The filter categories this collection can offer, with the current picks. */
export function useSkillFilterCategories(
  skills: ProjectResource[],
  filters: IndexFilters,
  user: string | null,
  memberName: (id: string) => string,
): FilterCategory[] {
  return useMemo(() => {
    const people = [
      ...new Set(skills.map((skill) => skillSharedBy(skill, user))),
    ]
      .map((id) => ({ value: id, label: memberName(id), icon: UserIcon }))
      .sort(
        (a, b) =>
          Number(b.value === user) - Number(a.value === user) ||
          a.label.localeCompare(b.label),
      );
    const repositories = [
      ...new Map(
        skills
          .filter((skill) => skill.sourceId && skill.repositoryName)
          .map((skill) => [
            skill.sourceId as string,
            skill.repositoryName as string,
          ]),
      ),
    ]
      .map(([value, label]) => ({ value, label, icon: FolderIcon }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const categories: (FilterCategory & { show: boolean })[] = [
      {
        id: "statuses",
        label: "Status",
        icon: CircleCheckIcon,
        options: skillStatuses.map((status) => ({
          value: status.key,
          label: status.label,
          icon: status.icon,
          group:
            status.tone === "red" || status.tone === "amber"
              ? "attention"
              : status.tone,
        })),
        selected: filters.statuses ?? [],
        show: true,
      },
      {
        id: "sharedBy",
        label: "Shared by",
        icon: UserIcon,
        options: people,
        selected: filters.sharedBy ?? [],
        // A solo project has nobody else to filter by.
        show: people.length > 1,
      },
      {
        id: "repositories",
        label: "Repository",
        icon: FolderIcon,
        options: repositories,
        selected: filters.repositories ?? [],
        show: repositories.length > 1,
      },
      {
        id: "locations",
        label: "Location",
        icon: MapPinIcon,
        options: [
          { value: "mac", label: "On this Mac", icon: LaptopIcon },
          {
            value: "shared",
            label: "Shared with the project",
            icon: UsersIcon,
          },
        ],
        selected: filters.locations ?? [],
        show: true,
      },
    ];
    // A pick whose option is gone (a removed repository, a member who left)
    // is dropped, so it can never filter the list from out of sight.
    return categories
      .filter((category) => category.show)
      .map(({ id, label, icon, options, selected }) => ({
        id,
        label,
        icon,
        options,
        selected: selected.filter((value) =>
          options.some((option) => option.value === value),
        ),
      }));
  }, [skills, filters, user, memberName]);
}

/** The filters that can still apply: each category's surviving picks. */
export const effectiveSkillFilters = (
  filters: IndexFilters,
  categories: FilterCategory[],
): IndexFilters => {
  const picks = (id: FilterKey) =>
    categories.find((category) => category.id === id)?.selected ?? [];
  return {
    ...filters,
    statuses: picks("statuses"),
    sharedBy: picks("sharedBy"),
    repositories: picks("repositories"),
    locations: picks("locations") as IndexFilters["locations"],
  };
};

/** Search, Filter, Sort, then whatever the page adds on the right. */
export function SkillToolbar({
  showTools,
  categories,
  filters,
  onChange,
  actions,
}: {
  showTools: boolean;
  categories: FilterCategory[];
  filters: IndexFilters;
  onChange: (filters: IndexFilters) => void;
  actions?: React.ReactNode;
}) {
  const toggle = (category: string, value: string) => {
    const key = category as FilterKey;
    const current = (filters[key] ?? []) as string[];
    onChange({
      ...filters,
      [key]: current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value],
    });
  };
  const clear = () => onChange(clearSkillFilters(filters));
  const sort = sorts.some((option) => option.value === filters.sort)
    ? filters.sort
    : "title";
  return (
    <div className={showTools ? "skill-index-head" : undefined}>
      <div
        className={showTools ? "index-toolbar skill-toolbar" : undefined}
        role={showTools ? "group" : undefined}
        aria-label={showTools ? "skills tools" : undefined}
      >
        {showTools && (
          <>
            <SearchField
              size="sm"
              value={filters.query}
              onValueChange={(query) => onChange({ ...filters, query })}
              placeholder="Search skills…"
              aria-label="Search skills"
            />
            <FilterMenu
              categories={categories}
              onToggle={toggle}
              onClear={clear}
            />
            <SortButton
              value={sort}
              direction={sortDirection({ ...filters, sort })}
              options={sorts}
              onChange={(next, direction) =>
                onChange({
                  ...filters,
                  sort: next,
                  // A new sort starts in its natural order; picking the current
                  // one again keeps the direction it has.
                  direction:
                    next === sort
                      ? (direction ?? filters.direction)
                      : undefined,
                })
              }
            />
          </>
        )}
        {actions && (
          <div
            className={
              showTools ? "index-toolbar-actions" : "resource-index-action"
            }
          >
            {actions}
          </div>
        )}
      </div>
      {showTools && (
        <ActiveFilters
          categories={categories}
          onRemove={(category) => onChange({ ...filters, [category]: [] })}
          onClear={clear}
        />
      )}
    </div>
  );
}
