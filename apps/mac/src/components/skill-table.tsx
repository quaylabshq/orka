import {
  ArrowDownIcon,
  ArrowUpIcon,
  BotIcon,
  CircleCheckIcon,
  ClockIcon,
  FileIcon,
  FolderIcon,
  LaptopIcon,
  UserIcon,
  UsersIcon,
} from "lucide-react";
import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ProjectResource as Resource } from "../types.js";
import type { IndexSort, IndexSortDirection } from "./index-toolbar.js";
import { ItemMenuButton } from "./item-menu.js";
import { useMemberPhoto } from "./member-names.js";
import { ResourceItemMenu } from "./resource-menu.js";
import {
  agentOf,
  creditedMember,
  type IndexColumn,
  type IndexPage,
} from "./skill-index.js";
import type { IndexStatus } from "./skill-status.js";
import { SourceLabel, sourceName } from "./source-label.js";
import { UpdatedTime } from "./updated-time.js";
import type { SkillSummaries } from "./use-skill-summaries.js";
import "./skill-table.css";

/** How long the pointer rests on a row before its description opens. */
const PEEK_DELAY = 400;
/** Room a description needs under its row before it opens upward instead. */
const PEEK_ROOM = 144;

const headings: Record<
  IndexColumn,
  {
    sort?: IndexSort;
    label: (page: IndexPage) => string;
    icon: typeof FileIcon;
    className?: string;
  }
> = {
  agent: {
    label: () => "Agent",
    icon: BotIcon,
    className: "skill-table-agent-heading",
  },
  repository: {
    sort: "repository",
    label: () => "Repository",
    icon: FolderIcon,
  },
  person: {
    sort: "author",
    label: (page) => page.person.label,
    icon: UserIcon,
    className: "skill-table-person-heading",
  },
  updated: {
    sort: "updated",
    label: () => "Updated",
    icon: ClockIcon,
    className: "skill-table-updated",
  },
  status: { sort: "status", label: () => "Status", icon: CircleCheckIcon },
};

function Person({ id, name }: { id: string; name: string }) {
  const photo = useMemberPhoto(id);
  return (
    <span className="skill-table-person" title={name}>
      <span className="skill-table-avatar" aria-hidden="true">
        {name.trim().charAt(0).toLocaleUpperCase() || "?"}
        {photo && (
          <img
            key={photo}
            src={photo}
            alt=""
            width={20}
            height={20}
            loading="lazy"
            onError={(event) => {
              event.currentTarget.hidden = true;
            }}
          />
        )}
      </span>
      <span className="skill-table-person-name">{name}</span>
    </span>
  );
}

export function SkillStatusPill({ status }: { status: IndexStatus }) {
  return (
    <span className="skill-status-pill" data-tone={status.tone}>
      <status.icon size={12} aria-hidden="true" />
      {status.label}
    </span>
  );
}

/** A skill's peek: its description, and where it came from. */
export function SkillPeek({
  skill,
  summary,
}: {
  skill: Resource;
  summary: SkillSummaries[string] | undefined;
}) {
  return (
    <>
      {summary === undefined ? (
        <span
          className="skill-table-peek-loading loading-fade"
          aria-hidden="true"
        >
          <span />
          <span />
        </span>
      ) : summary?.description ? (
        <span className="skill-table-peek-description">
          {summary.description}
        </span>
      ) : (
        <span className="skill-table-peek-empty">No description</span>
      )}
      {skill.global && (
        <span className="skill-table-peek-origin">From your global skills</span>
      )}
    </>
  );
}

export function SkillTable({
  page,
  resources,
  user,
  memberName,
  statusOf,
  displayTitle,
  showRepository,
  showPerson,
  sort,
  direction,
  busy,
  onOpen,
  peek: peekContent,
  titleTrailing,
}: {
  page: IndexPage;
  resources: Resource[];
  user: string | null;
  memberName: (id: string) => string;
  statusOf: (resource: Resource) => IndexStatus | null;
  displayTitle: (resource: Resource) => string;
  /** Columns follow the whole collection, so filtering never moves them. */
  showRepository: boolean;
  showPerson: boolean;
  sort: IndexSort;
  direction: IndexSortDirection;
  /** Row titles are still loading. */
  busy?: boolean;
  onOpen: (id: string) => void;
  /** What a row's peek says after its pointer rests or it takes focus. */
  peek?: (resource: Resource) => React.ReactNode;
  /** A marker right after a row's title, such as a session's fork. */
  titleTrailing?: (resource: Resource) => React.ReactNode;
}) {
  const peekId = useId();
  const [peek, setPeek] = useState<{ id: string; above: boolean }>();
  const timer = useRef(0);
  // An open row menu owns the row; the description stays out of its way.
  const menuOpen = useRef(false);
  const openPeek = (id: string, row: HTMLElement, delay: number) => {
    window.clearTimeout(timer.current);
    if (menuOpen.current || !peekContent) return;
    timer.current = window.setTimeout(() => {
      // A row near the bottom of the visible list opens its description upward.
      const view = row.closest(".resource-index-body");
      const bottom = view?.getBoundingClientRect().bottom ?? window.innerHeight;
      setPeek({
        id,
        above: row.getBoundingClientRect().bottom + PEEK_ROOM > bottom,
      });
    }, delay);
  };
  const closePeek = useCallback(() => {
    window.clearTimeout(timer.current);
    setPeek(undefined);
  }, []);
  const onMenu = (open: boolean) => {
    menuOpen.current = open;
    if (open) closePeek();
  };
  useEffect(() => {
    if (!peek) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePeek();
    };
    window.addEventListener("keydown", dismiss);
    window.addEventListener("scroll", closePeek, true);
    return () => {
      window.removeEventListener("keydown", dismiss);
      window.removeEventListener("scroll", closePeek, true);
    };
  }, [peek, closePeek]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const SortArrow = direction === "asc" ? ArrowUpIcon : ArrowDownIcon;
  const heading = (
    key: IndexSort | undefined,
    label: string,
    Glyph: typeof FileIcon,
    className?: string,
  ) => (
    <th
      key={label}
      scope="col"
      className={className}
      aria-sort={
        key && sort === key
          ? direction === "asc"
            ? "ascending"
            : "descending"
          : undefined
      }
    >
      <span className="skill-table-heading">
        <Glyph size={14} aria-hidden="true" />
        <span className="skill-table-heading-label">{label}</span>
        {key && sort === key && <SortArrow size={12} aria-hidden="true" />}
      </span>
    </th>
  );
  const columns = page.columns.filter(
    (column) =>
      (column !== "repository" || showRepository) &&
      (column !== "person" || showPerson),
  );
  const now = new Date();
  const cell = (
    column: IndexColumn,
    resource: Resource,
    status: IndexStatus | null,
  ) => {
    switch (column) {
      case "agent": {
        const agent = agentOf(resource);
        return (
          <td
            key={column}
            className="skill-table-agent"
            title={agent && sourceName(agent)}
          >
            {agent && <SourceLabel source={agent} />}
          </td>
        );
      }
      case "repository":
        return (
          <td key={column} className="skill-table-repository">
            {resource.repositoryName && (
              <span
                className="skill-table-repository-label"
                title={resource.repositoryName}
                aria-label={`Repository: ${resource.repositoryName}`}
              >
                <FolderIcon size={12} aria-hidden="true" />
                <span>{resource.repositoryName}</span>
              </span>
            )}
          </td>
        );
      case "person": {
        const person = creditedMember(page, resource, user);
        return (
          <td key={column}>
            <Person id={person} name={memberName(person)} />
          </td>
        );
      }
      case "updated":
        return (
          <td key={column} className="skill-table-updated">
            <UpdatedTime value={resource.updatedAt} now={now} />
          </td>
        );
      case "status":
        return (
          <td key={column}>{status && <SkillStatusPill status={status} />}</td>
        );
    }
  };
  return (
    <table
      className="skill-table"
      data-kind={page.kind}
      data-compact-people={showPerson || undefined}
      aria-busy={busy}
    >
      <colgroup>
        <col />
        {columns.map((column) => (
          <col key={column} className={`skill-table-col-${column}`} />
        ))}
        <col className="skill-table-col-actions" />
      </colgroup>
      <thead>
        <tr>
          {heading("title", page.title, FileIcon)}
          {columns.map((column) => {
            const { sort: key, label, icon, className } = headings[column];
            return heading(key, label(page), icon, className);
          })}
          <th scope="col">
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {resources.map((resource) => {
          const title = displayTitle(resource);
          const status = statusOf(resource);
          const Leading = resource.local ? LaptopIcon : UsersIcon;
          const peeking = peek?.id === resource.resourceId;
          return (
            <ResourceItemMenu
              key={resource.resourceId}
              resource={resource}
              flat
              onOpenChange={onMenu}
            >
              {(actions) => (
                <tr
                  onClick={() => onOpen(resource.resourceId)}
                  onPointerEnter={(event) =>
                    openPeek(
                      resource.resourceId,
                      event.currentTarget,
                      PEEK_DELAY,
                    )
                  }
                  onPointerLeave={closePeek}
                  onFocus={(event) => {
                    // Keyboard focus only: returning from an item or closing
                    // a menu restores focus without opening the peek.
                    if (event.target.matches(":focus-visible"))
                      openPeek(resource.resourceId, event.currentTarget, 0);
                  }}
                  onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget))
                      closePeek();
                  }}
                >
                  <th scope="row" className="skill-table-name">
                    <span className="skill-table-name-content">
                      <Leading
                        size={14}
                        className="skill-table-leading"
                        aria-label={
                          resource.local
                            ? "On this Mac"
                            : "Shared with the project"
                        }
                      />
                      <button
                        type="button"
                        className="skill-table-open"
                        data-resource-id={resource.resourceId}
                        title={resource.title}
                        aria-describedby={peeking ? peekId : undefined}
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpen(resource.resourceId);
                        }}
                      >
                        {title}
                      </button>
                      {titleTrailing?.(resource)}
                    </span>
                    {peeking && peekContent && (
                      <span
                        id={peekId}
                        className="skill-table-peek"
                        data-side={peek.above ? "above" : "below"}
                        role="tooltip"
                      >
                        {peekContent(resource)}
                      </span>
                    )}
                  </th>
                  {columns.map((column) => cell(column, resource, status))}
                  <td
                    className="skill-table-actions"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {actions.length > 0 && (
                      <ItemMenuButton
                        actions={actions}
                        label={`Actions for ${title}`}
                        onOpenChange={onMenu}
                      />
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
}
