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
import type { SkillSummaries } from "./use-skill-summaries.js";
import { SkillTable } from "./skill-table.js";
import {
  SkillToolbar,
  effectiveSkillFilters,
  useSkillFilterCategories,
} from "./skill-toolbar.js";
import {
  applySkillFilters,
  clearSkillFilters,
  skillSharedBy,
  skillFiltersActive,
  sortDirection,
} from "./skill-index.js";
import type { SkillStatus } from "./skill-status.js";
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
  /** The one status each skill row shows; skills only. */
  skillStatus?: (skill: Resource) => SkillStatus | null;
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

const noSkillStatus = () => null;
const noSkills: Resource[] = [];

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
  skillStatus = noSkillStatus,
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
  const ownership = kind === "skill" ? "all" : (filters.ownership ?? "all");
  const root = useRef<HTMLElement>(null);
  const skillCategories = useSkillFilterCategories(
    kind === "skill" ? resources : noSkills,
    filters,
    user,
    memberName,
  );
  // Skills filter by the picks that still have an option behind them.
  const applied = useMemo(
    () =>
      kind === "skill"
        ? effectiveSkillFilters(filters, skillCategories)
        : filters,
    [kind, filters, skillCategories],
  );
  const visible = useMemo(
    () =>
      kind === "skill"
        ? applySkillFilters(resources, applied, {
            displayTitle,
            user,
            memberName,
            statusOf: skillStatus,
          })
        : applyIndexFilters(resources, applied, {
            displayTitle,
            user,
            memberName,
          }),
    [kind, resources, applied, displayTitle, user, memberName, skillStatus],
  );
  const skillFiltered = kind === "skill" && skillFiltersActive(applied);
  const sources = useMemo(
    () => [...new Set(resources.map((r) => r.source))],
    [resources],
  );
  const filtered =
    kind === "skill"
      ? Boolean(filters.query.trim()) || skillFiltered
      : Boolean(
          filters.query.trim() ||
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
        {toolbarShown && kind === "skill" && (
          <SkillToolbar
            categories={skillCategories}
            filters={filters}
            onChange={onFilters}
            actions={
              // In the toolbar the action takes the toolbar's control size.
              React.isValidElement<{ compact?: boolean }>(floatingAction)
                ? React.cloneElement(floatingAction, { compact: true })
                : floatingAction
            }
          />
        )}
        {toolbarShown && kind !== "skill" && (
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
                kind === "skill" && filters.query.trim()
                  ? `No skills match “${filters.query.trim()}”${skillFiltered ? " with these filters" : ""}`
                  : `No ${collectionNoun(kind)} match`
              }
              description={
                kind === "skill" && filters.query.trim() && skillFiltered
                  ? "Filters are also narrowing the list. Clear the search, the filters, or both."
                  : "Try a different search or clear your filters."
              }
              announce
              actions={
                kind === "skill" && filters.query.trim() && skillFiltered ? (
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
                      onClick={() => onFilters(clearSkillFilters(filters))}
                    >
                      Clear filters
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="secondary" onClick={clearFilters}>
                    {kind === "skill" && !skillFiltered
                      ? "Clear search"
                      : "Clear filters"}
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
        ) : kind === "skill" ? (
          <SkillTable
            skills={visible}
            summaries={skillSummaries}
            user={user}
            memberName={memberName}
            statusOf={skillStatus}
            displayTitle={displayTitle}
            showRepository={resources.some((skill) => skill.repositoryName)}
            // A project with nobody else in it has no one to credit.
            showSharedBy={resources.some(
              (skill) => skillSharedBy(skill, user) !== user,
            )}
            sort={filters.sort}
            direction={sortDirection(filters)}
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
        {floatingAction && !toolbarAction && (
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
