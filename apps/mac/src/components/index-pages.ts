import {
  ArrowDownAZIcon,
  CircleCheckIcon,
  ClockIcon,
  FileIcon,
  FileTextIcon,
  FolderIcon,
  GitForkIcon,
  LaptopIcon,
  MapPinIcon,
  SquareTerminalIcon,
  UserIcon,
  UsersIcon,
} from "lucide-react";
import type { ProjectResource, ResourceSource } from "../types.js";
import type { IconGlyph } from "./icons.js";
import type {
  FilterCategory,
  FilterOption,
  SortOption,
} from "./index-menus.js";
import {
  isInstructionFile,
  listStatusRank,
  listStatuses,
} from "./list-status.js";
import { skillStatuses, statusRank, type IndexStatus } from "./skill-status.js";
import { sourceName } from "./source-label.js";

export type IndexSort =
  "updated" | "title" | "author" | "status" | "repository";
export type IndexSortDirection = "asc" | "desc";
/** A category in an index's Filter menu. */
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
  sort: IndexSort;
  /** Unset means the sort's natural order: newest first, or A to Z. */
  direction?: IndexSortDirection;
  /** Filter menu picks by category; an empty or missing list filters nothing. */
  picks?: Partial<Record<IndexFilterKey, string[]>>;
}

export const defaultIndexFilters: IndexFilters = { query: "", sort: "updated" };

const nouns: Record<ProjectResource["kind"], string> = {
  memory: "memories",
  skill: "skills",
  session: "sessions",
  plan: "plans",
};
/** The lowercase plural used for labels such as "Search memories". */
export const collectionNoun = (kind: ProjectResource["kind"]) => nouns[kind];

/** A column between the name and the row menu. */
export type IndexColumn =
  "agent" | "repository" | "person" | "updated" | "status";

/** What one collection's index offers: columns, filters, sorts, and search. */
export interface IndexPage {
  kind: ProjectResource["kind"];
  /** The name column's heading. */
  title: string;
  /** The member each row credits, as the column, filter, and sort name them. */
  person: { label: string; field: "owner" | "updatedBy" };
  columns: IndexColumn[];
  /** Filter categories in menu order. */
  filters: IndexFilterKey[];
  statuses: FilterOption[];
  /** Where a status sorts under Most urgent first; no status sorts last. */
  statusRank: (status: IndexStatus | null) => number;
  /** Sort options in menu order. */
  sorts: SortOption<IndexSort>[];
  defaultSort: IndexSort;
  /** The text a search matches. */
  searchText: (resource: ProjectResource, title: string) => string[];
}

const alphabetical: [string, string] = ["A to Z", "Z to A"];
const sortOptions = (
  order: IndexSort[],
  person: string,
): SortOption<IndexSort>[] => {
  const options: Record<IndexSort, SortOption<IndexSort>> = {
    title: {
      value: "title",
      label: "Name",
      icon: ArrowDownAZIcon,
      directions: alphabetical,
    },
    status: {
      value: "status",
      label: "Status",
      icon: CircleCheckIcon,
      directions: ["Most urgent first", "Least urgent first"],
    },
    repository: {
      value: "repository",
      label: "Repository",
      icon: FolderIcon,
      directions: alphabetical,
    },
    author: {
      value: "author",
      label: person,
      icon: UserIcon,
      directions: alphabetical,
    },
    updated: {
      value: "updated",
      label: "Last updated",
      icon: ClockIcon,
      directions: ["Oldest first", "Newest first"],
    },
  };
  return order.map((sort) => options[sort]);
};

const statusOptions = (
  statuses: IndexStatus[],
  group: (status: IndexStatus) => string,
): FilterOption[] =>
  statuses.map((status) => ({
    value: status.key,
    label: status.label,
    icon: status.icon,
    group: group(status),
  }));

const agents: ResourceSource[] = ["claude", "codex", "pi"];
/** The coding tool behind a row; shared items have none. */
export const agentOf = (resource: ProjectResource) =>
  resource.source === "shared" ? undefined : resource.source;

/** The team has a revision of it; a fork Orka just made has none yet. */
export const isShared = (resource: ProjectResource) =>
  !resource.local && resource.revision > 0;

const locations = {
  mac: { value: "mac", label: "On this Mac", icon: LaptopIcon },
  shared: { value: "shared", label: "Shared with team", icon: UsersIcon },
};
/** Where a row lives, as its leading icon and the Location filter name it. */
export const locationOf = (resource: ProjectResource) =>
  locations[isShared(resource) ? "shared" : "mac"];

export const isFork = (resource: ProjectResource) =>
  Boolean(resource.fork || resource.nativeForkParentId);

/** Lists search the path and agent too; Skills search names only. */
const listSearch = (resource: ProjectResource, title: string) => {
  const agent = agentOf(resource);
  return [
    title,
    resource.title,
    resource.logicalPath,
    ...(agent ? [sourceName(agent)] : []),
  ];
};
const listSorts = (person: string) =>
  sortOptions(["updated", "title", "status", "repository", "author"], person);

export const indexPages: Record<ProjectResource["kind"], IndexPage> = {
  skill: {
    kind: "skill",
    title: "Skill",
    person: { label: "Shared by", field: "owner" },
    columns: ["repository", "person", "status"],
    filters: ["statuses", "people", "repositories", "locations"],
    statuses: statusOptions(skillStatuses, ({ tone }) =>
      tone === "red" || tone === "amber" ? "attention" : tone,
    ),
    statusRank,
    sorts: sortOptions(
      ["title", "status", "repository", "author", "updated"],
      "Shared by",
    ),
    defaultSort: "title",
    searchText: (skill, title) => [title, skill.title],
  },
  session: {
    kind: "session",
    title: "Session",
    person: { label: "Owner", field: "owner" },
    columns: ["agent", "repository", "person", "updated", "status"],
    filters: [
      "statuses",
      "people",
      "agents",
      "repositories",
      "locations",
      "forks",
    ],
    statuses: statusOptions(listStatuses.session, ({ tone }) => tone),
    statusRank: listStatusRank,
    sorts: listSorts("Owner"),
    defaultSort: "updated",
    searchText: listSearch,
  },
  plan: {
    kind: "plan",
    title: "Plan",
    person: { label: "Owner", field: "owner" },
    columns: ["repository", "person", "updated", "status"],
    filters: ["statuses", "people", "repositories", "locations"],
    statuses: statusOptions(listStatuses.plan, ({ tone }) => tone),
    statusRank: listStatusRank,
    sorts: listSorts("Owner"),
    defaultSort: "updated",
    searchText: listSearch,
  },
  memory: {
    kind: "memory",
    title: "Memory",
    person: { label: "Updated by", field: "updatedBy" },
    columns: ["agent", "repository", "person", "updated", "status"],
    filters: [
      "statuses",
      "people",
      "agents",
      "repositories",
      "locations",
      "kinds",
    ],
    statuses: statusOptions(listStatuses.memory, ({ tone }) => tone),
    statusRank: listStatusRank,
    sorts: listSorts("Updated by"),
    defaultSort: "updated",
    searchText: listSearch,
  },
};

/** The member a row credits: you for items only on this Mac. */
export const creditedMember = (
  page: IndexPage,
  resource: ProjectResource,
  user: string | null,
) =>
  isShared(resource)
    ? resource[page.person.field]
    : (user ?? resource[page.person.field]);

/** Last updated reads newest first; every other sort reads A to Z. */
export const sortDirection = (filters: IndexFilters): IndexSortDirection =>
  filters.direction ?? (filters.sort === "updated" ? "desc" : "asc");

export const filterPicksActive = (filters: IndexFilters) =>
  Object.values(filters.picks ?? {}).some((picks) => picks?.length);

export const clearFilterPicks = (filters: IndexFilters): IndexFilters => ({
  ...filters,
  picks: {},
});

interface IndexContext {
  displayTitle: (resource: ProjectResource) => string;
  user: string | null;
  memberName: (id: string) => string;
  statusOf: (resource: ProjectResource) => IndexStatus | null;
}
type OptionContext = Pick<IndexContext, "user" | "memberName"> & {
  page: IndexPage;
};

const categories: Record<
  IndexFilterKey,
  {
    label: (page: IndexPage) => string;
    icon: IconGlyph;
    /** The option a row files under, if any. */
    value: (
      resource: ProjectResource,
      context: IndexContext & { page: IndexPage },
    ) => string | undefined;
    options: (
      resources: ProjectResource[],
      context: OptionContext,
    ) => FilterOption[];
    /** Shown only when there are at least two options to choose between. */
    choice?: true;
  }
> = {
  statuses: {
    label: () => "Status",
    icon: CircleCheckIcon,
    value: (resource, { statusOf }) => statusOf(resource)?.key,
    options: (_, { page }) => page.statuses,
  },
  people: {
    label: (page) => page.person.label,
    icon: UserIcon,
    value: (resource, { page, user }) => creditedMember(page, resource, user),
    options: (resources, { page, user, memberName }) =>
      [
        ...new Set(
          resources.map((resource) => creditedMember(page, resource, user)),
        ),
      ]
        .map((id) => ({ value: id, label: memberName(id), icon: UserIcon }))
        .sort(
          (a, b) =>
            Number(b.value === user) - Number(a.value === user) ||
            a.label.localeCompare(b.label),
        ),
    // A solo project has nobody else to filter by.
    choice: true,
  },
  agents: {
    label: () => "Agent",
    icon: SquareTerminalIcon,
    value: agentOf,
    options: (resources) =>
      agents
        .filter((agent) =>
          resources.some((resource) => resource.source === agent),
        )
        .map((agent) => ({ value: agent, label: sourceName(agent) })),
    choice: true,
  },
  repositories: {
    label: () => "Repository",
    icon: FolderIcon,
    value: (resource) => resource.sourceId ?? undefined,
    options: (resources) =>
      [
        ...new Map(
          resources
            .filter((resource) => resource.sourceId && resource.repositoryName)
            .map((resource) => [
              resource.sourceId as string,
              resource.repositoryName as string,
            ]),
        ),
      ]
        .map(([value, label]) => ({ value, label, icon: FolderIcon }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    choice: true,
  },
  locations: {
    label: () => "Location",
    icon: MapPinIcon,
    value: (resource) => locationOf(resource).value,
    options: () => Object.values(locations),
  },
  forks: {
    label: () => "Forks",
    icon: GitForkIcon,
    value: (resource) => (isFork(resource) ? "fork" : "original"),
    options: () => [
      { value: "fork", label: "Forks" },
      { value: "original", label: "Originals" },
    ],
  },
  kinds: {
    label: () => "Kind",
    icon: FileIcon,
    value: (resource) =>
      isInstructionFile(resource) ? "instruction" : "memory",
    options: () => [
      { value: "instruction", label: "Instruction file", icon: FileTextIcon },
      { value: "memory", label: "Memory", icon: FileIcon },
    ],
  },
};

/** The page's filter categories for this collection, with the current picks. */
export function filterCategories(
  page: IndexPage,
  resources: ProjectResource[],
  filters: IndexFilters,
  context: Omit<OptionContext, "page">,
): FilterCategory[] {
  return page.filters.flatMap((id) => {
    const category = categories[id];
    const options = category.options(resources, { ...context, page });
    if (category.choice && options.length < 2) return [];
    // A pick whose option is gone (a removed repository, a member who left)
    // is dropped, so it can never filter the list from out of sight.
    const selected = (filters.picks?.[id] ?? []).filter((value) =>
      options.some((option) => option.value === value),
    );
    return [
      {
        id,
        label: category.label(page),
        icon: category.icon,
        options,
        selected,
      },
    ];
  });
}

/** The filters that can still apply: each category's surviving picks. */
export const effectiveFilters = (
  filters: IndexFilters,
  shown: FilterCategory[],
): IndexFilters => ({
  ...filters,
  picks: Object.fromEntries(
    shown.map((category) => [category.id, category.selected]),
  ),
});

const compareText = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: "base" });

/** Search, then narrow within each of the page's categories, then sort. */
export function applyPageFilters(
  page: IndexPage,
  resources: ProjectResource[],
  filters: IndexFilters,
  context: IndexContext,
): ProjectResource[] {
  const { displayTitle, user, memberName, statusOf } = context;
  const query = filters.query.trim().toLocaleLowerCase();
  const matches = resources.filter(
    (resource) =>
      (!query ||
        page
          .searchText(resource, displayTitle(resource))
          .some((text) => text.toLocaleLowerCase().includes(query))) &&
      page.filters.every((id) => {
        const picks = filters.picks?.[id];
        if (!picks?.length) return true;
        const value = categories[id].value(resource, { ...context, page });
        return value !== undefined && picks.includes(value);
      }),
  );
  const byName = (a: ProjectResource, b: ProjectResource) =>
    compareText(displayTitle(a), displayTitle(b));
  const byUpdated = (a: ProjectResource, b: ProjectResource) =>
    Date.parse(a.updatedAt) - Date.parse(b.updatedAt);
  const primary = (a: ProjectResource, b: ProjectResource) => {
    switch (filters.sort) {
      case "status":
        return page.statusRank(statusOf(a)) - page.statusRank(statusOf(b));
      case "repository":
        return compareText(a.repositoryName ?? "", b.repositoryName ?? "");
      case "author":
        return compareText(
          memberName(creditedMember(page, a, user)),
          memberName(creditedMember(page, b, user)),
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
