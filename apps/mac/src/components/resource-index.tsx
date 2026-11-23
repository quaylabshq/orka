import {
  GitForkIcon,
  LockIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ProjectResource as Resource } from "../types.js";
import { IconButton } from "./icon-button.js";
import { Button } from "./button.js";
import { Icon } from "./icon.js";
import { EmptyState } from "./empty-state.js";
import { useToasts } from "./toasts.js";
import {
  collectionNoun,
  defaultIndexFilters,
  type IndexFilters,
} from "./index-toolbar.js";
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
  isFork,
  sortDirection,
} from "./skill-index.js";
import type { IndexStatus } from "./skill-status.js";
import { useMemberLabel } from "./member-names.js";
import { SessionMessagesQuery } from "./use-session-messages.js";
import { useWorkspaceScope } from "./workspace-cache.js";

export interface ResourceIndexProps {
  skillSummaries: SkillSummaries;
  kind: Resource["kind"];
  /** The loaded, non-deleted collection before any filter. */
  resources: Resource[];
  filters: IndexFilters;
  onFilters: (filters: IndexFilters) => void;
  user: string | null;
  displayTitle: (resource: Resource) => string;
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

/** Search, Filter, and Sort over one collection's table. */
export function ResourceIndex({
  skillSummaries,
  kind,
  resources,
  filters,
  onFilters,
  user,
  displayTitle,
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
  const client = useQueryClient();
  const scope = useWorkspaceScope();
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
  const root = useRef<HTMLElement>(null);
  const categories = useFilterCategories(
    page,
    resources,
    filters,
    user,
    memberName,
  );
  // Filter by the picks that still have an option behind them.
  const applied = useMemo(
    () => effectiveFilters(filters, categories),
    [filters, categories],
  );
  const visible = useMemo(
    () =>
      applyPageFilters(page, resources, applied, {
        displayTitle,
        user,
        memberName,
        statusOf,
      }),
    [page, resources, applied, displayTitle, user, memberName, statusOf],
  );
  const picked = filterPicksActive(applied);
  const searched = filters.query.trim();
  const filtered = Boolean(searched) || picked;
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
  const toolbar = (
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
  );
  const clearFilters = () => {
    onFilters({
      ...defaultIndexFilters,
      sort: filters.sort,
      direction: filters.direction,
    });
    (
      root.current?.querySelector<HTMLElement>('input[type="search"]') ??
      root.current
    )?.focus();
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
                searched
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
                    {picked ? "Clear filters" : "Clear search"}
                  </Button>
                )
              }
            />
          ) : (
            <ResourceEmptyState
              kind={kind}
              connected={connected}
              restricted={noAccess}
            />
          )
        ) : (
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
            onRowIntent={
              kind === "session"
                ? (session) =>
                    void SessionMessagesQuery.prefetch(client, scope, session)
                : undefined
            }
            titleTrailing={(resource) =>
              kind === "session" &&
              isFork(resource) && (
                <GitForkIcon
                  size={12}
                  className="skill-table-fork"
                  role="img"
                  aria-label="Forked session"
                />
              )
            }
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
        )}
        {!toolbarShown && toolbar}
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
  connected,
  restricted,
}: {
  kind: Resource["kind"];
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
  return (
    <EmptyState
      title={`No ${noun} yet`}
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
