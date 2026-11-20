import { LockIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import type { SkillSummaries } from "./use-skill-summaries.js";
import { SkillGrid } from "./skill-grid.js";
import { useMemberLabel } from "./member-names.js";
import {
  ProjectSkillUsageStatus,
  type useProjectSkillUsage,
} from "./skill-usage.js";

export interface ResourceIndexProps {
  skillSummaries: SkillSummaries;
  skillUsage?: ReturnType<typeof useProjectSkillUsage>;
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
  toolbarAction?: React.ReactNode;
  /**
   * The resource whose reading view was just closed. Its row or card takes
   * focus, or the search field when the current filters hide it.
   */
  focusResource?: string;
  onFocusHandled?: () => void;
  onOpen: (id: string) => void;
}

/** The shared toolbar over a T1 table (memories, sessions) or the K1 skill cards. */
export function ResourceIndex({
  skillSummaries,
  skillUsage,
  kind,
  resources,
  filters,
  onFilters,
  user,
  displayTitle,
  duplicateTitles,
  conflicted,
  connected,
  noAccess,
  loading,
  discovering = false,
  discoveryResult,
  onRefreshLocal,
  status,
  accessRequest,
  toolbarAction,
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
  const ownership = kind === "skill" ? "all" : (filters.ownership ?? "all");
  const root = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (kind === "skill") body.current?.scrollTo({ top: 0 });
  }, [filters, kind]);
  const visible = useMemo(
    () =>
      applyIndexFilters(resources, filters, {
        displayTitle,
        user,
        memberName,
        usageCounts: skillUsage?.usage?.counts,
      }),
    [resources, filters, displayTitle, user, memberName, skillUsage?.usage],
  );
  const sources = useMemo(
    () => [...new Set(resources.map((r) => r.source))],
    [resources],
  );
  const filtered = Boolean(
    filters.query.trim() ||
    filters.source !== "all" ||
    (filters.repository && filters.repository !== "all"),
  );
  const clearFilters = () => {
    onFilters({
      ...defaultIndexFilters,
      ownership,
      sort: filters.sort,
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
  const showFilters = resources.length > 0 || filtered;
  const toolbar = (showFilters || toolbarAction) && (
    <IndexToolbar
      kind={kind}
      count={visible.length}
      sources={sources}
      filters={filters}
      onChange={onFilters}
      onRefreshUsage={skillUsage?.retry}
      usageLoading={skillUsage?.loading}
      showFilters={showFilters}
      action={toolbarAction}
    />
  );
  return (
    <section
      className="resource-index"
      aria-label={collectionNoun(kind)}
      ref={root}
      tabIndex={-1}
    >
      {status}
      {kind === "skill" && skillUsage && (
        <ProjectSkillUsageStatus {...skillUsage} />
      )}
      {toolbarAction && <div className="resource-index-toolbar">{toolbar}</div>}
      <div className="resource-index-body" ref={body}>
        {accessRequest}
        {kind !== "skill" && (
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
            {onRefreshLocal && (
              <IconButton
                icon={RefreshCwIcon}
                size="sm"
                variant="tertiary"
                aria-label="Refresh local items"
                title={`Refresh local ${collectionNoun(kind)}`}
                disabled={refreshing}
                onClick={refreshLocal}
              />
            )}
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
        {!toolbarAction && toolbar}
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
              title={`No ${collectionNoun(kind)} match`}
              description="Try a different search or clear your filters."
              announce
              actions={
                <Button size="sm" variant="secondary" onClick={clearFilters}>
                  Clear filters
                </Button>
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
        ) : kind === "skill" ? (
          <SkillGrid
            skills={visible}
            summaries={skillSummaries}
            usageCounts={skillUsage?.usage?.counts}
            displayTitle={displayTitle}
            conflicted={conflicted}
            onOpen={onOpen}
          />
        ) : (
          <ResourceTable
            resources={visible}
            label={
              kind === "session"
                ? "Session"
                : kind === "plan"
                  ? "Plan"
                  : "Memory"
            }
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
      </div>
    </section>
  );
}

const emptyDescriptions: Record<Resource["kind"], string> = {
  session: "Start a chat in Claude Code or Codex from a connected folder.",
  memory: "Project instructions and memories found by Orka appear here.",
  plan: "Plans saved by your coding tools for this project appear here.",
  skill: "Import a skill from Codex or Claude.",
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
