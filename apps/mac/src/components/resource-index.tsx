import { LockIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectResource as Resource } from "../types.js";
import { SegmentedControl } from "./segmented-control.js";
import { IconButton } from "./icon-button.js";
import { Button } from "./button.js";
import { Icon } from "./icon.js";
import { EmptyState } from "./empty-state.js";
import { useToasts } from "./toasts.js";
import {
  IndexToolbar,
  applyIndexFilters,
  collectionNoun,
  defaultIndexFilters,
  type IndexFilters,
  type OwnershipFilter,
} from "./index-toolbar.js";
import { ResourceTable } from "./resource-table.js";
import { LoadingRegion } from "./loading-region.js";
import { CollectionSkeleton } from "./collection-skeleton.js";
import { skillSummaryKey, type SkillSummaries } from "./use-skill-summaries.js";
import { SkillPeek, SkillTable } from "./skill-table.js";
import { SkillToolbar, useFilterCategories } from "./skill-toolbar.js";
import {
  applyPageFilters,
  clearFilterPicks,
  creditedMember,
  effectiveFilters,
  filterPicksActive,
  indexPages,
  sortDirection,
} from "./skill-index.js";
import type { IndexStatus } from "./skill-status.js";
import { useMemberLabel } from "./member-names.js";

export interface ResourceIndexProps {
  skillSummaries: SkillSummaries;
  kind: Resource["kind"];
  /** The loaded, non-deleted collection before any filter. */
  resources: Resource[];
  filters: IndexFilters;
  onFilters: (filters: IndexFilters) => void;
  user: string | null;
  displayTitle: (resource: Resource) => string;
  /** Lowercased display titles that repeat in the collection. */
  duplicateTitles: Set<string>;
  /** Resource IDs with an unresolved conflict. */
  conflicted: Set<string>;
  /** The one status each row shows. */
  statusOf?: (resource: Resource) => IndexStatus | null;
  /** Lists name each row's repository only when the project has several. */
  multiRepository?: boolean;
  /** Whether this Mac has a connected folder; it changes the empty copy. */
  connected: boolean;
  noAccess?: boolean;
  /** Session titles still loading. */
  loading?: boolean;
  discovering?: boolean;
  discoveryResult?: { errors: string[] };
  onRefreshLocal?: () => void;
  /** A notice above the toolbar, such as unavailable session titles. */
  status?: React.ReactNode;
  accessRequest?: React.ReactNode;
  floatingAction?: React.ReactNode;
  /**
   * The resource whose reading view was just closed. Its row or card takes
   * focus, or the search field when the current filters hide it.
   */
  focusResource?: string;
  onFocusHandled?: () => void;
  onOpen: (id: string) => void;
}

const noStatus = () => null;
const noResources: Resource[] = [];

/** The shared toolbar over a T1 table (memories, sessions) or the skills table. */
export function ResourceIndex({
  skillSummaries,
  kind,
  resources,
  filters,
  onFilters,
  user,
  displayTitle,
  duplicateTitles,
  conflicted,
  statusOf = noStatus,
  multiRepository = false,
  connected,
  noAccess,
  loading,
  discovering = false,
  discoveryResult,
  onRefreshLocal,
  status,
  accessRequest,
  floatingAction,
  focusResource,
  onFocusHandled,
  onOpen,
}: ResourceIndexProps) {
  const memberName = useMemberLabel(user);
  const { notify } = useToasts();
  const discoveryErrors = discoveryResult?.errors ?? [];
  const discoveryFailed = !resources.length && discoveryErrors.length > 0;
  const [refreshRequest, setRefreshRequest] = useState<{
    result: typeof discoveryResult;
  } | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const refreshing = discovering || refreshRequest !== null;
  const refreshLocal = () => {
    if (!onRefreshLocal || refreshing) return;
    setRefreshRequest({ result: discoveryResult });
    onRefreshLocal();
  };
  useEffect(() => {
    if (
      !refreshRequest ||
      !discoveryResult ||
      discovering ||
      discoveryResult === refreshRequest.result
    )
      return;
    setRefreshRequest(null);
    setRefreshFailed(Boolean(discoveryResult?.errors.length));
    if (!discoveryResult?.errors.length)
      notify({
        kind: "success",
        title: `Local ${collectionNoun(kind)} refreshed`,
      });
  }, [discovering, discoveryResult, refreshRequest, kind, notify]);
  const page = indexPages[kind];
  const paged = kind !== "session";
  const ownership = paged ? "all" : (filters.ownership ?? "all");
  const root = useRef<HTMLElement>(null);
  const categories = useFilterCategories(
    page,
    paged ? resources : noResources,
    filters,
    user,
    memberName,
  );
  // Filter by the picks that still have an option behind them.
  const applied = useMemo(
    () => (paged ? effectiveFilters(filters, categories) : filters),
    [paged, filters, categories],
  );
  const visible = useMemo(
    () =>
      paged
        ? applyPageFilters(page, resources, applied, {
            displayTitle,
            user,
            memberName,
            statusOf,
          })
        : applyIndexFilters(resources, applied, {
            displayTitle,
            user,
            memberName,
          }),
    [paged, page, resources, applied, displayTitle, user, memberName, statusOf],
  );
  const picked = paged && filterPicksActive(applied);
  const searched = filters.query.trim();
  const sources = useMemo(
    () => [...new Set(resources.map((r) => r.source))],
    [resources],
  );
  const filtered = paged
    ? Boolean(searched) || picked
    : Boolean(
        searched ||
        filters.source !== "all" ||
        (filters.repository && filters.repository !== "all"),
      );
  const toolbarShown = resources.length > 0 || filtered;
  /** Skills carry their primary action in the toolbar once there is one. */
  const toolbarAction = kind === "skill" && toolbarShown;
  const inlineAction = Boolean(
    floatingAction &&
    !resources.length &&
    !filtered &&
    !discovering &&
    !discoveryErrors.length &&
    !noAccess &&
    connected,
  );
  const refreshButton = onRefreshLocal && (
    <IconButton
      icon={RefreshCwIcon}
      size="sm"
      variant="secondary"
      aria-label="Refresh local items"
      title="Refresh local items"
      disabled={refreshing}
      onClick={refreshLocal}
    />
  );
  // Keep the popover mounted when the first import moves its trigger into the toolbar.
  const toolbar = paged ? (
    <SkillToolbar
      key="index-toolbar"
      page={page}
      showTools={toolbarShown}
      categories={categories}
      filters={filters}
      onChange={onFilters}
      refresh={refreshButton}
      actions={
        React.isValidElement<{ compact?: boolean }>(floatingAction)
          ? React.cloneElement(floatingAction, { compact: toolbarAction })
          : floatingAction
      }
    />
  ) : null;
  const clearFilters = () => {
    onFilters({
      ...defaultIndexFilters,
      ownership,
      sort: filters.sort,
      direction: filters.direction,
    });
    const focusTarget = resources.length
      ? root.current?.querySelector<HTMLElement>('input[type="search"]')
      : root.current?.querySelector<HTMLElement>(
          '.resource-ownership-tabs [aria-pressed="true"]',
        );
    (focusTarget ?? root.current)?.focus();
  };
  useEffect(() => {
    if (!focusResource) return;
    const target =
      root.current?.querySelector<HTMLElement>(
        `[data-resource-id="${CSS.escape(focusResource)}"]`,
      ) ?? root.current?.querySelector<HTMLElement>('input[type="search"]');
    target?.focus();
    onFocusHandled?.();
  }, [focusResource, onFocusHandled]);
  return (
    <section
      className={`resource-index${floatingAction && !toolbarAction ? (inlineAction ? " resource-index--inline-action" : " resource-index--floating-action") : ""}`}
      aria-label={collectionNoun(kind)}
      ref={root}
      tabIndex={-1}
    >
      {status}
      <div className="resource-index-body">
        {accessRequest}
        {!paged && (
          <div className="resource-ownership-toolbar">
            <SegmentedControl
              className="resource-ownership-tabs"
              label="Filter by ownership"
              value={ownership}
              options={[
                {
                  value: "all",
                  label: "All",
                },
                { value: "mine", label: "Mine" },
                { value: "shared", label: "Shared with me" },
              ]}
              onChange={(ownership) => onFilters({ ...filters, ownership })}
            />
            {refreshButton}
          </div>
        )}
        {discovering && resources.length > 0 && (
          <span className="sr-only" role="status">
            Refreshing {collectionNoun(kind)}…
          </span>
        )}
        {kind !== "skill" && discoveryErrors.length > 0 && (
          <div className="resource-discovery-status">
            <div role={refreshing ? "status" : "alert"} aria-atomic="true">
              <p className="resource-discovery-title">
                <Icon icon={TriangleAlertIcon} size="sm" variant="secondary" />
                {refreshing
                  ? `Checking local ${collectionNoun(kind)}…`
                  : refreshFailed
                    ? `Couldn’t refresh local ${collectionNoun(kind)}`
                    : discoveryFailed
                      ? `Couldn’t check local ${collectionNoun(kind)}`
                      : `Some local ${collectionNoun(kind)} couldn’t be checked`}
              </p>
              {resources.length > 0 && (
                <p className="resource-discovery-message">
                  Previously discovered items are still available.
                </p>
              )}
              {!refreshing &&
                discoveryErrors.map((error, index) => (
                  <p className="resource-discovery-message" key={index}>
                    {error}
                  </p>
                ))}
            </div>
            {onRefreshLocal && (
              <Button
                size="sm"
                variant="tertiary"
                onClick={refreshLocal}
                disabled={refreshing}
              >
                <span className={refreshing ? "sync-activity-icon" : ""}>
                  <Icon icon={RefreshCwIcon} size="sm" />
                </span>
                {refreshing ? "Checking…" : "Try again"}
              </Button>
            )}
          </div>
        )}
        {toolbarShown && toolbar}
        {toolbarShown && !paged && (
          <IndexToolbar
            kind={kind}
            count={visible.length}
            sources={sources}
            filters={filters}
            onChange={onFilters}
          />
        )}
        {discovering && !resources.length ? (
          <LoadingRegion
            id={`collection:${kind}`}
            label={`Loading ${collectionNoun(kind)}…`}
            loading
            skeleton={<CollectionSkeleton />}
          >
            <div />
          </LoadingRegion>
        ) : discoveryFailed ? null : !visible.length ? (
          filtered ? (
            <EmptyState
              illustration="search"
              size="compact"
              title={
                paged && searched
                  ? `No ${collectionNoun(kind)} match “${searched}”${picked ? " with these filters" : ""}`
                  : `No ${collectionNoun(kind)} match`
              }
              description={
                // With a search and filters both on, the title and the two
                // buttons already say everything.
                searched && picked
                  ? undefined
                  : "Try a different search or clear your filters."
              }
              announce
              actions={
                searched && picked ? (
                  <>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => onFilters({ ...filters, query: "" })}
                    >
                      Clear search
                    </Button>
                    <Button
                      size="sm"
                      variant="tertiary"
                      onClick={() => onFilters(clearFilterPicks(filters))}
                    >
                      Clear filters
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="secondary" onClick={clearFilters}>
                    {paged && !picked ? "Clear search" : "Clear filters"}
                  </Button>
                )
              }
            />
          ) : (
            <ResourceEmptyState
              kind={kind}
              ownership={ownership}
              connected={connected}
              restricted={noAccess && ownership !== "mine"}
            />
          )
        ) : paged ? (
          <SkillTable
            page={page}
            resources={visible}
            user={user}
            memberName={memberName}
            statusOf={statusOf}
            displayTitle={displayTitle}
            showRepository={
              kind === "skill"
                ? resources.some((skill) => skill.repositoryName)
                : multiRepository
            }
            // A project with nobody else in it has no one to credit.
            showPerson={resources.some(
              (resource) => creditedMember(page, resource, user) !== user,
            )}
            sort={filters.sort}
            direction={sortDirection(filters)}
            busy={kind === "skill" ? undefined : loading}
            onOpen={onOpen}
            peek={
              kind === "skill"
                ? (skill) => (
                    <SkillPeek
                      skill={skill}
                      summary={skillSummaries[skillSummaryKey(skill)]}
                    />
                  )
                : undefined
            }
          />
        ) : (
          <ResourceTable
            resources={visible}
            label={page.title}
            user={user}
            displayTitle={displayTitle}
            duplicateTitles={duplicateTitles}
            conflicted={conflicted}
            loading={loading}
            focusResource={focusResource}
            pageKey={JSON.stringify(filters)}
            filtered={filtered || ownership !== "all"}
            onOpen={onOpen}
          />
        )}
        {!toolbarShown && toolbar}
        {kind !== "skill" && floatingAction && (
          <div className="resource-index-action">{floatingAction}</div>
        )}
      </div>
    </section>
  );
}

const emptyDescriptions: Record<Resource["kind"], string> = {
  session: "Start a chat in Claude Code or Codex from a connected folder.",
  memory: "Project instructions and memories found by Orka appear here.",
  plan: "Plans saved by your coding tools for this project appear here.",
  skill: "Add a skill from Codex or Claude.",
};

function ResourceEmptyState({
  kind,
  ownership,
  connected,
  restricted,
}: {
  kind: Resource["kind"];
  ownership: OwnershipFilter;
  connected: boolean;
  restricted?: boolean;
}) {
  const noun = collectionNoun(kind);
  if (restricted) {
    return (
      <EmptyState
        title={`Access to shared ${noun} is restricted.`}
        icon={LockIcon}
        size="compact"
        announce
      />
    );
  }
  if (ownership === "shared") {
    return (
      <EmptyState
        title={`No ${noun} shared with you yet`}
        illustration={kind}
        announce
      />
    );
  }
  return (
    <EmptyState
      title={
        ownership === "mine" ? `No ${noun} of your own yet` : `No ${noun} yet`
      }
      description={
        connected
          ? emptyDescriptions[kind]
          : "Items from connected folders appear here."
      }
      illustration={kind}
      announce
    />
  );
}
