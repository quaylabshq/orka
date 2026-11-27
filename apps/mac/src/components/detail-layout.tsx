import React, { useId } from "react";
import type {
  ProjectResource as Resource,
  SessionSnapshotSelection,
} from "../types.js";
import { Button } from "./button.js";
import { Icon } from "./icon.js";
import type { IconGlyph } from "./icons.js";
import type { ItemMenuAction } from "./item-menu.js";
import { ActionPopover } from "./resource-actions.js";
import { ResourceItemMenu } from "./resource-menu.js";
import { useElementWidth } from "../hooks/use-element-width.js";

/** Below this width the rail folds into the single-column layout. */
export const COMPACT_WIDTH = 840;

/** Measures the detail shell so a reader can adapt before the shell renders. */
export function useDetailLayout() {
  const [ref, width] = useElementWidth<HTMLElement>();
  return { ref, width, compact: width > 0 && width < COMPACT_WIDTH };
}

export interface DetailFact {
  label: string;
  value: React.ReactNode;
  icon?: IconGlyph;
}

export interface DetailLayoutProps {
  layout: ReturnType<typeof useDetailLayout>;
  /** Names the reader: “Skill details”, “Skill info”, “Skill information”. */
  label: "Memory" | "Plan" | "Session" | "Skill" | "Review";
  /** The info card heading when it is not “{label} info”. */
  infoLabel?: string;
  /** Kind-specific class names added to the shell. */
  className: string;
  /** The item whose context menu the reader offers; a review has none. */
  resource?: Resource;
  file?: string;
  /** The selected conflict version's download, or null when that side was removed. */
  sessionSelection?: SessionSnapshotSelection | null;
  menuActions?: ItemMenuAction[];
  title: string;
  /** Status chips above the title. */
  status?: React.ReactNode;
  /** A badge beside the title, such as Global. */
  titleBadge?: React.ReactNode;
  /** Content under the title. Readers with one get the filled title card. */
  summary?: React.ReactNode;
  /** The one-line facts shown under the title card when compact. */
  meta: React.ReactNode;
  facts: DetailFact[];
  /** Shown beside the reading-mode control; may render nothing. */
  accessRequest?: React.ReactNode;
  /** Notes under the facts, or under the meta line when compact. */
  note?: React.ReactNode;
  /** Icon actions in the info heading. */
  infoActions?: React.ReactNode;
  /** The main buttons at the bottom of the info card. */
  primaryActions: React.ReactNode;
  /** Notices and panels between the title card and the content. */
  context?: React.ReactNode;
  /** The reading-mode control above the content. */
  toolbar?: React.ReactNode;
  toolbarForced?: boolean;
  toolbarUnavailable?: boolean;
  /** The file switcher: a rail card when wide, a popover when compact. */
  files?: { rows: React.ReactNode; count: number };
  /** The scrolling reading column, for readers that window their content. */
  readerRef?: React.Ref<HTMLDivElement>;
  bodyClassName?: string;
  children: React.ReactNode;
  overlay?: React.ReactNode;
}

/**
 * The shared detail shell for memories, plans, sessions, and skills: a reading
 * column beside a 360px information rail, folding into one column when narrow.
 */
export function DetailLayout({
  layout,
  label,
  infoLabel,
  className,
  resource,
  file,
  sessionSelection,
  menuActions,
  title,
  status,
  titleBadge,
  summary,
  meta,
  facts,
  accessRequest,
  note,
  infoActions,
  primaryActions,
  context,
  toolbar,
  toolbarForced,
  toolbarUnavailable,
  files,
  readerRef,
  bodyClassName = "detail-document",
  children,
  overlay,
}: DetailLayoutProps) {
  const { compact } = layout;
  const infoHeadingId = useId();
  const filesHeadingId = useId();
  // Beside the reading-mode control: the access request, and the file menu
  // when compact. It collapses when both are absent.
  const toolbarEnd = (
    <div className="detail-toolbar-end">
      {accessRequest}
      {compact && files && (
        <ActionPopover
          label="Files"
          align="end"
          className="detail-files-popover"
          trigger={
            <Button
              size="sm"
              variant="tertiary"
              aria-label={`Files, ${files.count}`}
            >
              Files · {files.count}
            </Button>
          }
        >
          <ul className="detail-file-list">{files.rows}</ul>
        </ActionPopover>
      )}
    </div>
  );
  const shell = (
    <section
      ref={layout.ref}
      className={`resource-detail ${className} detail-layout`}
      data-layout={compact ? "compact" : "wide"}
      aria-label={`${label} details`}
    >
      <div className="detail-reader" ref={readerRef}>
        <div
          className={`detail-title-card${summary ? "" : " detail-title-card--plain"}`}
        >
          {status}
          <div className="detail-title-row">
            <h2 className="detail-title">{title}</h2>
            {titleBadge}
          </div>
          {summary}
        </div>
        {compact && (
          <>
            <p className="detail-meta">{meta}</p>
            {note && <div className="detail-compact-notes">{note}</div>}
            <div className="detail-compact-actions">
              <div className="detail-actions-inline">{primaryActions}</div>
              {infoActions}
            </div>
          </>
        )}
        {context}
        {toolbar ? (
          <div
            className="detail-toolbar"
            data-forced-markdown={toolbarForced || undefined}
            data-unavailable={toolbarUnavailable || undefined}
          >
            <div className="detail-toolbar-start">{toolbar}</div>
            {toolbarEnd}
          </div>
        ) : (
          toolbarEnd
        )}
        <div className={bodyClassName}>{children}</div>
      </div>
      {!compact && (
        <aside className="detail-rail" aria-label={`${label} information`}>
          <section
            className="detail-card detail-info"
            aria-labelledby={infoHeadingId}
          >
            <div className="detail-info-body">
              <div className="detail-info-heading">
                <h2 id={infoHeadingId} className="detail-card-label">
                  {infoLabel ?? `${label} info`}
                </h2>
                {infoActions}
              </div>
              <dl className="detail-facts">
                {facts.map((fact) => (
                  <div className="detail-fact" key={fact.label}>
                    <dt>
                      {fact.icon && (
                        <Icon icon={fact.icon} size="sm" variant="tertiary" />
                      )}
                      {fact.label}
                    </dt>
                    <dd>{fact.value}</dd>
                  </div>
                ))}
              </dl>
              {note}
            </div>
            <div className="detail-actions">{primaryActions}</div>
          </section>
          {files && (
            <section
              className="detail-card detail-files"
              aria-labelledby={filesHeadingId}
            >
              <div className="detail-files-heading">
                <h2 id={filesHeadingId}>Files</h2>
                <span className="detail-files-count">
                  <span className="sr-only">
                    {files.count} {files.count === 1 ? "file" : "files"}
                  </span>
                  <span aria-hidden="true">{files.count}</span>
                </span>
              </div>
              <ul className="detail-file-list">{files.rows}</ul>
            </section>
          )}
        </aside>
      )}
      {overlay}
    </section>
  );
  return resource ? (
    <ResourceItemMenu
      resource={resource}
      file={file}
      sessionSelection={sessionSelection}
      extraActions={menuActions ?? []}
    >
      {() => shell}
    </ResourceItemMenu>
  ) : (
    shell
  );
}
