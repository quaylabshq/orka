import {
  ArrowDownIcon,
  ArrowUpIcon,
  CircleCheckIcon,
  ClockIcon,
  FileIcon,
  FolderIcon,
  SquareTerminalIcon,
  UserIcon,
} from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ProjectResource as Resource } from "../types.js";
import {
  agentOf,
  creditedMember,
  locationOf,
  type IndexColumn,
  type IndexPage,
  type IndexSort,
  type IndexSortDirection,
} from "./index-pages.js";
import { ItemMenuButton } from "./item-menu.js";
import { useMemberPhoto } from "./member-names.js";
import { ResourceItemMenu } from "./resource-menu.js";
import type { IndexStatus } from "./skill-status.js";
import { SourceLabel, sourceName } from "./source-label.js";
import { UpdatedTime } from "./updated-time.js";
import type { SkillSummaries } from "./use-skill-summaries.js";
import "./index-table.css";

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
    icon: SquareTerminalIcon,
    className: "index-table-agent-heading",
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
    className: "index-table-person-heading",
  },
  updated: {
    sort: "updated",
    label: () => "Updated",
    icon: ClockIcon,
    className: "index-table-updated",
  },
  status: { sort: "status", label: () => "Status", icon: CircleCheckIcon },
};

function Person({ id, name }: { id: string; name: string }) {
  const photo = useMemberPhoto(id);
  return (
    <span className="index-table-person" title={name}>
      <span className="index-table-avatar" aria-hidden="true">
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
      <span className="index-table-person-name">{name}</span>
    </span>
  );
}

function IndexStatusPill({ status }: { status: IndexStatus }) {
  return (
    <span className="index-status-pill" data-tone={status.tone}>
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
          className="index-table-peek-loading loading-fade"
          aria-hidden="true"
        >
          <span />
          <span />
        </span>
      ) : summary?.description ? (
        <span className="index-table-peek-description">
          {summary.description}
        </span>
      ) : (
        <span className="index-table-peek-empty">No description</span>
      )}
      {skill.global && (
        <span className="index-table-peek-origin">From your global skills</span>
      )}
    </>
  );
}

export function IndexTable({
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
  onRowIntent,
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
  /** A pointer or focus arriving on a row, such as to prefetch it. */
  onRowIntent?: (resource: Resource) => void;
  /** What a row's peek says after its pointer rests or it takes focus. */
  peek: (resource: Resource) => React.ReactNode;
  /** A marker right after a row's title, such as a session's fork. */
  titleTrailing?: (resource: Resource) => React.ReactNode;
}) {
  const peekId = useId();
  const [peek, setPeek] = useState<{ id: string; above: boolean }>();
  const timer = useRef(0);
  // An open row menu owns the row; the description stays out of its way.
  const menuOpen = useRef<string | undefined>(undefined);
  const body = useRef<HTMLTableSectionElement>(null);
  const openPeek = (id: string, row: HTMLElement, delay: number) => {
    window.clearTimeout(timer.current);
    if (menuOpen.current !== undefined) return;
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
  const onMenu = (id: string, open: boolean) => {
    menuOpen.current = open ? id : undefined;
    if (open) closePeek();
  };
  const previous = useRef(resources);
  // A late title can re-sort the list. The row being acted on keeps its place
  // on screen when it moves, unless the person had already scrolled it away.
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = resources;
    // A row that leaves the list takes its open menu with it, and that menu
    // never reports closing.
    if (!resources.some(({ resourceId }) => resourceId === menuOpen.current))
      menuOpen.current = undefined;
    const rows = body.current;
    const view = rows?.closest(".resource-index-body");
    const focused = document.activeElement;
    const row =
      menuOpen.current !== undefined
        ? rows?.querySelector(
            `[data-resource-id="${CSS.escape(menuOpen.current)}"]`,
          )
        : focused && rows?.contains(focused)
          ? focused
          : null;
    const tr = row?.closest("tr");
    const id = tr
      ?.querySelector("[data-resource-id]")
      ?.getAttribute("data-resource-id");
    if (!view || !tr || !id) return;
    const from = before.findIndex(({ resourceId }) => resourceId === id);
    const to = resources.findIndex(({ resourceId }) => resourceId === id);
    if (from < 0 || from === to) return;
    // Rows are one height, so the row sat this far from where it is now.
    const { top, height } = tr.getBoundingClientRect();
    const moved = (to - from) * height;
    const bounds = view.getBoundingClientRect();
    if (top - moved < bounds.bottom && top - moved + height > bounds.top)
      view.scrollTop += moved;
  }, [resources]);
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
      <span className="index-table-heading">
        <Glyph size={14} aria-hidden="true" />
        <span className="index-table-heading-label">{label}</span>
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
            className="index-table-agent"
            title={agent && sourceName(agent)}
          >
            {agent && <SourceLabel source={agent} />}
          </td>
        );
      }
      case "repository":
        return (
          <td key={column} className="index-table-repository">
            {resource.repositoryName && (
              <span
                className="index-table-repository-label"
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
          <td key={column} className="index-table-updated">
            <UpdatedTime value={resource.updatedAt} now={now} />
          </td>
        );
      case "status":
        return (
          <td key={column}>{status && <IndexStatusPill status={status} />}</td>
        );
    }
  };
  return (
    <table className="index-table" data-kind={page.kind} aria-busy={busy}>
      <colgroup>
        <col />
        {columns.map((column) => (
          <col key={column} className={`index-table-col-${column}`} />
        ))}
        <col className="index-table-col-actions" />
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
      <tbody ref={body}>
        {resources.map((resource) => {
          const title = displayTitle(resource);
          const status = statusOf(resource);
          const location = locationOf(resource);
          const peeking = peek?.id === resource.resourceId;
          return (
            <ResourceItemMenu
              key={resource.resourceId}
              resource={resource}
              flat
              onOpenChange={(open) => onMenu(resource.resourceId, open)}
            >
              {(actions) => (
                <tr
                  onClick={() => onOpen(resource.resourceId)}
                  onPointerEnter={(event) => {
                    onRowIntent?.(resource);
                    openPeek(
                      resource.resourceId,
                      event.currentTarget,
                      PEEK_DELAY,
                    );
                  }}
                  onPointerLeave={closePeek}
                  onFocus={() => onRowIntent?.(resource)}
                  // Tab ends on the row it moved focus to. Focus handed back by
                  // a closing menu or the reader's Back leaves the peek closed.
                  onKeyUp={(event) => {
                    if (event.key === "Tab")
                      openPeek(resource.resourceId, event.currentTarget, 0);
                  }}
                  onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget))
                      closePeek();
                  }}
                >
                  <th scope="row" className="index-table-name">
                    <span className="index-table-name-content">
                      <location.icon
                        size={14}
                        className="index-table-leading"
                        aria-label={location.label}
                      />
                      <button
                        type="button"
                        className="index-table-open"
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
                    {peeking && (
                      <span
                        id={peekId}
                        className="index-table-peek"
                        data-side={peek.above ? "above" : "below"}
                        role="tooltip"
                      >
                        {peekContent(resource)}
                      </span>
                    )}
                  </th>
                  {columns.map((column) => cell(column, resource, status))}
                  <td
                    className="index-table-actions"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {actions.length > 0 && (
                      <ItemMenuButton
                        actions={actions}
                        label={`Actions for ${title}`}
                        onOpenChange={(open) =>
                          onMenu(resource.resourceId, open)
                        }
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
