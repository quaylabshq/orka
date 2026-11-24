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
  useMemo,
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
/** Rows drawn past each edge of the visible part of the list. */
const OVERSCAN = 20;
/** A row's height until one is measured; index-table.css sets it. */
const ROW_HEIGHT = 44;

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

/** The rows drawn, `start` up to `end` of the list, and each row's height. */
interface RowSpan {
  start: number;
  end: number;
  height: number;
}

/** What a row does with a pointer, focus, or its menu. Stable across renders. */
interface RowEvents {
  open: (id: string) => void;
  intent: (resource: Resource) => void;
  focus: (resource: Resource) => void;
  peek: (id: string, row: HTMLElement, delay: number) => void;
  unpeek: () => void;
  menu: (id: string, open: boolean) => void;
}

/** The resource whose row holds `element`. */
const rowOf = (element: Element | null | undefined) =>
  element
    ?.closest("tr")
    ?.querySelector("[data-resource-id]")
    ?.getAttribute("data-resource-id") ?? undefined;

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
  focusResource,
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
  /** A row about to take focus, such as after Back; drawn wherever it is. */
  focusResource?: string;
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
  const [menu, setMenu] = useState<string>();
  const body = useRef<HTMLTableSectionElement>(null);
  const count = resources.length;
  // Only rows near the visible part of the list are drawn.
  const [span, setSpan] = useState<RowSpan>(() => ({
    start: 0,
    end: Math.min(count, Math.ceil(window.innerHeight / ROW_HEIGHT) + OVERSCAN),
    height: ROW_HEIGHT,
  }));
  // The row last focused or given a menu.
  const held = useRef<string>(undefined);
  const latest = useRef({ menu, onOpen, onRowIntent });
  useLayoutEffect(() => {
    latest.current = { menu, onOpen, onRowIntent };
  });
  const events = useMemo<RowEvents>(() => {
    const unpeek = () => {
      window.clearTimeout(timer.current);
      setPeek(undefined);
    };
    return {
      open: (id) => latest.current.onOpen(id),
      intent: (resource) => latest.current.onRowIntent?.(resource),
      focus: (resource) => {
        held.current = resource.resourceId;
        latest.current.onRowIntent?.(resource);
      },
      peek: (id, row, delay) => {
        window.clearTimeout(timer.current);
        if (latest.current.menu !== undefined) return;
        timer.current = window.setTimeout(() => {
          // A row near the bottom of the visible list opens its description upward.
          const view = row.closest(".resource-index-body");
          const bottom =
            view?.getBoundingClientRect().bottom ?? window.innerHeight;
          setPeek({
            id,
            above: row.getBoundingClientRect().bottom + PEEK_ROOM > bottom,
          });
        }, delay);
      },
      unpeek,
      menu: (id, open) => {
        if (open) {
          unpeek();
          held.current = id;
        }
        setMenu((current) =>
          open ? id : current === id ? undefined : current,
        );
      },
    };
  }, []);
  const update = useCallback(() => {
    const rows = body.current;
    const view = rows?.closest(".resource-index-body");
    if (!rows || !view) return;
    const height =
      rows.querySelector(":scope > tr[aria-rowindex]")?.getBoundingClientRect()
        .height || ROW_HEIGHT;
    const top =
      rows.getBoundingClientRect().top - view.getBoundingClientRect().top;
    const start = Math.min(
      count,
      Math.max(0, Math.floor(-top / height) - OVERSCAN),
    );
    const end = Math.min(
      count,
      Math.max(0, Math.ceil((view.clientHeight - top) / height) + OVERSCAN),
    );
    setSpan((span) =>
      span.start === start && span.end === end && span.height === height
        ? span
        : { start, end, height },
    );
  }, [count]);
  /** The row of the resource `id`, when it is drawn. */
  const rowFor = (id: string | undefined) =>
    id === undefined
      ? undefined
      : body.current
          ?.querySelector(`[data-resource-id="${CSS.escape(id)}"]`)
          ?.closest("tr");
  const previous = useRef(resources);
  // A late title can re-sort the list. The row being acted on keeps its place
  // on screen when it moves, unless the person had already scrolled it away.
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = resources;
    const view = body.current?.closest(".resource-index-body");
    const focused = document.activeElement;
    const id =
      menu ??
      (focused && body.current?.contains(focused) ? rowOf(focused) : undefined);
    const row = rowFor(id);
    if (!view || !row) return;
    const from = before.findIndex(({ resourceId }) => resourceId === id);
    const to = resources.findIndex(({ resourceId }) => resourceId === id);
    if (from < 0 || from === to) return;
    // Rows are one height, so the row sat this far from where it is now.
    const { top, height } = row.getBoundingClientRect();
    const moved = (to - from) * height;
    const bounds = view.getBoundingClientRect();
    if (top - moved < bounds.bottom && top - moved + height > bounds.top)
      view.scrollTop += moved;
  }, [resources, menu]);
  // The row Back is about to focus comes into view first, so the rows drawn
  // next are the ones around it.
  useLayoutEffect(() => {
    rowFor(focusResource)?.scrollIntoView({ block: "nearest" });
  }, [focusResource]);
  // The rows drawn follow the scroll position, the window size, and the list.
  useLayoutEffect(update, [update, resources]);
  useEffect(() => {
    const view = body.current?.closest(".resource-index-body");
    if (!view) return;
    view.addEventListener("scroll", update, { passive: true });
    const resize = new ResizeObserver(update);
    resize.observe(view);
    return () => {
      view.removeEventListener("scroll", update);
      resize.disconnect();
    };
  }, [update]);
  useEffect(() => {
    if (!peek) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") events.unpeek();
    };
    window.addEventListener("keydown", dismiss);
    window.addEventListener("scroll", events.unpeek, true);
    return () => {
      window.removeEventListener("keydown", dismiss);
      window.removeEventListener("scroll", events.unpeek, true);
    };
  }, [peek, events]);
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
  const columns = useMemo(
    () =>
      page.columns.filter(
        (column) =>
          (column !== "repository" || showRepository) &&
          (column !== "person" || showPerson),
      ),
    [page, showRepository, showPerson],
  );
  const start = Math.min(span.start, count);
  const end = Math.min(span.end, count);
  // The row last focused or given a menu, and the row about to take focus,
  // are drawn wherever the list scrolls, so focus stays put and a closing
  // menu can hand focus back.
  const pinned = [held.current, focusResource].flatMap((id) => {
    const index = resources.findIndex(({ resourceId }) => resourceId === id);
    return index >= 0 && (index < start || index >= end) ? [index] : [];
  });
  const drawn = [
    ...new Set(pinned),
    ...Array.from({ length: end - start }, (_, offset) => start + offset),
  ].sort((a, b) => a - b);
  const rows: React.ReactNode[] = [];
  // Rows not drawn keep their height, so the list scrolls its full length.
  const gap = (from: number, to: number) =>
    to > from &&
    rows.push(
      <tr key={`gap-${from}`} className="index-table-spacer" aria-hidden="true">
        <td
          colSpan={columns.length + 2}
          style={{ height: (to - from) * span.height }}
        />
      </tr>,
    );
  let next = 0;
  for (const index of drawn) {
    gap(next, index);
    const resource = resources[index];
    const id = resource.resourceId;
    const person = showPerson
      ? creditedMember(page, resource, user)
      : undefined;
    rows.push(
      <IndexRow
        key={id}
        index={index}
        resource={resource}
        title={displayTitle(resource)}
        status={statusOf(resource)}
        trailing={titleTrailing?.(resource)}
        person={person}
        personName={person === undefined ? undefined : memberName(person)}
        columns={columns}
        menuOpen={menu === id}
        peek={
          peek?.id === id
            ? { above: peek.above, content: peekContent(resource) }
            : undefined
        }
        peekId={peekId}
        events={events}
      />,
    );
    next = index + 1;
  }
  gap(next, count);
  return (
    <table
      className="index-table"
      data-kind={page.kind}
      aria-busy={busy}
      aria-rowcount={count + 1}
    >
      <colgroup>
        <col />
        {columns.map((column) => (
          <col key={column} className={`index-table-col-${column}`} />
        ))}
        <col className="index-table-col-actions" />
      </colgroup>
      <thead>
        <tr aria-rowindex={1}>
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
      <tbody ref={body}>{rows}</tbody>
    </table>
  );
}

const IndexRow = React.memo(function IndexRow({
  index,
  resource,
  title,
  status,
  trailing,
  person,
  personName,
  columns,
  menuOpen,
  peek,
  peekId,
  events,
}: {
  index: number;
  resource: Resource;
  title: string;
  status: IndexStatus | null;
  trailing: React.ReactNode;
  person?: string;
  personName?: string;
  columns: IndexColumn[];
  menuOpen: boolean;
  peek?: { above: boolean; content: React.ReactNode };
  peekId: string;
  events: RowEvents;
}) {
  const id = resource.resourceId;
  const location = locationOf(resource);
  // A row that leaves the list takes its open menu with it, and that menu
  // never reports closing.
  useEffect(() => {
    if (!menuOpen) return;
    return () => events.menu(id, false);
  }, [menuOpen, id, events]);
  const cell = (column: IndexColumn) => {
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
      case "person":
        return (
          <td key={column}>
            {person !== undefined && (
              <Person id={person} name={personName ?? person} />
            )}
          </td>
        );
      case "updated":
        return (
          <td key={column} className="index-table-updated">
            <UpdatedTime value={resource.updatedAt} now={new Date()} />
          </td>
        );
      case "status":
        return (
          <td key={column}>{status && <IndexStatusPill status={status} />}</td>
        );
    }
  };
  return (
    <ResourceItemMenu
      resource={resource}
      flat
      onOpenChange={(open) => events.menu(id, open)}
    >
      {(actions) => (
        <tr
          aria-rowindex={index + 2}
          onClick={() => events.open(id)}
          onPointerEnter={(event) => {
            events.intent(resource);
            events.peek(id, event.currentTarget, PEEK_DELAY);
          }}
          onPointerLeave={events.unpeek}
          onFocus={() => events.focus(resource)}
          // Tab ends on the row it moved focus to. Focus handed back by a
          // closing menu or the reader's Back leaves the peek closed.
          onKeyUp={(event) => {
            if (event.key === "Tab") events.peek(id, event.currentTarget, 0);
          }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget))
              events.unpeek();
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
                data-resource-id={id}
                title={resource.title}
                aria-describedby={peek ? peekId : undefined}
                onClick={(event) => {
                  event.stopPropagation();
                  events.open(id);
                }}
              >
                {title}
              </button>
              {trailing}
            </span>
            {peek && (
              <span
                id={peekId}
                className="index-table-peek"
                data-side={peek.above ? "above" : "below"}
                role="tooltip"
              >
                {peek.content}
              </span>
            )}
          </th>
          {columns.map(cell)}
          <td
            className="index-table-actions"
            onClick={(event) => event.stopPropagation()}
          >
            {actions.length > 0 && (
              <ItemMenuButton
                actions={actions}
                label={`Actions for ${title}`}
                onOpenChange={(open) => events.menu(id, open)}
              />
            )}
          </td>
        </tr>
      )}
    </ResourceItemMenu>
  );
});
