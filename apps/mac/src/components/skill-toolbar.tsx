import React, { useMemo } from "react";
import type { ProjectResource } from "../types.js";
import {
  ActiveFilters,
  FilterMenu,
  SortButton,
  type FilterCategory,
} from "./index-menus.js";
import {
  clearFilterPicks,
  collectionNoun,
  filterCategories,
  sortDirection,
  type IndexFilterKey,
  type IndexFilters,
  type IndexPage,
} from "./skill-index.js";
import { SearchField } from "./search-field.js";

/** The filter categories this collection can offer, with the current picks. */
export function useFilterCategories(
  page: IndexPage,
  resources: ProjectResource[],
  filters: IndexFilters,
  user: string | null,
  memberName: (id: string) => string,
): FilterCategory[] {
  return useMemo(
    () => filterCategories(page, resources, filters, { user, memberName }),
    [page, resources, filters, user, memberName],
  );
}

/** Search, Filter, Sort, then the trailing controls and whatever the page adds. */
export function SkillToolbar({
  page,
  showTools,
  categories,
  filters,
  onChange,
  trailing,
  actions,
}: {
  page: IndexPage;
  showTools: boolean;
  categories: FilterCategory[];
  filters: IndexFilters;
  onChange: (filters: IndexFilters) => void;
  /** Controls at the right end, such as refresh; they hide with the tools. */
  trailing?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const noun = collectionNoun(page.kind);
  const setPicks = (category: string, picks: string[]) =>
    onChange({
      ...filters,
      picks: { ...filters.picks, [category as IndexFilterKey]: picks },
    });
  const toggle = (category: string, value: string) => {
    const current = filters.picks?.[category as IndexFilterKey] ?? [];
    setPicks(
      category,
      current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value],
    );
  };
  const clear = () => onChange(clearFilterPicks(filters));
  const sort = page.sorts.some((option) => option.value === filters.sort)
    ? filters.sort
    : page.defaultSort;
  const end =
    showTools && trailing ? (
      <>
        {trailing}
        {actions}
      </>
    ) : (
      actions
    );
  return (
    <div className={showTools ? "skill-index-head" : undefined}>
      <div
        className={showTools ? "index-toolbar skill-toolbar" : undefined}
        role={showTools ? "group" : undefined}
        aria-label={showTools ? `${noun} tools` : undefined}
      >
        {showTools && (
          <>
            <SearchField
              size="sm"
              value={filters.query}
              onValueChange={(query) => onChange({ ...filters, query })}
              placeholder={`Search ${noun}…`}
              aria-label={`Search ${noun}`}
            />
            <FilterMenu
              categories={categories}
              onToggle={toggle}
              onClear={clear}
            />
            <SortButton
              value={sort}
              direction={sortDirection({ ...filters, sort })}
              options={page.sorts}
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
        {end && (
          <div
            className={
              showTools ? "index-toolbar-actions" : "resource-index-action"
            }
          >
            {end}
          </div>
        )}
      </div>
      {showTools && (
        <ActiveFilters
          categories={categories}
          onRemove={(category) => setPicks(category, [])}
          onClear={clear}
        />
      )}
    </div>
  );
}
