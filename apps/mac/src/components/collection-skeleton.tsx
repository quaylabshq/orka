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
import React from "react";
import type {
  IndexColumn,
  IndexPage,
  IndexSort,
  IndexSortDirection,
} from "./index-pages.js";
import "./index-table.css";
import "./collection-skeleton.css";

/** Mirrors collection rows without exposing sample content or focusable actions. */
export function CollectionSkeleton() {
  return (
    <div className="collection-skeleton" aria-hidden="true">
      <div className="collection-skeleton-rows">
        {[68, 88, 54, 76, 62, 82].map((width, index) => (
          <div className="collection-skeleton-row" key={index}>
            <div className="collection-skeleton-title">
              <span style={{ width: `${width}%` }} />
              <span style={{ width: `${width / 2}%` }} />
            </div>
            <span className="collection-skeleton-source" />
            <span className="collection-skeleton-author" />
            <span className="collection-skeleton-date" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Each column's heading, as the index table names it. */
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

/** Bar widths in pixels; a status shows on only some rows, as in a real list. */
const rows: (Record<"title" | Exclude<IndexColumn, "status">, number> & {
  status?: number;
})[] = [
  { title: 150, agent: 48, repository: 70, person: 60, updated: 44 },
  {
    title: 190,
    agent: 48,
    repository: 96,
    person: 50,
    updated: 44,
    status: 108,
  },
  { title: 120, agent: 48, repository: 70, person: 60, updated: 44 },
  { title: 170, agent: 48, repository: 96, person: 60, updated: 44 },
  {
    title: 140,
    agent: 48,
    repository: 148,
    person: 50,
    updated: 44,
    status: 90,
  },
  { title: 200, agent: 48, repository: 70, person: 50, updated: 44 },
  {
    title: 130,
    agent: 48,
    repository: 96,
    person: 60,
    updated: 44,
    status: 120,
  },
  { title: 160, agent: 48, repository: 70, person: 50, updated: 44 },
];

const Bar = ({ width }: { width?: number }) =>
  width ? <span className="collection-skeleton-bar" style={{ width }} /> : null;

/** The index table's own header over placeholder rows, while a list loads. */
export function IndexTableSkeleton({
  page,
  showRepository,
  sort,
  direction,
}: {
  page: IndexPage;
  showRepository: boolean;
  sort: IndexSort;
  direction: IndexSortDirection;
}) {
  // Nothing has loaded, so no one else is credited yet and the table has no
  // person column.
  const columns = page.columns.filter(
    (column) =>
      column !== "person" && (column !== "repository" || showRepository),
  );
  const SortArrow = direction === "asc" ? ArrowUpIcon : ArrowDownIcon;
  const heading = (
    key: IndexSort | undefined,
    label: string,
    Glyph: typeof FileIcon,
    className?: string,
  ) => (
    <th key={label} scope="col" className={className}>
      <span className="index-table-heading">
        <Glyph size={14} aria-hidden="true" />
        <span className="index-table-heading-label">{label}</span>
        {key && sort === key && <SortArrow size={12} aria-hidden="true" />}
      </span>
    </th>
  );
  return (
    <div className="collection-skeleton" aria-hidden="true">
      <table className="index-table" data-kind={page.kind}>
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
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              <td>
                <Bar width={row.title} />
              </td>
              {columns.map((column) => (
                <td
                  key={column}
                  className={
                    column === "updated" ? "index-table-updated" : undefined
                  }
                >
                  <Bar width={row[column]} />
                </td>
              ))}
              <td />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
