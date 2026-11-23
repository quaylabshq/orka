import {
  CopyIcon,
  FolderIcon,
  FolderSearchIcon,
  LinkIcon,
  PlusIcon,
  TrashIcon,
  UnplugIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ItemContextMenu,
  ItemMenuButton,
  type ItemMenuAction,
} from "../item-menu.js";
import { RepositoryConnections } from "../repository-connections.js";
import { CopyLinkButton } from "../copy-link-button.js";
import type { Project, Snapshot } from "../../types.js";
import { Button } from "../button.js";
import { Icon } from "../icon.js";
import { IconButton } from "../icon-button.js";
import { TextField } from "../text-field.js";
import { useConnectProject } from "../use-project-setup.js";
import { activeSources } from "../project-sources.js";
import { SourceSyncButton } from "../source-sync-button.js";
import { useSettingsQuery } from "./use-settings-query.js";
import { useToastNotice } from "../toasts.js";
import { CodexTrustNotices } from "./codex-trust-notices.js";

export function SettingsGeneral({
  project,
  name,
  busy,
  onName,
}: {
  project: Project;
  name: string | null;
  busy: boolean;
  onName: (name: string | null) => void;
}) {
  const [copyError, setCopyError] = useState("");
  return (
    <>
      <div className="settings-project-name">
        <TextField
          label="Project name"
          size="lg"
          hint={
            project.role === "owner"
              ? "Changes rename this project for everyone."
              : name === null
                ? "Uses the shared name. Changes apply only on this Mac."
                : "Only on this Mac. Shared renames won’t replace this name."
          }
          value={name ?? project.name}
          maxLength={100}
          disabled={busy}
          onChange={(event) => onName(event.target.value)}
        />
        {project.role === "owner" && (
          <Button
            size="lg"
            disabled={busy || name === project.name}
            onClick={() => onName(project.name)}
          >
            Reset to default
          </Button>
        )}
        {project.role !== "owner" && name !== null && (
          <Button size="lg" disabled={busy} onClick={() => onName(null)}>
            Use shared name
          </Button>
        )}
      </div>
      <TextField
        label="Project ID"
        size="lg"
        value={project.id}
        readOnly
        trailing={
          <CopyLinkButton
            value={project.id}
            label="Copy Project ID"
            icon={CopyIcon}
            iconOnly
            onError={(error) => setCopyError(error)}
          />
        }
      />
      {copyError && <p role="alert">{copyError}</p>}
    </>
  );
}

export function SettingsFolder({
  project,
  state,
  queued,
  busy,
  onConnect,
  onDisconnect,
  onDisconnectSource,
  onRemoveSource,
  onResetSourceRemote,
  onSyncActivity,
  run,
}: {
  project: Project;
  state: Snapshot;
  queued: number;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onDisconnectSource: (sourceId: string) => void;
  onRemoveSource: (sourceId: string) => void;
  onResetSourceRemote: (sourceId: string) => void;
  onSyncActivity: () => void;
  run: (action: () => Promise<unknown>) => Promise<unknown>;
}) {
  const connectProject = useConnectProject();
  const user = state.user,
    service = state.config?.apiUrl;
  const notice = useToastNotice();
  const loadCapabilities = useCallback(async () => {
    const capabilities = await invoke<{
      sourcesRemoval?: number;
      sourceRemoteKey?: number;
    }>("settings_command", {
      action: "capabilities",
      context: { user, service },
    });
    return { user, service, capabilities };
  }, [user, service]);
  const { data } = useSettingsQuery(loadCapabilities);
  const ownerCapabilities =
    project.role === "owner" && data?.user === user && data?.service === service
      ? data?.capabilities
      : undefined;
  const canRemove = ownerCapabilities?.sourcesRemoval === 1;
  const canReset = ownerCapabilities?.sourceRemoteKey === 1;
  const sources: NonNullable<Project["sources"]> = project.sources
    ? activeSources(project.sources)
    : [
        {
          id: "",
          name: project.path?.split("/").filter(Boolean).at(-1) ?? project.name,
          path: project.path,
          folderState: project.folderState,
        },
      ];
  return (
    <>
      <RepositoryConnections
        project={project}
        state={state}
        refresh={() => run(async () => {})}
        folderBusy={busy}
        queued={queued}
        onDisconnectSource={onDisconnectSource}
        onRemoveSource={canRemove ? onRemoveSource : undefined}
        onResetSourceRemote={canReset ? onResetSourceRemote : undefined}
        onLocalFolder={async () => {
          let connected = false;
          await run(async () => {
            connected = await connectProject(project.id);
          });
          return connected;
        }}
        renderLocalFolders={(enabled, onLink) => (
          <div
            className={
              enabled
                ? "repository-local-folders"
                : "settings-group settings-source-list"
            }
          >
            {sources
              .filter((source) => !enabled || !source.repository)
              .map((source) => {
                const folderState = source.path
                  ? (source.folderState ?? "connected")
                  : "locate";
                // Legacy single-folder projects have no per-source count.
                const pending = source.queuedChanges ?? queued;
                const connect = () =>
                  source.id
                    ? void run(() =>
                        connectProject(
                          project.id,
                          source.id,
                          source.path ?? undefined,
                        ),
                      )
                    : onConnect();
                const actions: ItemMenuAction[] = [];
                const canLocate =
                  folderState === "locate" || folderState === "reconnect";
                if (canLocate)
                  actions.push({
                    id: "connect",
                    icon: FolderSearchIcon,
                    label:
                      folderState === "locate"
                        ? "Locate Folder"
                        : "Reconnect folder",
                    disabled: busy,
                    onSelect: connect,
                  });
                if (source.id && source.path) {
                  const input = {
                    accountId: state.user,
                    serviceOrigin: state.config?.apiUrl,
                    projectId: project.id,
                    sourceId: source.id,
                  };
                  actions.push(
                    {
                      id: "reveal",
                      label: "Show in Finder",
                      icon: FolderIcon,
                      disabled: busy,
                      onSelect: () =>
                        void run(() =>
                          invoke("resource_command", {
                            action: "reveal",
                            input,
                          }),
                        ),
                    },
                    {
                      id: "copy-path",
                      label: "Copy folder path",
                      icon: CopyIcon,
                      disabled: busy,
                      onSelect: () =>
                        void run(async () => {
                          const result = await invoke<{ paths: string[] }>(
                            "resource_command",
                            { action: "paths", input },
                          );
                          await navigator.clipboard.writeText(
                            result.paths.join("\n"),
                          );
                          notice("Folder path copied");
                        }),
                    },
                  );
                }
                if (source.id && enabled && project.role === "owner")
                  actions.push({
                    id: "link",
                    label: "Link GitHub repository",
                    icon: LinkIcon,
                    disabled: busy,
                    onSelect: () => onLink(source),
                  });
                actions.push({
                  id: "disconnect",
                  label: "Disconnect folder on this Mac",
                  icon: UnplugIcon,
                  disabled: busy || pending > 0 || !source.path,
                  reason:
                    pending > 0
                      ? "Let this folder's changes sync before disconnecting"
                      : !source.path
                        ? "Connect this folder before disconnecting"
                        : undefined,
                  separator: actions.length > 0,
                  onSelect: () =>
                    source.id ? onDisconnectSource(source.id) : onDisconnect(),
                });
                if (canReset && source.remoteKey)
                  actions.push({
                    id: "reset-repository",
                    label: "Reset Git repository",
                    icon: LinkIcon,
                    disabled: busy,
                    onSelect: () => onResetSourceRemote(source.id),
                  });
                if (canRemove && source.id)
                  actions.push({
                    id: "remove",
                    label: "Remove source folder",
                    icon: TrashIcon,
                    danger: true,
                    disabled: busy || queued > 0,
                    reason:
                      queued > 0
                        ? "Sync queued changes before removing a source"
                        : undefined,
                    onSelect: () => onRemoveSource(source.id),
                  });
                return (
                  <ItemContextMenu
                    key={source.id}
                    actions={actions}
                    label={`Options for ${source.name}`}
                  >
                    <div className="settings-folder-row">
                      <div className="settings-folder-identity">
                        <Icon
                          icon={FolderIcon}
                          className="settings-folder-icon"
                        />
                        <span
                          className="settings-folder-name"
                          title={source.path ?? undefined}
                        >
                          {source.name}
                        </span>
                        {folderState === "repository-conflict" && (
                          <span
                            className="settings-folder-hint"
                            title="This folder does not match the project's saved Git repository. A project owner can use Reset Git repository."
                          >
                            Sync paused · Git repository mismatch
                          </span>
                        )}
                        {source.path && source.gitRepository === false && (
                          <span
                            className="settings-folder-hint"
                            title="Orka matches folders across Macs by their Git repository. Check this is the project's folder."
                          >
                            Not a Git repository
                          </span>
                        )}
                      </div>
                      <div className="settings-folder-actions">
                        {source.id &&
                          source.path &&
                          source.syncStartsAt &&
                          folderState === "connected" && (
                            <SourceSyncButton
                              name={source.name}
                              startsAt={source.syncStartsAt}
                              disabled={busy}
                              onStart={() =>
                                void run(() =>
                                  invoke("start_source_sync", {
                                    id: project.id,
                                    sourceId: source.id,
                                  }),
                                )
                              }
                            />
                          )}
                        {canLocate && (
                          <Button
                            variant={
                              folderState === "locate" ? "primary" : "secondary"
                            }
                            size="sm"
                            className={
                              folderState === "reconnect"
                                ? "settings-folder-reconnect"
                                : undefined
                            }
                            disabled={busy}
                            aria-label={`${folderState === "locate" ? "Locate Folder for" : "Reconnect"} ${source.name}${folderState === "locate" ? "" : " folder"}`}
                            onClick={connect}
                          >
                            {folderState === "locate"
                              ? "Locate Folder"
                              : "Reconnect"}
                          </Button>
                        )}
                        {source.id ? (
                          <ItemMenuButton
                            actions={actions}
                            label={`Options for ${source.name}`}
                            disabled={busy}
                          />
                        ) : (
                          <IconButton
                            icon={XIcon}
                            variant="tertiary"
                            size="sm"
                            aria-label={`Disconnect ${source.name} folder`}
                            title={
                              !source.path
                                ? "Connect this folder before disconnecting"
                                : pending > 0
                                  ? "Let this folder's changes sync before disconnecting"
                                  : "Disconnect folder on this Mac"
                            }
                            disabled={busy || pending > 0 || !source.path}
                            onClick={() =>
                              source.id
                                ? onDisconnectSource(source.id)
                                : onDisconnect()
                            }
                          />
                        )}
                      </div>
                    </div>
                  </ItemContextMenu>
                );
              })}
            {!enabled && sources.length === 0 && project.role !== "owner" && (
              <p className="settings-folder-empty">
                No source folders added yet.
              </p>
            )}
            {!enabled && project.role === "owner" && (
              <div className="settings-add-folder-row">
                <Button
                  variant="tertiary"
                  className="settings-add-folder"
                  disabled={busy}
                  onClick={onConnect}
                >
                  <Icon icon={PlusIcon} />
                  <span className="settings-add-folder-label">Add Folder</span>
                </Button>
              </div>
            )}
          </div>
        )}
      />
      <CodexTrustNotices
        project={project}
        user={user}
        service={service}
        busy={busy}
      />
      {sources.some(
        (source) => source.path && (source.queuedChanges ?? queued) > 0,
      ) && (
        <div className="settings-notice settings-folder-notice">
          <p>Folders with unsent changes can be disconnected once they sync.</p>
          <Button size="sm" onClick={onSyncActivity}>
            View sync activity
          </Button>
        </div>
      )}
    </>
  );
}
