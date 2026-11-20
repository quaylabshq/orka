import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  GitForkIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { ResourceItemMenu } from "./resource-menu.js";
import { ItemMenuButton } from "./item-menu.js";
import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ProjectResource as Resource } from "../types.js";
import { useMemberLabel } from "./member-names.js";
import { RepositoryLabel } from "./repository-label.js";
import { sessionAncestors, sessionTree } from "./session-tree.js";
import { Button } from "./button.js";
import { IconButton } from "./icon-button.js";
import { ResourceIdentity } from "./resource-identity.js";
import { useQueryClient } from "@tanstack/react-query";
import { useWorkspaceScope } from "./workspace-cache.js";
import { SessionMessagesQuery } from "./use-session-messages.js";

const rootsPerPage = 40;

type RowAnchor = {
  id: string;
  parents?: ReadonlyMap<string, string | undefined>;
};

const shortDate = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});
const shortDateWithYear = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const dateTime = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

/** "23h ago" style labels for recent activity, calendar dates beyond a week. */
function relativeUpdated(date: Date, now: number, year: number) {
  if (Number.isNaN(date.getTime())) return date.toString();
  const seconds = Math.max(0, Math.round((now - date.getTime()) / 1000));
  if (seconds < 60) return "Just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return (date.getFullYear() === year ? shortDate : shortDateWithYear).format(
    date,
  );
}

/** Disambiguates repeated display titles without exposing full paths in the row. */
function pathSuffix(resource: Resource) {
  return resource.logicalPath.split("/").slice(-2).join("/");
}

export interface ResourceTableProps {
  resources: Resource[];
  /** Singular column name for the visually hidden header, e.g. "Memory". */
  label: string;
  user: string | null;
  displayTitle: (resource: Resource) => string;
  /** Lowercased display titles that appear more than once. */
  duplicateTitles?: Set<string>;
  /** Resource IDs with an unresolved conflict. */
  conflicted: Set<string>;
  loading?: boolean;
  focusResource?: string;
  filtered?: boolean;
  pageKey?: string;
  onOpen: (id: string) => void;
}

/** Scannable index shared by memories and sessions. Each row opens the reading view. */
export function ResourceTable({
  resources,
  label,
  user,
  displayTitle,
  duplicateTitles,
  conflicted,
  loading = false,
  focusResource,
  filtered = false,
  pageKey = "",
  onOpen,
}: ResourceTableProps) {
  const client = useQueryClient();
  const scope = useWorkspaceScope();
  const memberName = useMemberLabel(user);
  const sessions = resources[0]?.kind === "session";
  const showRepository = resources.some((resource) => resource.repositoryName);
  const [focusedResource, setFocusedResource] = useState<RowAnchor>();
  const [menuResource, setMenuResource] = useState<RowAnchor>();
  const anchor = menuResource ?? focusedResource;
  const tree = useMemo(
    () => sessionTree(resources, anchor?.parents),
    [resources, anchor?.parents],
  );
  const [ancestors] = useState(() =>
    sessionAncestors(focusResource, tree.parents),
  );
  const [expanded, setExpanded] = useState(() => new Set(ancestors));
  const [limits, setLimits] = useState<Record<string, number>>(() => {
    const initial: Record<string, number> = {};
    for (const id of [focusResource, ...ancestors]) {
      if (!id) continue;
      const parent = tree.parents.get(id);
      if (parent)
        initial[parent] = Math.max(
          5,
          (tree.children
            .get(parent)
            ?.findIndex((child) => child.resourceId === id) ?? 0) + 1,
        );
    }
    return initial;
  });
  const pageCount = Math.max(1, Math.ceil(tree.roots.length / rootsPerPage));
  const [position, setPosition] = useState(() => {
    const focusRoot = ancestors.at(-1) ?? focusResource;
    const index = focusRoot
      ? tree.roots.findIndex((resource) => resource.resourceId === focusRoot)
      : -1;
    return {
      key: pageKey,
      page: Math.floor(Math.max(0, index) / rootsPerPage),
    };
  });
  const anchoredResource = anchor?.id;
  const rowAnchor = (id: string): RowAnchor => {
    if (!sessions) return { id };
    // A local refresh can discover a parent for an existing row. Apply that
    // grouping after focus and any open menu move away from the branch.
    const branch = [id, ...sessionAncestors(id, tree.parents)];
    return {
      id,
      parents: new Map(branch.map((id) => [id, tree.parents.get(id)])),
    };
  };
  const focusRow = (id: string) =>
    setFocusedResource((current) =>
      current?.id === id ? current : rowAnchor(id),
    );
  const focusedRoot =
    sessionAncestors(anchoredResource, tree.parents).at(-1) ?? anchoredResource;
  const focusedIndex = focusedRoot
    ? tree.roots.findIndex((resource) => resource.resourceId === focusedRoot)
    : -1;
  // Title replies and discovery can move the focused row across a page boundary.
  const page =
    position.key !== pageKey
      ? 0
      : focusedIndex >= 0
        ? Math.floor(focusedIndex / rootsPerPage)
        : Math.min(position.page, pageCount - 1);
  if (position.key !== pageKey || (anchoredResource && focusedIndex < 0)) {
    setFocusedResource(undefined);
    setMenuResource(undefined);
  }
  if (page !== position.page || position.key !== pageKey) {
    setPosition({ key: pageKey, page });
  }
  const rows = useMemo(() => {
    const flattened: (
      | { resource: Resource; depth: number }
      | { parent: Resource; remaining: number; depth: number }
    )[] = [];
    const append = (resource: Resource, depth: number) => {
      flattened.push({ resource, depth });
      if (!expanded.has(resource.resourceId) && !filtered) return;
      const children = tree.children.get(resource.resourceId) ?? [];
      const limit = filtered
        ? children.length
        : (limits[resource.resourceId] ?? 5);
      children.slice(0, limit).forEach((child) => append(child, depth + 1));
      if (children.length > limit)
        flattened.push({
          parent: resource,
          remaining: children.length - limit,
          depth: depth + 1,
        });
    };
    // A page starts at a top-level item, keeping displayed forks with their parent.
    const start = page * rootsPerPage;
    tree.roots
      .slice(start, start + rootsPerPage)
      .forEach((resource) => append(resource, 0));
    return flattened;
  }, [tree, expanded, limits, filtered, page]);
  const table = useRef<HTMLTableElement>(null);
  const pageChanged = useRef(false);
  const goToPage = (page: number) => {
    pageChanged.current = true;
    setFocusedResource(undefined);
    setMenuResource(undefined);
    setPosition({ key: pageKey, page });
  };
  useLayoutEffect(() => {
    if (!pageChanged.current) return;
    pageChanged.current = false;
    table.current?.scrollIntoView({ block: "start" });
    table.current
      ?.querySelector<HTMLButtonElement>("tbody button:not(:disabled)")
      ?.focus({ preventScroll: true });
  }, [page]);
  const now = new Date();
  const content = (
    <table
      ref={table}
      className="resource-table"
      aria-busy={loading}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setFocusedResource(undefined);
      }}
    >
      <colgroup>
        <col />
        {showRepository && <col className="resource-table-col-repository" />}
        <col className="resource-table-col-identity" />
        <col className="resource-table-col-updated" />
        <col className="resource-table-col-actions" />
      </colgroup>
      <thead className="sr-only">
        <tr>
          <th scope="col">{label}</th>
          {showRepository && <th scope="col">Repository</th>}
          <th scope="col">Tool and author</th>
          <th scope="col">Updated</th>
          <th scope="col">
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          if ("parent" in row)
            return (
              <tr
                key={`more:${row.parent.resourceId}`}
                className="session-forks-more"
                onFocus={() => focusRow(row.parent.resourceId)}
              >
                <td colSpan={showRepository ? 5 : 4}>
                  <Button
                    variant="tertiary"
                    size="sm"
                    aria-label={`Show more forks of ${displayTitle(row.parent)}`}
                    onClick={() =>
                      setLimits((current) => ({
                        ...current,
                        [row.parent.resourceId]:
                          (current[row.parent.resourceId] ?? 5) + 5,
                      }))
                    }
                  >
                    View more ({row.remaining})
                  </Button>
                </td>
              </tr>
            );
          const { resource, depth } = row;
          const title = displayTitle(resource);
          const updated = new Date(resource.updatedAt);
          const updatedTooltip = Number.isNaN(updated.getTime())
            ? updated.toString()
            : dateTime.format(updated);
          const children = tree.children.get(resource.resourceId) ?? [];
          const open = filtered || expanded.has(resource.resourceId);
          const onMenuChange = (open: boolean) =>
            setMenuResource((current) =>
              open
                ? current?.id === resource.resourceId
                  ? current
                  : rowAnchor(resource.resourceId)
                : current?.id === resource.resourceId
                  ? undefined
                  : current,
            );
          return (
            <ResourceItemMenu
              key={resource.resourceId}
              resource={resource}
              onOpenChange={onMenuChange}
            >
              {(actions) => (
                <tr
                  className={depth > 0 ? "session-fork-row" : undefined}
                  onPointerEnter={() =>
                    void SessionMessagesQuery.prefetch(client, scope, resource)
                  }
                  onFocus={(event) => {
                    if (event.currentTarget.contains(event.target))
                      focusRow(resource.resourceId);
                    void SessionMessagesQuery.prefetch(client, scope, resource);
                  }}
                  onClick={() => onOpen(resource.resourceId)}
                >
                  <th scope="row" className="resource-table-title">
                    <div
                      className="resource-table-title-content"
                      style={{ paddingInlineStart: Math.min(depth, 4) * 20 }}
                    >
                      {tree.children.size > 0 && (
                        <span className="session-forks-disclosure">
                          {children.length > 0 && (
                            <button
                              type="button"
                              className="session-forks-toggle"
                              aria-expanded={open}
                              aria-label={`${open ? "Collapse" : "Expand"} ${children.length} ${children.length === 1 ? "fork" : "forks"} of ${title}`}
                              disabled={filtered}
                              onClick={(event) => {
                                event.stopPropagation();
                                setExpanded((current) => {
                                  const next = new Set(current);
                                  if (next.has(resource.resourceId))
                                    next.delete(resource.resourceId);
                                  else next.add(resource.resourceId);
                                  return next;
                                });
                              }}
                            >
                              {open ? (
                                <ChevronDownIcon size={16} />
                              ) : (
                                <ChevronRightIcon size={16} />
                              )}
                              <span>{children.length}</span>
                            </button>
                          )}
                        </span>
                      )}
                      {(resource.fork || resource.nativeForkParentId) && (
                        <GitForkIcon
                          className="session-fork-icon"
                          size={16}
                          aria-label="Forked session"
                        />
                      )}
                      <div className="resource-table-title-text">
                        <button
                          type="button"
                          className="resource-table-open"
                          data-resource-id={resource.resourceId}
                          title={resource.title}
                          onClick={(event) => {
                            event.stopPropagation();
                            onOpen(resource.resourceId);
                          }}
                        >
                          {title}
                        </button>
                        {!sessions &&
                          duplicateTitles?.has(title.toLocaleLowerCase()) && (
                            <small
                              className="resource-table-suffix"
                              title={resource.logicalPath}
                            >
                              {pathSuffix(resource)}
                            </small>
                          )}
                        {(resource.local ||
                          (resource.fork && resource.revision === 0) ||
                          resource.localChanges) && (
                          <small className="resource-table-suffix">
                            {resource.localChanges
                              ? "Local changes"
                              : sessions
                                ? "Local Only"
                                : "On this Mac"}
                          </small>
                        )}
                        {!sessions &&
                          !resource.local &&
                          resource.owner !== user && (
                            <small className="resource-table-suffix">
                              Owner: {memberName(resource.owner)}
                            </small>
                          )}
                        {conflicted.has(resource.resourceId) && (
                          <span className="resource-conflict">
                            <TriangleAlertIcon size={12} aria-hidden="true" />
                            Needs resolution
                          </span>
                        )}
                      </div>
                    </div>
                  </th>
                  {showRepository && (
                    <td className="resource-table-repository">
                      <RepositoryLabel name={resource.repositoryName} />
                    </td>
                  )}
                  <td>
                    <ResourceIdentity resource={resource} user={user} />
                  </td>
                  <td className="resource-table-updated">
                    <time
                      dateTime={resource.updatedAt}
                      title={`Updated ${updatedTooltip}`}
                    >
                      {relativeUpdated(
                        updated,
                        now.getTime(),
                        now.getFullYear(),
                      )}
                    </time>
                  </td>
                  <td className="resource-table-actions">
                    {actions.length > 0 ? (
                      <ItemMenuButton
                        actions={actions}
                        label={`Actions for ${title}`}
                        onOpenChange={onMenuChange}
                      />
                    ) : (
                      <ChevronRightIcon size={16} aria-hidden="true" />
                    )}
                  </td>
                </tr>
              )}
            </ResourceItemMenu>
          );
        })}
      </tbody>
    </table>
  );
  return (
    <>
      {content}
      {pageCount > 1 && (
        <nav
          className="resource-table-pagination"
          aria-label={`${label} pages`}
        >
          <IconButton
            icon={ChevronLeftIcon}
            aria-label="Previous page"
            title="Previous page"
            size="sm"
            variant="tertiary"
            disabled={page === 0}
            onClick={() => goToPage(page - 1)}
          />
          <span role="status">
            Page {page + 1} of {pageCount}
          </span>
          <IconButton
            icon={ChevronRightIcon}
            aria-label="Next page"
            title="Next page"
            size="sm"
            variant="tertiary"
            disabled={page === pageCount - 1}
            onClick={() => goToPage(page + 1)}
          />
        </nav>
      )}
    </>
  );
}
