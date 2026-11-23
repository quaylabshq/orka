import {
  ArrowDownAZIcon,
  CircleCheckIcon,
  ClockIcon,
  FolderIcon,
  UserRoundIcon,
} from "lucide-react";
import React from "react";
import type { ProjectResource as Resource, ResourceSource } from "../types.js";
import { SearchField } from "./search-field.js";
import { SegmentedControl } from "./segmented-control.js";
import { SourceLabel, sourceName } from "./source-label.js";
import { SortMenu } from "./sort-menu.js";
import type { IconGlyph } from "./icons.js";
import { memberLabel } from "./project-permissions.js";

export type IndexSort =
  "updated" | "title" | "author" | "status" | "repository";
export type IndexSortDirection = "asc" | "desc";
export type OwnershipFilter = "all" | "mine" | "shared";
export type SourceFilter = Resource["source"] | "all";
/** A category in the Filter menu of a Skills-style index. */
export type IndexFilterKey =
  | "statuses"
  | "people"
  | "agents"
  | "repositories"
  | "locations"
  | "forks"
  | "kinds";

/** Presentation-only view state for one collection; never touches stored data. */
export interface IndexFilters {
  query: string;
  source: SourceFilter;
  sort: IndexSort;
  repository?: string;
  ownership?: OwnershipFilter;
  /** Unset means the sort's natural order: newest first, or A to Z. */
  direction?: IndexSortDirection;
  /** Filter menu picks by category; an empty or missing list filters nothing. */
  picks?: Partial<Record<IndexFilterKey, string[]>>;
}

export const defaultIndexFilters: IndexFilters = {
  query: "",
  source: "all",
  sort: "updated",
  ownership: "all",
};

const sortOptions: Record<IndexSort, { label: string; icon: IconGlyph }> = {
  updated: { label: "Recently updated", icon: ClockIcon },
  title: { label: "Title", icon: ArrowDownAZIcon },
  author: { label: "Author", icon: UserRoundIcon },
  status: { label: "Status", icon: CircleCheckIcon },
  repository: { label: "Repository", icon: FolderIcon },
};
const skillOnlySorts: IndexSort[] = ["status", "repository"];

const nouns: Record<Resource["kind"], [string, string]> = {
  memory: ["memory", "memories"],
  skill: ["skill", "skills"],
  session: ["session", "sessions"],
  plan: ["plan", "plans"],
};
export const indexNoun = (kind: Resource["kind"], count: number) =>
  nouns[kind][count === 1 ? 0 : 1];
/** The lowercase plural used for labels such as "Search memories". */
export const collectionNoun = (kind: Resource["kind"]) => nouns[kind][1];

const sourceOrder: ResourceSource[] = ["claude", "codex", "pi", "shared"];

interface IndexContext {
  displayTitle: (resource: Resource) => string;
  user: string | null;
  memberName?: (id: string) => string;
}

/** Filters loaded titles, paths, and sources, then orders by the chosen sort. */
export function applyIndexFilters(
  resources: Resource[],
  filters: IndexFilters,
  {
    displayTitle,
    user,
    memberName = (id) => memberLabel(id, user),
  }: IndexContext,
): Resource[] {
  const query = filters.query.trim().toLocaleLowerCase();
  const matches = resources.filter((resource) => {
    if (resource.kind !== "skill") {
      if (filters.ownership === "mine" && resource.owner !== user) return false;
      if (filters.ownership === "shared" && resource.owner === user)
        return false;
    }
    if (
      filters.repository &&
      filters.repository !== "all" &&
      resource.sourceId !== filters.repository
    )
      return false;
    if (filters.source !== "all" && resource.source !== filters.source)
      return false;
    if (!query) return true;
    return [
      displayTitle(resource),
      resource.title,
      resource.logicalPath,
      sourceName(resource.source),
    ].some((text) => text.toLocaleLowerCase().includes(query));
  });
  const byUpdated = (a: Resource, b: Resource) =>
    Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  return [...matches].sort((a, b) => {
    if (filters.sort === "title")
      return (
        displayTitle(a).localeCompare(displayTitle(b), undefined, {
          sensitivity: "base",
        }) || byUpdated(a, b)
      );
    if (filters.sort === "author")
      return (
        memberName(
          a.kind === "session" || a.kind === "plan" ? a.owner : a.updatedBy,
        ).localeCompare(
          memberName(
            b.kind === "session" || b.kind === "plan" ? b.owner : b.updatedBy,
          ),
          undefined,
          {
            sensitivity: "base",
          },
        ) || byUpdated(a, b)
      );
    return byUpdated(a, b);
  });
}

export interface IndexToolbarProps {
  kind: Resource["kind"];
  /** Items shown after the current filters. */
  count: number;
  /** Sources present in the loaded collection. */
  sources: Resource["source"][];
  filters: IndexFilters;
  onChange: (filters: IndexFilters) => void;
}

/** The shared 32px toolbar above every index: search, source filter, count, sort. */
export function IndexToolbar({
  kind,
  count,
  sources,
  filters,
  onChange,
}: IndexToolbarProps) {
  const plural = collectionNoun(kind);
  const present = sourceOrder.filter(
    (source) => sources.includes(source) || filters.source === source,
  );
  const filtered = Boolean(
    filters.query.trim() ||
    (kind !== "skill" && filters.ownership && filters.ownership !== "all") ||
    filters.source !== "all" ||
    (filters.repository && filters.repository !== "all"),
  );
  return (
    <div className="index-toolbar" role="group" aria-label={`${plural} tools`}>
      <SearchField
        size="sm"
        value={filters.query}
        onValueChange={(query) => onChange({ ...filters, query })}
        placeholder={`Search ${plural}…`}
        aria-label={`Search ${plural}`}
      />
      {(present.length > 1 || filters.source !== "all") && (
        <SegmentedControl<SourceFilter>
          label="Filter by source"
          value={filters.source}
          options={[
            { value: "all", label: "All" },
            ...present.map((source) => ({
              value: source,
              label: <SourceLabel source={source} />,
            })),
          ]}
          onChange={(source) => onChange({ ...filters, source })}
        />
      )}
      <div className="index-toolbar-actions">
        {filtered && (
          <span className="index-toolbar-count" role="status">
            {count} {indexNoun(kind, count)}
          </span>
        )}
        <SortMenu
          options={(Object.keys(sortOptions) as IndexSort[])
            .filter(
              (sort) => kind === "skill" || !skillOnlySorts.includes(sort),
            )
            .map((sort) => ({ value: sort, ...sortOptions[sort] }))}
          value={filters.sort}
          onChange={(sort) => onChange({ ...filters, sort })}
        />
      </div>
    </div>
  );
}
