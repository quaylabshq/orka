import { productAction } from "./desktop-usage.js";
import {
  ChevronRightIcon,
  FolderIcon,
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
import { AccessPill, IndexAccessDialog } from "./index-access.js";
import type { RequestAccessProps } from "./request-access.js";
import { useToasts } from "./toasts.js";
import {
  applyPageFilters,
  clearFilterPicks,
  collectionNoun,
  creditedMember,
  defaultIndexFilters,
  effectiveFilters,
  filterPicksActive,
  indexPages,
  isFork,
  sortDirection,
  type IndexFilterKey,
  type IndexFilters,
  type IndexRepository,
} from "./index-pages.js";
import { LoadingRegion } from "./loading-region.js";
import {
  CollectionSkeleton,
  IndexTableSkeleton,
} from "./collection-skeleton.js";
import { skillSummaryKey, type SkillSummaries } from "./use-skill-summaries.js";
import { SkillPeek, IndexTable } from "./index-table.js";
import { ListPeek } from "./list-peek.js";
import { sessionTree } from "./session-tree.js";
import { IndexToolbar, useFilterCategories } from "./index-toolbar.js";
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
  /** Active sources whose filter options survive an empty collection. */
  repositories: IndexRepository[];
  /** Lists credit each row's person whenever the project has several members. */
  multiMember?: boolean;
  /** Whether this Mac has a connected folder; it changes the empty copy. */
  connected: boolean;
  /** How lists connect this Mac while it has no connected folder. */
  connect?: { repositories: boolean; busy: boolean; onConnect: () => void };
  noAccess?: boolean;
  /** Session titles still loading. */
  loading?: boolean;
  discovering?: boolean;
  discoveryResult?: { errors: string[] };
  onRefreshLocal?: () => void;
  /** A notice above the toolbar, such as unavailable session titles. */
  status?: React.ReactNode;
  accessRequest?: React.ReactElement<RequestAccessProps>;
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
  onFilters: updateFilters,
  user,
  displayTitle,
  statusOf = noStatus,
  repositories,
  multiMember = false,
  connected,
  connect,
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
  onOpen: openResource,
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
  const onFilters = (next: IndexFilters) => {
    if (next.sort !== filters.sort || next.direction !== filters.direction)
      productAction()("resource_sort_changed");
    else if (next.query === filters.query)
      productAction()("resource_filter_applied");
    updateFilters(next);
  };
  const onOpen = (id: string) => {
    if (filters.query.trim()) productAction()("resource_search_result_opened");
    openResource(id);
  };
  const lastSearch = useRef("");
  const root = useRef<HTMLElement>(null);
  const showRepository =
    kind === "skill"
      ? resources.some((skill) => skill.repositoryName)
      : repositories.length > 1;
  const categories = useFilterCategories(
    page,
    resources,
    filters,
    user,
    memberName,
    repositories,
  );
  // Filter by the picks that still have an option behind them.
  const applied = useMemo(
    () => effectiveFilters(filters, categories),
    [filters, categories],
  );
  // A pick whose option went away is dropped for good, so it cannot come
  // back on its own when that person or repository returns.
  const stalePicks = Object.entries(filters.picks ?? {}).some(
    ([id, picks]) =>
      (picks?.length ?? 0) >
      (applied.picks?.[id as IndexFilterKey]?.length ?? 0),
  );
  useEffect(() => {
    if (stalePicks) updateFilters(applied);
  }, [stalePicks, applied, updateFilters]);
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
  useEffect(() => {
    const query = filters.query.trim();
    if (!query) {
      lastSearch.current = "";
      return;
    }
    const timer = window.setTimeout(() => {
      if (
        query === lastSearch.current ||
        document.hidden ||
        !document.hasFocus()
      )
        return;
      lastSearch.current = query;
      productAction()(
        "resource_search_completed",
        visible.length === 0
          ? "zero"
          : visible.length === 1
            ? "one"
            : "several",
      );
    }, 750);
    return () => window.clearTimeout(timer);
  }, [filters.query, visible.length]);
  // Forks and their parents come from the whole collection, so a filter
  // never hides who a session forked from.
  const family = useMemo(() => {
    if (kind !== "session") return undefined;
    const tree = sessionTree(resources);
    const byId = new Map(resources.map((item) => [item.resourceId, item]));
    return (session: Resource) => {
      const parent = byId.get(tree.parents.get(session.resourceId) ?? "");
      return {
        parent: parent && displayTitle(parent),
        forks: tree.children.get(session.resourceId)?.length ?? 0,
      };
    };
  }, [kind, resources, displayTitle]);
  const duplicatePlanTitles = useMemo(() => {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    if (kind === "plan") {
      for (const resource of resources) {
        const title = displayTitle(resource).toLocaleLowerCase();
        if (seen.has(title)) duplicates.add(title);
        seen.add(title);
      }
    }
    return duplicates;
  }, [kind, resources, displayTitle]);
  const duplicatePlan = (resource: Resource) =>
    duplicatePlanTitles.size > 0 &&
    duplicatePlanTitles.has(displayTitle(resource).toLocaleLowerCase());
  const picked = filterPicksActive(applied);
  const searched = filters.query.trim();
  const filtered = Boolean(searched) || picked;
  const noun = collectionNoun(kind);
  const list = kind !== "skill";
  // A project with nobody else in it has no one to credit. A list of a shared
  // project credits people from the start, so its columns hold while it loads.
  const showPerson =
    (list && multiMember) ||
    resources.some((resource) => creditedMember(page, resource, user) !== user);
  // Loading rows draw under the toolbar; Empty, No access, and Could not load hide it.
  const toolbarShown = resources.length > 0 || filtered || discovering;
  const restrictedEmpty = Boolean(noAccess) && !resources.length;
  // Empty keeps Refresh so a new local item shows before the next scan.
  const emptyRefresh =
    list &&
    connected &&
    Boolean(onRefreshLocal) &&
    !toolbarShown &&
    !discoveryFailed &&
    !restrictedEmpty;
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
  const connectButton = ({
    compact = false,
    blocked = false,
  }: { compact?: boolean; blocked?: boolean } = {}) =>
    connect && (
      <Button
        size={compact ? "sm" : "md"}
        variant={compact ? "secondary" : "primary"}
        disabled={connect.busy || blocked}
        onClick={connect.onConnect}
      >
        <Icon icon={FolderIcon} />
        {connect.repositories ? "Connect repositories" : "Connect folder"}
      </Button>
    );
  const renderConnection = (request: React.ReactNode, sending: boolean) => (
    <IndexAccessDialog
      label={request || noAccess ? "Access limited" : "Not on this Mac"}
      busy={sending}
    >
      <section className="index-access-section">
        <FolderIcon size={16} aria-hidden="true" />
        <div className="index-access-section-body">
          <h3 className="index-access-title">Not on this Mac</h3>
          <p className="index-access-description">
            Connect{" "}
            {connect?.repositories ? "the repositories" : "the project folder"}{" "}
            {noAccess ? "to find local items." : `to ${connectPurposes[kind]}.`}
          </p>
          <div className="index-access-connect">
            {connectButton({ compact: true, blocked: sending })}
          </div>
        </div>
      </section>
      {(request || noAccess) && (
        <section className="index-access-section">
          <LockIcon size={16} aria-hidden="true" />
          <div className="index-access-section-body">
            <h3 className="index-access-title">
              {noAccess ? `Shared ${noun} are restricted` : "Editing access"}
            </h3>
            <p className="index-access-description">
              {noAccess
                ? `Your role cannot see ${noun} shared in this project.`
                : `You need editing access to update the team’s shared ${noun}.`}
            </p>
            {request}
          </div>
        </section>
      )}
    </IndexAccessDialog>
  );
  // Lists explain a page-wide limit beside the toolbar; Skills keep theirs above it.
  const access =
    !connected && connect ? (
      accessRequest ? (
        React.cloneElement(accessRequest, { renderInDialog: renderConnection })
      ) : (
        renderConnection(null, false)
      )
    ) : noAccess ? (
      <AccessPill
        label="Restricted"
        title={`Shared ${noun} are restricted`}
        icon={LockIcon}
      >
        <p className="index-access-description">
          Your role cannot see {noun} shared in this project.
        </p>
        {accessRequest}
      </AccessPill>
    ) : (
      accessRequest
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
  const trailing =
    list && toolbarShown ? (
      <>
        {refreshButton}
        {access}
      </>
    ) : emptyRefresh ? (
      refreshButton
    ) : undefined;
  const headShown = toolbarShown || emptyRefresh;
  // Keep the popover mounted when the first import moves its trigger into the toolbar.
  const toolbar = (
    <IndexToolbar
      key="index-toolbar"
      page={page}
      showTools={toolbarShown}
      categories={categories}
      filters={filters}
      onChange={onFilters}
      trailing={trailing}
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
      <div
        className={`resource-index-body${headShown ? " resource-index-body--sticky-toolbar" : ""}`}
      >
        {(!list || (!toolbarShown && !restrictedEmpty)) && accessRequest}
        {discovering && resources.length > 0 && (
          <span className="sr-only" role="status">
            Refreshing {noun}…
          </span>
        )}
        {list && filtered && visible.length > 0 && (
          // Lists show no count; a search or filter says what is left.
          <span className="sr-only" role="status">
            {visible.length}{" "}
            {visible.length === 1 ? page.title.toLocaleLowerCase() : noun}
          </span>
        )}
        {list && discoveryErrors.length > 0 && resources.length > 0 && (
          <div className="resource-discovery-status">
            <div role={refreshing ? "status" : "alert"} aria-atomic="true">
              <p className="resource-discovery-title">
                <Icon icon={TriangleAlertIcon} size="sm" variant="secondary" />
                {refreshing
                  ? `Checking local ${noun}…`
                  : refreshFailed
                    ? `Couldn’t refresh local ${noun}`
                    : `Some local ${noun} couldn’t be checked`}
              </p>
              <p className="resource-discovery-message">
                Previously discovered items are still available.
              </p>
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
        {headShown && toolbar}
        {discovering && !resources.length ? (
          <LoadingRegion
            id={`collection:${kind}`}
            label={`Loading ${noun}…`}
            loading
            skeleton={
              list ? (
                <IndexTableSkeleton
                  page={page}
                  showRepository={showRepository}
                  showPerson={showPerson}
                  sort={filters.sort}
                  direction={sortDirection(filters)}
                />
              ) : (
                <CollectionSkeleton />
              )
            }
          >
            <div />
          </LoadingRegion>
        ) : discoveryFailed ? (
          <EmptyState
            illustration={kind}
            title={`Couldn’t load ${noun}`}
            description={`Orka couldn’t check this Mac for ${noun}.`}
            announce
            details={
              // The cause, as local discovery reported it.
              <details className="resource-load-details">
                <summary>
                  <ChevronRightIcon
                    className="resource-load-details-chevron"
                    size={14}
                    aria-hidden="true"
                  />
                  Details
                </summary>
                {discoveryErrors.map((error, index) => (
                  <p key={index}>{error}</p>
                ))}
              </details>
            }
            actions={
              onRefreshLocal && (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={refreshing}
                  onClick={refreshLocal}
                >
                  <Icon icon={RefreshCwIcon} size="sm" />
                  Try again
                </Button>
              )
            }
          />
        ) : !visible.length ? (
          filtered ? (
            <EmptyState
              illustration="search"
              size="compact"
              title={
                searched
                  ? `No ${noun} match “${searched}”${picked ? " with these filters" : ""}`
                  : `No ${noun} match`
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
              actions={
                list && (
                  <>
                    {restrictedEmpty && accessRequest}
                    {!connected && connectButton()}
                  </>
                )
              }
            />
          )
        ) : (
          <IndexTable
            page={page}
            resources={visible}
            user={user}
            memberName={memberName}
            statusOf={statusOf}
            displayTitle={displayTitle}
            showRepository={showRepository}
            showPerson={showPerson}
            sort={filters.sort}
            direction={sortDirection(filters)}
            busy={kind === "skill" ? undefined : loading}
            focusResource={focusResource}
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
                  className="index-table-fork"
                  role="img"
                  aria-label="Forked session"
                />
              )
            }
            titleDetail={(resource) =>
              duplicatePlan(resource)
                ? resource.logicalPath.split("/").slice(-2).join("/")
                : undefined
            }
            peek={(resource) =>
              kind === "skill" ? (
                <SkillPeek
                  skill={resource}
                  summary={skillSummaries[skillSummaryKey(resource)]}
                />
              ) : (
                <ListPeek
                  resource={resource}
                  family={family?.(resource)}
                  showLogicalPath={duplicatePlan(resource)}
                />
              )
            }
          />
        )}
        {!headShown && toolbar}
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

/** What connecting this Mac adds for each list. */
const connectPurposes: Partial<Record<Resource["kind"], string>> = {
  session: "continue shared sessions and share your own",
  memory: "open shared memories in your editor",
  plan: "open shared plans in your editor",
};

function ResourceEmptyState({
  kind,
  connected,
  restricted,
  actions,
}: {
  kind: Resource["kind"];
  connected: boolean;
  restricted?: boolean;
  actions?: React.ReactNode;
}) {
  const noun = collectionNoun(kind);
  if (restricted) {
    return kind === "skill" ? (
      <EmptyState
        title={`Access to shared ${noun} is restricted.`}
        icon={LockIcon}
        size="compact"
        announce
      />
    ) : (
      <EmptyState
        title={`Shared ${noun} are restricted`}
        description={`Your role cannot see ${noun} shared in this project.`}
        icon={LockIcon}
        size="compact"
        announce
        actions={actions}
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
      actions={actions}
    />
  );
}
