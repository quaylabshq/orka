import React from "react";
import { DownloadIcon } from "lucide-react";
import type { SessionConflict } from "@portable/protocol";
import type { Project, ProjectResource as Resource } from "../types.js";
import { IconButton } from "./icon-button.js";
import { ConflictPanel } from "./conflict-panel.js";
import { CopyLinkButton } from "./copy-link-button.js";
import { ResourceContent } from "./resource-content.js";
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
  fileState,
} from "./detail-document.js";
import { detailFacts, detailMeta, sharingStatus } from "./detail-facts.js";
import { sourcePath } from "./project-sources.js";
import { useMemberLabel } from "./member-names.js";
import { SkillActionTooltip } from "./skill-action-tooltip.js";
import type { ResourceView } from "./use-resource-view.js";
import type { ResourceActionHandlers } from "./use-resource-actions.js";

export interface MemoryDetailProps {
  resource: Resource;
  title: string;
  project: Project;
  user: string | null;
  deviceId: string;
  busy: boolean;
  accessRequest?: React.ReactNode;
  /** The project's unresolved conflicts; only this resource's are shown. */
  conflicts: SessionConflict[];
  view: ResourceView;
  actions: ResourceActionHandlers;
  offline: boolean;
  onError: (message: string) => void;
}

/** The memory and plan reader on the shared detail shell. */
export function MemoryDetail({
  resource,
  title,
  project,
  user,
  deviceId,
  busy,
  accessRequest,
  conflicts,
  view,
  actions,
  offline,
  onError,
}: MemoryDetailProps) {
  const layout = useDetailLayout();
  const author = useMemberLabel(user)(resource.updatedBy);
  const plan = resource.kind === "plan";
  const noun = plan ? "plan" : "memory";
  const paths = resource.files.map((file) => file.path);
  const file = fileState(resource, view, paths);
  const editorPath = sourcePath(project, resource.sourceId);
  const shared = !resource.local && resource.revision > 0;
  const menuActions = resourceViewMenuActions(view, false);
  const note = resource.local
    ? `This ${noun} is on this Mac and hasn’t been shared.`
    : resource.localChanges
      ? "Local changes are only on this Mac. Shared links open the last shared snapshot."
      : "";

  return (
    <DetailLayout
      layout={layout}
      label={plan ? "Plan" : "Memory"}
      className="resource-detail--memory"
      resource={resource}
      file={view.file}
      menuActions={menuActions}
      title={title}
      status={sharingStatus(resource)}
      meta={detailMeta(resource, author)}
      facts={detailFacts(resource, author)}
      accessRequest={accessRequest}
      note={note && <p className="detail-info-note">{note}</p>}
      infoActions={
        <div className="detail-info-actions">
          <ResourceMenuButton
            resource={resource}
            file={view.file}
            extraActions={menuActions}
          />
          {shared && (
            <SkillActionTooltip label={`Copy ${noun} link`}>
              <CopyLinkButton
                usageEvent="resource_link_copied"
                iconOnly
                nativeTooltip={false}
                value={`orka://project/${project.id}/${resource.resourceId}`}
                label={`Copy ${noun} link`}
                disabled={busy}
                onError={onError}
              />
            </SkillActionTooltip>
          )}
          {shared && plan && (
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
      }
      primaryActions={
        <EditorActions
          resource={resource}
          view={view}
          state={file}
          busy={busy}
          offline={offline}
          connected={!!editorPath}
          onOpen={(path) => void actions.openEditor(path)}
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
          {conflicts
            .filter((conflict) => conflict.resourceId === resource.resourceId)
            .map((conflict) => (
              <ConflictPanel
                key={conflict.id}
                conflict={conflict}
                deviceId={deviceId}
                user={user}
                owner={resource.owner}
                busy={busy}
                preview={view.preview}
                onPreview={view.setPreview}
                onResolve={(action, conflictId, selected) =>
                  void actions.sessionAction(action, conflictId, selected)
                }
              />
            ))}
        </>
      }
      toolbar={
        file.kind.language === "markdown" && (
          <MarkdownModeControl view={view} state={file} />
        )
      }
      toolbarUnavailable={
        file.pending || !!view.inspectionError || !file.listed
      }
      files={
        paths.length > 1
          ? {
              count: paths.length,
              rows: (
                <FileRows paths={paths} view={view} missing={() => false} />
              ),
            }
          : undefined
      }
    >
      <DetailDocument
        id="resource-content"
        view={view}
        state={file}
        offline={offline}
        othersMessage="You can still open the other files."
        comparisonFallback={
          <ResourceContent
            inspection={view.inspection}
            changes
            markdown={false}
          />
        }
      />
    </DetailLayout>
  );
}
