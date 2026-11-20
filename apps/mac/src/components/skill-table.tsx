import {
  ArrowDownIcon,
  ArrowUpIcon,
  CircleCheckIcon,
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
import { skillSharedBy } from "./skill-index.js";
import type { SkillStatus } from "./skill-status.js";
import { skillSummaryKey, type SkillSummaries } from "./use-skill-summaries.js";
import "./skill-table.css";

/** How long the pointer rests on a row before its description opens. */
const PEEK_DELAY = 400;
/** Room a description needs under its row before it opens upward instead. */
const PEEK_ROOM = 132;

function SharedBy({ id, name }: { id: string; name: string }) {
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

export function SkillStatusPill({ status }: { status: SkillStatus }) {
  return (
    <span className="skill-status-pill" data-tone={status.tone}>
      <status.icon size={12} aria-hidden="true" />
      {status.label}
    </span>
  );
}

function Peek({
  id,
  skill,
  summary,
  above,
}: {
  id: string;
  skill: Resource;
  summary: SkillSummaries[string] | undefined;
  above: boolean;
}) {
  return (
    <span
      id={id}
      className="skill-table-peek"
      data-side={above ? "above" : "below"}
      role="tooltip"
    >
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
        <span className="skill-table-peek-origin">
          <strong>Global</strong> Imported from your global skills
        </span>
      )}
    </span>
  );
}

export function SkillTable({
  skills,
  summaries,
  user,
  memberName,
  statusOf,
  displayTitle,
  showRepository,
  showSharedBy,
  sort,
  direction,
  onOpen,
}: {
  skills: Resource[];
  summaries: SkillSummaries;
  user: string | null;
  memberName: (id: string) => string;
  statusOf: (skill: Resource) => SkillStatus | null;
  displayTitle: (skill: Resource) => string;
  /** Columns follow the whole collection, so filtering never moves them. */
  showRepository: boolean;
  showSharedBy: boolean;
  sort: IndexSort;
  direction: IndexSortDirection;
  onOpen: (id: string) => void;
}) {
  const peekId = useId();
  const [peek, setPeek] = useState<{ id: string; above: boolean }>();
  const timer = useRef(0);
  // An open row menu owns the row; the description stays out of its way.
  const menuOpen = useRef(false);
  const openPeek = (id: string, row: HTMLElement, delay: number) => {
    window.clearTimeout(timer.current);
    if (menuOpen.current) return;
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
    key: IndexSort,
    label: string,
    Glyph: typeof FileIcon,
    className?: string,
  ) => (
    <th
      scope="col"
      className={className}
      aria-sort={
        sort === key
          ? direction === "asc"
            ? "ascending"
            : "descending"
          : undefined
      }
    >
      <span className="skill-table-heading">
        <Glyph size={14} aria-hidden="true" />
        <span className="skill-table-heading-label">{label}</span>
        {sort === key && <SortArrow size={12} aria-hidden="true" />}
      </span>
    </th>
  );
  return (
    <table
      className="skill-table"
      data-compact-people={showSharedBy || undefined}
    >
      <colgroup>
        <col />
        {showRepository && <col className="skill-table-col-repository" />}
        {showSharedBy && <col className="skill-table-col-person" />}
        <col className="skill-table-col-status" />
        <col className="skill-table-col-actions" />
      </colgroup>
      <thead>
        <tr>
          {heading("title", "Skill", FileIcon)}
          {showRepository && heading("repository", "Repository", FolderIcon)}
          {showSharedBy &&
            heading(
              "author",
              "Shared by",
              UserIcon,
              "skill-table-person-heading",
            )}
          {heading("status", "Status", CircleCheckIcon)}
          <th scope="col">
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {skills.map((skill) => {
          const title = displayTitle(skill);
          const status = statusOf(skill);
          const sharedBy = skillSharedBy(skill, user);
          const Leading = skill.local ? LaptopIcon : UsersIcon;
          const peeking = peek?.id === skill.resourceId;
          return (
            <ResourceItemMenu
              key={skill.resourceId}
              resource={skill}
              flat
              onOpenChange={onMenu}
            >
              {(actions) => (
                <tr
                  onClick={() => onOpen(skill.resourceId)}
                  onPointerEnter={(event) =>
                    openPeek(skill.resourceId, event.currentTarget, PEEK_DELAY)
                  }
                  onPointerLeave={closePeek}
                  onFocus={(event) => {
                    // Keyboard focus only: returning from a skill or closing
                    // a menu restores focus without opening the description.
                    if (event.target.matches(":focus-visible"))
                      openPeek(skill.resourceId, event.currentTarget, 0);
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
                          skill.local
                            ? "On this Mac"
                            : "Shared with the project"
                        }
                      />
                      <button
                        type="button"
                        className="skill-table-open"
                        data-resource-id={skill.resourceId}
                        title={skill.title}
                        aria-describedby={peeking ? peekId : undefined}
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpen(skill.resourceId);
                        }}
                      >
                        {title}
                      </button>
                    </span>
                    {peeking && (
                      <Peek
                        id={peekId}
                        skill={skill}
                        summary={summaries[skillSummaryKey(skill)]}
                        above={peek.above}
                      />
                    )}
                  </th>
                  {showRepository && (
                    <td className="skill-table-repository">
                      {skill.repositoryName && (
                        <span
                          className="skill-table-repository-label"
                          title={skill.repositoryName}
                          aria-label={`Repository: ${skill.repositoryName}`}
                        >
                          <FolderIcon size={12} aria-hidden="true" />
                          <span>{skill.repositoryName}</span>
                        </span>
                      )}
                    </td>
                  )}
                  {showSharedBy && (
                    <td>
                      <SharedBy id={sharedBy} name={memberName(sharedBy)} />
                    </td>
                  )}
                  <td>{status && <SkillStatusPill status={status} />}</td>
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
