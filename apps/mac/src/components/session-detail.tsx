import React, { useCallback, useState } from "react";
import {
  LiveControls,
  LiveConversation,
  useLiveStatus,
} from "./live-session.js";
import { DownloadIcon } from "lucide-react";
import type { SessionConflict } from "@portable/protocol";
import type { Project, ProjectResource as Resource } from "../types.js";
import { Button } from "./button.js";
import { IconButton } from "./icon-button.js";
import { ReaderState } from "./skill-state.js";
import { ConflictPanel } from "./conflict-panel.js";
import { CopyLinkButton } from "./copy-link-button.js";
import {
  ResourceMenuButton,
  fileSize,
  resourceViewMenuActions,
} from "./resource-menu.js";
import { useDetailLayout } from "./detail-layout.js";
import { detailFacts, detailMeta, sharingStatus } from "./detail-facts.js";
import { ResourceContent } from "./resource-content.js";
import { SegmentedControl } from "./segmented-control.js";
import { SessionLauncher } from "./session-launcher.js";
import { SessionView } from "./session-view.js";
import { useMemberLabel } from "./member-names.js";
import { SkillActionTooltip } from "./skill-action-tooltip.js";
import { useToasts } from "./toasts.js";
import type { ResourceView } from "./use-resource-view.js";
import type { ResourceActionHandlers } from "./use-resource-actions.js";

export interface SessionDetailProps {
  scope: string;
  resource: Resource;
  title: string;
  project: Project;
  user: string | null;
  deviceId: string;
  busy: boolean;
  accessRequest?: React.ReactNode;
  /** The project's unresolved conflicts; only this session's are shown. */
  conflicts: SessionConflict[];
  view: ResourceView;
  actions: ResourceActionHandlers;
  offline: boolean;
  onError: (message: string) => void;
}

/** The session reader on the shared detail shell. */
export function SessionDetail({
  scope,
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
}: SessionDetailProps) {
  const layout = useDetailLayout();
  const { notify } = useToasts();
  const memberLabel = useMemberLabel(user);
  const author = memberLabel(resource.updatedBy);
  const identity = {
    id: resource.resourceId,
    projectId: project.id,
    userId: user ?? "",
  };
  const enabled = Boolean(
    user &&
    !view.preview &&
    (resource.source === "codex" || resource.source === "claude"),
  );
  const { data, refetch } = useLiveStatus(identity, scope, enabled && !offline);
  // A known publisher can still cancel locally during a network interruption.
  const status =
    enabled && (!offline || (data?.active && resource.owner === user))
      ? data
      : undefined;
  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);
  const [watching, setWatching] = useState(true);
  const live = Boolean(
    !offline && status?.active && status.following && status.episodeId,
  );
  const mode =
    live && watching
      ? "live"
      : view.fullTranscript
        ? "transcript"
        : "conversation";
  const shared = !resource.local && resource.revision > 0;
  const menuActions = resourceViewMenuActions(view, true);
  const notes = [
    resource.local && "This session is on this Mac and hasn’t been shared.",
    resource.localChanges &&
      "Local changes are only on this Mac. Shared links open the last shared snapshot.",
    resource.owner !== user && "Resuming saves your continuation as a copy.",
  ].filter((note): note is string => Boolean(note));

  return (
    <SessionView
      id={resource.resourceId}
      contentKey={resource.files.map((file) => file.hash).join(":")}
      refreshOnMount={Boolean(
        resource.local || resource.localChanges || resource.fork,
      )}
      conflictId={view.preview}
      source={resource.source}
      mode={mode}
      live={
        mode === "live" &&
        status?.episodeId && (
          <LiveConversation
            key={status.episodeId}
            identity={identity}
            episodeId={status.episodeId}
            source={resource.source}
            author={memberLabel(resource.owner)}
            raw={view.rawMarkdown}
            onEnd={refresh}
          />
        )
      }
      raw={view.rawMarkdown}
      transcript={
        <ResourceContent
          inspection={view.inspection}
          error={view.inspectionError}
          onRetry={view.retryInspection}
          changes={false}
          markdown={false}
          tooLarge={({ size, sessionSnapshot }) => (
            <ReaderState
              illustration="preview-unavailable"
              title="Transcript too large to show here"
              message={`This transcript is ${fileSize(size)}. Download the ${sessionSnapshot.conflictId ? "incoming version" : "session"} to read the full transcript.`}
              action={
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    void actions.exportZip(sessionSnapshot, () =>
                      notify({
                        kind: "error",
                        title:
                          "Session changed. Reopen the transcript to download.",
                      }),
                    )
                  }
                >
                  {sessionSnapshot.conflictId
                    ? "Download incoming version"
                    : "Download session"}
                </Button>
              }
            />
          )}
          errorState={
            <ReaderState
              tone={offline ? "status" : "alert"}
              illustration={
                offline ? "file-unavailable-offline" : "preview-unavailable"
              }
              title={
                offline
                  ? "Transcript unavailable offline"
                  : "Couldn’t load the transcript"
              }
              message={offline ? "Reconnect and sync to load it." : undefined}
              action={
                <Button
                  size="sm"
                  variant="tertiary"
                  onClick={view.retryInspection}
                >
                  Retry
                </Button>
              }
            />
          }
        />
      }
      offline={offline}
      shell={{
        layout,
        label: "Session",
        className: "resource-detail--session session-view",
        resource,
        file: view.file,
        menuActions,
        title,
        status: (resource.fork || sharingStatus(resource)) && (
          <div className="detail-status-row">
            {sharingStatus(resource)}
            {resource.fork && (
              <span className="detail-status detail-status--neutral">
                Forked
                {resource.owner === user && (
                  <span className="sr-only">
                    . Opening continues this session; choose Fork and open to
                    create another.
                  </span>
                )}
              </span>
            )}
          </div>
        ),
        meta: detailMeta(resource, author),
        facts: detailFacts(resource, author),
        accessRequest,
        note: (notes.length > 0 || actions.launchError) && (
          <>
            {notes.map((note) => (
              <p className="detail-info-note" key={note}>
                {note}
              </p>
            ))}
            {actions.launchError && (
              <p
                className="detail-info-note detail-info-note--error"
                role="alert"
              >
                {actions.launchError}
              </p>
            )}
          </>
        ),
        infoActions: (
          <div className="detail-info-actions">
            <ResourceMenuButton
              resource={resource}
              file={view.file}
              extraActions={menuActions}
            />
            {shared && (
              <SkillActionTooltip label="Copy session link">
                <CopyLinkButton
                  usageEvent="resource_link_copied"
                  iconOnly
                  nativeTooltip={false}
                  value={`orka://project/${project.id}/${resource.resourceId}`}
                  label="Copy session link"
                  disabled={busy}
                  onError={onError}
                />
              </SkillActionTooltip>
            )}
            <SkillActionTooltip label="Download session">
              <IconButton
                icon={DownloadIcon}
                size="sm"
                variant="tertiary"
                aria-label="Download session"
                disabled={busy}
                onClick={() => void actions.exportZip()}
              />
            </SkillActionTooltip>
          </div>
        ),
        primaryActions: (
          <SessionLauncher
            resource={resource}
            project={project}
            scope={scope}
            busy={busy}
            actions={actions}
            onError={onError}
          />
        ),
        context: (
          <>
            {status?.available && (
              <LiveControls
                key={status.episodeId ?? "inactive"}
                identity={identity}
                scope={scope}
                status={status}
                owner={resource.owner === user}
                onWatch={() => setWatching(true)}
                onChange={refresh}
              />
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
        ),
        toolbar: (
          <SegmentedControl
            label="Session view"
            value={mode}
            options={[
              { value: "conversation", label: "Conversation" },
              { value: "transcript", label: "Transcript" },
              ...(live
                ? [{ value: "live" as const, label: "Live turns" }]
                : []),
            ]}
            onChange={(next) => {
              setWatching(next === "live");
              if (next !== "live")
                view.setFullTranscript(next === "transcript");
            }}
          />
        ),
      }}
    />
  );
}
