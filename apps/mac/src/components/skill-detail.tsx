import React, { useLayoutEffect, useRef, useState } from "react";
import {
  ChecklistIcon,
  DownloadIcon,
  GitPullRequestIcon,
} from "@primer/octicons-react";
import type {
  Project,
  ProjectResource as Resource,
  Snapshot,
} from "../types.js";
import { Button } from "./button.js";
import { IconButton } from "./icon-button.js";
import { CopyLinkButton } from "./copy-link-button.js";
import {
  ResourceMenuButton,
  resourceViewMenuActions,
} from "./resource-menu.js";
import { DetailLayout, useDetailLayout } from "./detail-layout.js";
import {
  DetailDocument,
  EditorActions,
  FileRows,
  MarkdownModeControl,
  factDate,
  fileState,
  metaDate,
} from "./detail-document.js";
import type { SkillMarkdown } from "./skill-markdown.js";
import { skillSharing } from "./skill-sharing.js";
import { sourcePath } from "./project-sources.js";
import { useMemberLabel } from "./member-names.js";
import { SkillActionTooltip } from "./skill-action-tooltip.js";
import { SkillReviewOverlay, type ReviewMode } from "./skill-review-overlay.js";
import { reviewStatus, skillReviewState } from "./skill-review-state.js";
import type { ResourceView } from "./use-resource-view.js";
import type { ResourceActionHandlers } from "./use-resource-actions.js";

const contentSkeleton = (
  <div className="skill-content-skeleton" aria-hidden="true">
    {[74, 100, 95, 90, 64, 100, 96, 88].map((width, index) => (
      <span key={index} style={{ width: `${width}%` }} />
    ))}
  </div>
);

export interface SkillDetailProps {
  resource: Resource;
  /** The display title with SKILL.md frontmatter already applied. */
  title: string;
  skill: (SkillMarkdown & { key: string }) | null;
  project: Project;
  user: string | null;
  busy: boolean;
  accessRequest?: React.ReactNode;
  view: ResourceView;
  actions: ResourceActionHandlers;
  state: Snapshot;
  offline: boolean;
  onRefresh: () => Promise<void>;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
  /** Opens Requests for local skills whose sharing needs review. */
  onGovernance?: () => void;
}

/** The skill reader: the shared detail shell with review and install actions. */
export function SkillDetail({
  resource,
  title,
  skill,
  project,
  user,
  busy,
  accessRequest,
  view,
  actions,
  state,
  offline,
  onRefresh,
  onNotice,
  onError,
  onGovernance,
}: SkillDetailProps) {
  const layout = useDetailLayout();
  const { compact, width } = layout;
  const memberName = useMemberLabel(user);
  const author = memberName(resource.updatedBy);
  const sharing = skillSharing(resource);
  const review = skillReviewState(resource, state, project);
  const status = reviewStatus(review);
  const [overlay, setOverlay] = useState<ReviewMode | null>(null);
  const incomingRef = useRef<HTMLButtonElement>(null);
  const outgoingRef = useRef<HTMLButtonElement>(null);
  const editorRef = useRef<HTMLButtonElement>(null);

  // SKILL.md is the expected entry point even if its manifest entry is missing.
  const paths = resource.files.map((file) => file.path);
  if (!paths.includes("SKILL.md")) paths.unshift("SKILL.md");
  paths.sort((a, b) => (a === "SKILL.md" ? -1 : b === "SKILL.md" ? 1 : 0));
  const file = fileState(resource, view, paths);
  const rawForced = view.file === "SKILL.md" && skill?.invalid === true;
  const editorPath = sourcePath(project, resource.sourceId);
  const shared = !resource.local && resource.revision > 0;
  const firstApproval = resource.local && resource.sharing === "approval";
  const sharedAccessRequest =
    resource.local || review.pending ? null : accessRequest;
  const installedRevision = review.binding?.base?.revision;
  const versionLabel =
    review.incoming &&
    installedRevision !== undefined &&
    installedRevision !== resource.revision
      ? `${resource.revision} shared · ${installedRevision} on this Mac`
      : String(resource.revision);
  const description = skill?.description ?? "";

  // Compact readers clamp long descriptions and offer Show more.
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const descriptionRef = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const element = descriptionRef.current;
    if (!element || !compact || expanded) {
      if (!compact) setOverflowing(false);
      return;
    }
    setOverflowing(element.scrollHeight > element.clientHeight + 1);
  }, [compact, expanded, description, width]);

  const menuActions = resourceViewMenuActions(view, false);
  const infoActions = (
    <div className="detail-info-actions">
      <ResourceMenuButton
        resource={resource}
        file={view.file}
        extraActions={menuActions}
        label="More skill actions"
      />
      {review.incoming && (
        <SkillActionTooltip label="Review local update">
          <span className="skill-action-badge">
            <IconButton
              ref={incomingRef}
              icon={ChecklistIcon}
              size="sm"
              variant="tertiary"
              aria-label={
                review.incomingBlocked
                  ? "Review local update. Local edits need install review"
                  : "Review local update"
              }
              disabled={busy}
              onClick={() => setOverlay("incoming")}
            />
            {review.incomingBlocked && (
              <span className="skill-action-dot" aria-hidden="true" />
            )}
          </span>
        </SkillActionTooltip>
      )}
      {review.outgoing && (
        <SkillActionTooltip label="Review local edits">
          <IconButton
            ref={outgoingRef}
            icon={GitPullRequestIcon}
            size="sm"
            variant="tertiary"
            aria-label="Review local edits"
            disabled={busy}
            onClick={() => setOverlay("outgoing")}
          />
        </SkillActionTooltip>
      )}
      {shared && (
        <SkillActionTooltip label="Copy skill link">
          <CopyLinkButton
            iconOnly
            nativeTooltip={false}
            value={`orka://project/${project.id}/${resource.resourceId}`}
            label="Copy skill link"
            disabled={busy}
            onError={onError}
          />
        </SkillActionTooltip>
      )}
      {shared && (
        <SkillActionTooltip label="Export ZIP">
          <IconButton
            icon={DownloadIcon}
            size="sm"
            variant="tertiary"
            aria-label="Export ZIP"
            disabled={busy}
            onClick={() => void actions.exportZip()}
          />
        </SkillActionTooltip>
      )}
    </div>
  );
  const localNote =
    resource.local && !firstApproval ? (
      <p className="detail-info-note">
        <span>{sharing.message}</span>
        {project.governed &&
          project.sharing?.skill !== false &&
          sharing.reviewable &&
          onGovernance && (
            <Button size="sm" variant="tertiary" onClick={onGovernance}>
              Review changes
            </Button>
          )}
      </p>
    ) : null;

  return (
    <DetailLayout
      layout={layout}
      label="Skill"
      className="resource-detail--skill"
      resource={resource}
      file={view.file}
      menuActions={menuActions}
      title={title}
      status={
        <>
          {status && (
            <span className={`detail-status detail-status--${status.tone}`}>
              {status.label}
            </span>
          )}
          {resource.local && (
            <span
              className={`detail-status detail-status--${resource.sharing === "approval" ? "warning" : "neutral"}`}
            >
              {sharing.label}
            </span>
          )}
        </>
      }
      titleBadge={
        resource.global && <span className="skill-origin-badge">Global</span>
      }
      summary={
        <>
          {description && (
            <p
              ref={descriptionRef}
              className={`skill-description${
                compact && !expanded ? " skill-description--clamped" : ""
              }`}
            >
              {description}
            </p>
          )}
          {compact && (overflowing || expanded) && (
            <Button
              size="sm"
              variant="tertiary"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "Show less" : "Show more"}
            </Button>
          )}
        </>
      }
      meta={
        <>
          Updated by {author} · {metaDate(resource.updatedAt)} ·{" "}
          {resource.local ? sharing.label : `Version ${versionLabel}`}
        </>
      }
      facts={[
        { label: "Updated by", value: author },
        {
          label: "Updated at",
          value: (
            <time dateTime={resource.updatedAt}>
              {factDate(resource.updatedAt)}
            </time>
          ),
        },
        ...(firstApproval
          ? []
          : resource.local
            ? [{ label: "Source", value: sharing.label }]
            : [{ label: "Version", value: versionLabel }]),
      ]}
      accessRequest={sharedAccessRequest}
      note={localNote}
      infoActions={infoActions}
      primaryActions={
        <EditorActions
          resource={resource}
          view={view}
          state={file}
          busy={busy}
          offline={offline}
          connected={!!editorPath}
          onOpen={(path) => void actions.openEditor(path)}
          editorRef={editorRef}
        />
      }
      context={
        <>
          {!editorPath && (
            <p className="detail-context">
              Reconnect the project folder in Settings to open files in your
              editor.
            </p>
          )}
          {rawForced && (
            <p className="detail-context">
              Couldn’t read skill metadata. Showing the original file.
            </p>
          )}
        </>
      }
      toolbar={
        file.kind.language === "markdown" && (
          <MarkdownModeControl view={view} state={file} forced={rawForced} />
        )
      }
      toolbarForced={rawForced}
      toolbarUnavailable={
        file.pending || !!view.inspectionError || !file.listed
      }
      files={{
        count: paths.length,
        rows: (
          <FileRows
            paths={paths}
            view={view}
            missing={(path) =>
              !resource.files.some((entry) => entry.path === path) ||
              (path === view.file && file.missing)
            }
          />
        ),
      }}
      overlay={
        overlay && (
          <SkillReviewOverlay
            mode={overlay}
            project={project}
            resource={resource}
            state={state}
            onClose={() => setOverlay(null)}
            onRefresh={onRefresh}
            onNotice={onNotice}
            onCloseAutoFocus={(event) => {
              // Return focus to the opener explicitly: WebKit does not focus a
              // clicked button, so the captured active element can be the body.
              const trigger =
                overlay === "incoming"
                  ? incomingRef.current
                  : outgoingRef.current;
              event.preventDefault();
              (trigger?.isConnected ? trigger : editorRef.current)?.focus();
            }}
          />
        )
      }
    >
      <DetailDocument
        id="skill-content"
        view={view}
        state={file}
        offline={offline}
        othersMessage="You can still open the other skill files."
        skeleton={contentSkeleton}
      />
    </DetailLayout>
  );
}
