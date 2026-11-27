import {
  CopyIcon,
  ExternalLinkIcon,
  FolderIcon,
  FolderSearchIcon,
  Link2OffIcon,
  PlusIcon,
  RefreshCwIcon,
  TrashIcon,
  UnplugIcon,
  XIcon,
} from "lucide-react";
import {
  CircleCheckFilledIcon,
  DotFilledIcon,
  TriangleAlertFilledIcon,
} from "./icons.js";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { invoke } from "./product-command.js";
import type { RepositoryAccessRequest } from "@portable/protocol";
import type { Project, Snapshot } from "../types.js";
import { Button } from "./button.js";
import { SourceSyncButton } from "./source-sync-button.js";
import { PermissionSelect } from "./permission-select.js";
import { IconButton } from "./icon-button.js";
import { TextField } from "./text-field.js";
import { Modal } from "./modal.js";
import {
  ItemContextMenu,
  ItemMenuButton,
  type ItemMenuAction,
} from "./item-menu.js";
import { useConnectProject } from "./use-project-setup.js";
import {
  RepositoryPicker,
  type RepositorySource,
} from "./repository-picker.js";
import { useRepositories, useRepositoryCommand } from "./use-repositories.js";
import { LoadingRegion } from "./loading-region.js";
import { activeSources } from "./project-sources.js";
import { useToastNotice } from "./toasts.js";
export { useRepositoryCommand } from "./use-repositories.js";

type ConnectionDialog = {
  kind: "connect" | "request";
  source?: RepositorySource;
} | null;
export function RepositoryConnections({
  project,
  state,
  refresh,
  renderLocalFolders,
  onLocalFolder,
  onDisconnectSource,
  onRemoveSource,
  onResetSourceRemote,
  folderBusy = false,
  queued = 0,
  initiallyOpen = false,
  initialSource,
  dialogOnly = false,
  onClose,
  onConnecting,
}: {
  project: Project;
  state: Snapshot;
  refresh: () => Promise<unknown>;
  renderLocalFolders?: (
    enabled: boolean,
    onLink: (source: RepositorySource) => void,
  ) => ReactNode;
  onLocalFolder?: () => Promise<unknown>;
  onDisconnectSource?: (sourceId: string) => void;
  onRemoveSource?: (sourceId: string) => void;
  onResetSourceRemote?: (sourceId: string) => void;
  folderBusy?: boolean;
  queued?: number;
  initiallyOpen?: boolean;
  initialSource?: RepositorySource;
  dialogOnly?: boolean;
  onClose?: () => void;
  onConnecting?: () => void;
}) {
  const connectProject = useConnectProject();
  const controller = useRepositories(project, state, refresh);
  const {
    call,
    enabled,
    status,
    statusPending,
    busy,
    access,
    jobs,
    run,
    error,
  } = controller;
  const multipleSources =
    activeSources(project.sources).filter(
      (source) =>
        source.repository &&
        (!source.path || source.folderState === "reconnect"),
    ).length > 1;
  const [dialog, setDialog] = useState<ConnectionDialog>(
    initiallyOpen && !multipleSources
      ? { kind: "connect", source: initialSource }
      : null,
  );
  const [reason, setReason] = useState("");
  const [requested, setRequested] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const notify = useToastNotice();
  const denied = Object.values(access).some(
    (value) => value.state === "access_unavailable",
  );
  useEffect(() => {
    if (!denied) return;
    let canceled = false;
    void call<{ items: RepositoryAccessRequest[] }>("requests", {
      projectId: project.id,
    })
      .then((value) => {
        if (!canceled)
          setRequested(
            value.items
              .filter(
                (request) =>
                  request.requester === state.user &&
                  [
                    "requested",
                    "waiting_on_github",
                    "invitation_pending",
                  ].includes(request.status),
              )
              .map((request) => request.sourceId),
          );
      })
      .catch(() => {});
    return () => {
      canceled = true;
    };
  }, [call, denied, project.id, state.user]);
  const close = () => {
    setDialog(null);
    onClose?.();
  };
  const openPicker = (source?: RepositorySource) => {
    setNotice("");
    setDialog({ kind: "connect", source });
  };
  if (!enabled) return <>{renderLocalFolders?.(false, openPicker)}</>;
  const disabled = busy || folderBusy;
  const sources = activeSources(project.sources).filter(
    (source) => source.repository,
  );
  const reconnectSource = sources.find((source) =>
    ["not_connected", "reconnect"].includes(access[source.id]?.state),
  );
  const needsAccountConnection =
    status !== null && (!status.connected || Boolean(reconnectSource));
  const statusUnavailable = !status && !statusPending;
  const checkingConnection =
    statusPending ||
    (status?.connected &&
      !reconnectSource &&
      sources.some((source) => !access[source.id]));
  const dialogUi =
    dialog?.kind === "connect" ? (
      <RepositoryPicker
        project={project}
        source={
          dialog.source
            ? (project.sources?.find(
                (source) => source.id === dialog.source?.id,
              ) ?? dialog.source)
            : undefined
        }
        controller={controller}
        onClose={close}
        onRequestAccess={(source) => {
          setReason("");
          setDialog({ kind: "request", source });
        }}
        onLocalFolder={
          onLocalFolder ??
          (async () => {
            const connected = await connectProject(project.id);
            if (connected) await refresh();
            return connected;
          })
        }
        onConnected={() => {
          close();
          onConnecting?.();
        }}
      />
    ) : (
      dialog?.source && (
        <Modal
          title="Request repository access"
          heading="Request access"
          className="repository-dialog"
          closeLabel="Close access request"
          closeDisabled={busy}
          onClose={() => {
            if (!busy) close();
          }}
          error={error}
          fullWidthError
          footer={
            <Button
              size="sm"
              variant="primary"
              disabled={busy || !reason.trim()}
              onClick={() =>
                void run(async () => {
                  const sourceId = dialog.source!.id;
                  await call("request-access", {
                    projectId: project.id,
                    sourceId,
                    reason,
                  });
                  setRequested((values) => [...values, sourceId]);
                  setNotice(
                    "Access request sent. Follow it in Settings → Members.",
                  );
                  close();
                })
              }
            >
              {busy ? "Sending…" : "Send request"}
            </Button>
          }
        >
          <p>{dialog.source.repository?.fullName}</p>
          <TextField
            label="Reason for repository access"
            maxLength={1000}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <p>A project owner will coordinate access on GitHub.</p>
          <details className="repository-help">
            <summary>Already have repository access?</summary>
            <p>
              Orka may need permission to use this repository. Your organization
              may require approval.
            </p>
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(() => controller.openGitHub(status!.installationUrl))
              }
            >
              Manage GitHub access
            </Button>
          </details>
        </Modal>
      )
    );
  const content = (
    <section
      aria-label="Project repositories"
      className="repository-connections"
    >
      <div className="settings-group settings-source-list">
        {renderLocalFolders?.(true, openPicker)}
        {sources.map((source) => {
          const value = access[source.id];
          const job = jobs.find(
            (job) => job.sourceId === source.id && job.state !== "connected",
          );
          const active =
            job && ["queued", "cloning", "connecting"].includes(job.state);
          const ready = value?.state === "ready";
          const needsGithub =
            value && ["not_connected", "reconnect"].includes(value.state);
          const denied = value?.state === "access_unavailable";
          const failed = value?.state === "unavailable";
          const conflict = source.folderState === "repository-conflict";
          const connected = Boolean(
            source.path && source.folderState !== "reconnect" && !conflict,
          );
          const label = !value
            ? "Checking GitHub access"
            : ready
              ? "GitHub access verified"
              : denied
                ? "GitHub access required"
                : needsGithub
                  ? "Connect GitHub to verify access"
                  : "Could not check GitHub access";
          const StatusIcon = ready
            ? CircleCheckFilledIcon
            : value
              ? TriangleAlertFilledIcon
              : DotFilledIcon;
          const actions: ItemMenuAction[] = [];
          if (active && job.state !== "connecting")
            actions.push({
              id: "cancel",
              label: "Cancel clone",
              icon: XIcon,
              onSelect: () =>
                void run(async () => {
                  await call("cancel-clone", { id: job.id });
                }),
            });
          if (!active) {
            if (connected) {
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
                  disabled,
                  onSelect: () =>
                    void run(async () => {
                      await invoke("resource_command", {
                        action: "reveal",
                        input,
                      });
                    }),
                },
                {
                  id: "copy-path",
                  label: "Copy folder path",
                  icon: CopyIcon,
                  disabled,
                  onSelect: () =>
                    void run(async () => {
                      const result = await invoke<{ paths: string[] }>(
                        "resource_command",
                        { action: "paths", input },
                      );
                      await navigator.clipboard.writeText(
                        result.paths.join("\n"),
                      );
                      notify("Folder path copied");
                    }),
                },
              );
            } else if (!conflict)
              actions.push({
                id: "locate",
                label: "Use existing folder",
                icon: FolderSearchIcon,
                disabled,
                onSelect: () =>
                  void run(async () => {
                    await connectProject(
                      project.id,
                      source.id,
                      source.path ?? undefined,
                    );
                    await refresh();
                  }),
              });
            actions.push({
              id: "github",
              label: "Open repository on GitHub",
              icon: ExternalLinkIcon,
              disabled,
              onSelect: () =>
                void run(async () => {
                  await call("open-github", {
                    url: `https://github.com/${source.repository!.fullName}`,
                  });
                }),
            });
            if (value && !ready)
              actions.push({
                id: "refresh",
                label: "Refresh access",
                icon: RefreshCwIcon,
                disabled,
                onSelect: () => void run(() => controller.recheck(source.id)),
              });
            if (source.path && onDisconnectSource)
              actions.push({
                id: "disconnect",
                label: "Disconnect folder on this Mac",
                icon: UnplugIcon,
                separator: true,
                disabled: disabled || (source.queuedChanges ?? queued) > 0,
                reason:
                  (source.queuedChanges ?? queued) > 0
                    ? "Let this folder's changes sync before disconnecting"
                    : undefined,
                onSelect: () => onDisconnectSource(source.id),
              });
            if (project.role === "owner")
              actions.push({
                id: "unlink",
                label: "Remove GitHub link",
                icon: Link2OffIcon,
                disabled,
                danger: true,
                separator: true,
                onSelect: () =>
                  void run(async () => {
                    await call("unlink", {
                      projectId: project.id,
                      sourceId: source.id,
                      expectedRevision:
                        source.repositoryRevision ??
                        source.repository!.revision,
                    });
                    await refresh();
                  }),
              });
            if (
              project.role === "owner" &&
              source.remoteKey &&
              onResetSourceRemote
            )
              actions.push({
                id: "reset-repository",
                label: "Reset Git repository",
                icon: RefreshCwIcon,
                disabled,
                onSelect: () => onResetSourceRemote(source.id),
              });
            if (project.role === "owner" && onRemoveSource)
              actions.push({
                id: "remove",
                label: "Remove source folder",
                icon: TrashIcon,
                danger: true,
                disabled: disabled || queued > 0,
                reason:
                  queued > 0
                    ? "Sync queued changes before removing a source"
                    : undefined,
                onSelect: () => onRemoveSource(source.id),
              });
          }
          return (
            <ItemContextMenu
              key={source.id}
              actions={actions}
              label={`Options for ${source.name}`}
            >
              <div className="repository-card-row">
                <div className="repository-card-main">
                  <FolderIcon size={18} aria-hidden="true" />
                  <div className="repository-card-identity">
                    <strong>{source.repository!.fullName}</strong>
                    <span className="repository-card-meta">
                      {active
                        ? job.message
                        : conflict
                          ? "Sync paused · Git repository mismatch"
                          : connected
                            ? "Connected on this Mac"
                            : source.folderState === "reconnect"
                              ? "Folder needs reconnecting"
                              : "Not connected on this Mac"}
                    </span>
                  </div>
                  <span
                    className="repository-access-icon"
                    data-state={
                      ready ? "ready" : value ? "warning" : "checking"
                    }
                    role="img"
                    aria-label={label}
                    title={`${label}${value?.checkedAt ? ` · ${new Date(value.checkedAt).toLocaleString()}` : ""}`}
                  >
                    <StatusIcon size={16} />
                  </span>
                  <div className="repository-card-actions">
                    {!active && connected && source.syncStartsAt && (
                      <SourceSyncButton
                        name={source.name}
                        startsAt={source.syncStartsAt}
                        disabled={disabled}
                        onStart={() =>
                          void run(async () => {
                            await invoke("start_source_sync", {
                              id: project.id,
                              sourceId: source.id,
                            });
                            await refresh();
                          })
                        }
                      />
                    )}
                    {active ? (
                      job.state !== "connecting" && (
                        <IconButton
                          icon={XIcon}
                          size="sm"
                          variant="tertiary"
                          aria-label={`Cancel clone for ${source.name}`}
                          title="Cancel clone"
                          onClick={() =>
                            void run(async () => {
                              await call("cancel-clone", { id: job.id });
                            })
                          }
                        />
                      )
                    ) : job?.folderIdentity && ready ? (
                      <Button
                        size="sm"
                        disabled={disabled}
                        onClick={() =>
                          void run(async () => {
                            await call("retry-connect", { id: job.id });
                            await refresh();
                          })
                        }
                      >
                        Finish connecting
                      </Button>
                    ) : needsGithub ? null : denied ? (
                      <Button
                        size="sm"
                        disabled={disabled || requested.includes(source.id)}
                        onClick={() => {
                          setReason("");
                          setDialog({ kind: "request", source });
                        }}
                      >
                        {requested.includes(source.id)
                          ? "Request sent"
                          : "Request access"}
                      </Button>
                    ) : failed ? (
                      <IconButton
                        icon={RefreshCwIcon}
                        size="sm"
                        variant="tertiary"
                        aria-label={`Retry access check for ${source.name}`}
                        title="Retry access check"
                        disabled={disabled}
                        onClick={() =>
                          void run(() => controller.recheck(source.id))
                        }
                      />
                    ) : (
                      !connected &&
                      !conflict && (
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={disabled || !ready}
                          onClick={() =>
                            source.path
                              ? void run(async () => {
                                  await connectProject(
                                    project.id,
                                    source.id,
                                    source.path!,
                                  );
                                  await refresh();
                                })
                              : openPicker(source)
                          }
                        >
                          {source.path ? "Reconnect" : "Connect"}
                        </Button>
                      )
                    )}
                    <ItemMenuButton
                      actions={actions}
                      label={`Options for ${source.name}`}
                      disabled={disabled}
                    />
                  </div>
                </div>
                {job && !active && (
                  <p className="repository-job-feedback" role="status">
                    {job.message}
                  </p>
                )}
              </div>
            </ItemContextMenu>
          );
        })}
        {(checkingConnection ||
          statusUnavailable ||
          needsAccountConnection ||
          project.role === "owner") && (
          <div className="settings-add-folder-row">
            {checkingConnection ? (
              <LoadingRegion
                id="repository-connection-action"
                label="Checking GitHub connection…"
                loading
              >
                <Button className="settings-add-folder" variant="tertiary">
                  <PlusIcon size={16} aria-hidden="true" />
                  Connect repository
                </Button>
              </LoadingRegion>
            ) : statusUnavailable ? (
              <Button
                disabled={disabled}
                onClick={() => void run(controller.reloadStatus)}
              >
                Retry GitHub status
              </Button>
            ) : (
              <Button
                variant={needsAccountConnection ? "primary" : "tertiary"}
                className={
                  needsAccountConnection ? undefined : "settings-add-folder"
                }
                disabled={disabled}
                onClick={() =>
                  openPicker(
                    needsAccountConnection
                      ? (reconnectSource ?? sources[0])
                      : undefined,
                  )
                }
              >
                {!needsAccountConnection && (
                  <PlusIcon size={16} aria-hidden="true" />
                )}
                {needsAccountConnection
                  ? "Connect GitHub"
                  : "Connect repository"}
              </Button>
            )}
          </div>
        )}
      </div>
      {notice && <p role="status">{notice}</p>}
      {error && !dialog && <p role="alert">{error}</p>}
      {dialogUi}
    </section>
  );
  if (dialogOnly && multipleSources)
    return (
      <Modal
        title="Connect project repositories"
        heading="Connect repositories"
        className="repository-dialog"
        closeLabel="Close project repository setup"
        onClose={close}
      >
        {content}
      </Modal>
    );
  return dialogOnly ? dialogUi : content;
}

export function RepositoryRequests({
  project,
  state,
}: {
  project: Project;
  state: Snapshot;
}) {
  const call = useRepositoryCommand(state);
  const [requests, setRequests] = useState<RepositoryAccessRequest[]>([]);
  const [enabled, setEnabled] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [reviewStatuses, setReviewStatuses] = useState<Record<string, string>>(
    {},
  );
  const load = useCallback(
    async (offset = 0) => {
      const value = await call<{
        items: RepositoryAccessRequest[];
        nextOffset: number | null;
      }>("requests", { projectId: project.id, offset });
      setRequests((previous) =>
        offset ? [...previous, ...value.items] : value.items,
      );
      setNextOffset(value.nextOffset);
    },
    [call, project.id],
  );
  useEffect(() => {
    let canceled = false;
    void call<{ enabled: boolean }>("capabilities")
      .then(async (value) => {
        if (!canceled && value.enabled) {
          setEnabled(true);
          await load();
        }
      })
      .catch((e) => {
        if (!canceled) setError(String(e));
      });
    return () => {
      canceled = true;
    };
  }, [call, load]);
  if (!enabled) return null;
  const review = async (request: RepositoryAccessRequest, status: string) => {
    setBusy(true);
    setError("");
    try {
      await call("review", {
        projectId: project.id,
        id: request.id,
        expectedRevision: request.revision,
        status,
        note:
          notes[request.id] ||
          (status === "canceled" ? "Canceled by requester" : ""),
      });
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const reviewStatus = (request: RepositoryAccessRequest) =>
    reviewStatuses[request.id] ??
    (request.status === "invitation_pending"
      ? "invitation_pending"
      : "waiting_on_github");
  return (
    <section
      className="repository-panel repository-requests"
      aria-label="Repository access requests"
    >
      <h3>Repository access requests</h3>
      <p>
        Project owners coordinate grants in GitHub. Access becomes verified only
        after the requester checks GitHub access.
      </p>
      <Button
        size="sm"
        variant="tertiary"
        disabled={busy}
        onClick={() => void load().catch((e) => setError(String(e)))}
      >
        Refresh repository requests
      </Button>
      {requests.length === 0 && <p>No repository access requests.</p>}
      {requests.map((request) => (
        <div key={request.id} className="repository-source">
          <h3>
            {request.fullName} · @{request.githubLogin}
          </h3>
          <p>{request.reason}</p>
          <p>
            Status:{" "}
            {request.status === "waiting_on_github"
              ? "Waiting on GitHub"
              : request.status.replaceAll("_", " ")}
          </p>
          {request.note && <p>{request.note}</p>}
          {["requested", "waiting_on_github", "invitation_pending"].includes(
            request.status,
          ) && (
            <>
              <div className="actions">
                <Button
                  size="sm"
                  onClick={() =>
                    void call("open-github", {
                      url: `https://github.com/${request.fullName}`,
                    }).catch((e) => setError(String(e)))
                  }
                >
                  Open repository on GitHub
                </Button>
              </div>
              {request.canReview && (
                <form
                  className="repository-request-review"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!busy && notes[request.id]?.trim())
                      void review(request, reviewStatus(request));
                  }}
                >
                  <div className="repository-request-status">
                    <span className="ui-field__label">Request status</span>
                    <PermissionSelect
                      label={`Request status for ${request.githubLogin}`}
                      value={reviewStatus(request)}
                      disabled={busy}
                      options={[
                        {
                          value: "waiting_on_github",
                          label: "Waiting on GitHub",
                        },
                        {
                          value: "invitation_pending",
                          label: "Invitation sent",
                        },
                        { value: "rejected", label: "Rejected" },
                      ]}
                      onChange={(value) =>
                        setReviewStatuses((previous) => ({
                          ...previous,
                          [request.id]: value,
                        }))
                      }
                    />
                  </div>
                  <TextField
                    label="Note"
                    aria-label={`Review note for ${request.githubLogin}`}
                    hint="Required when updating the request."
                    required
                    disabled={busy}
                    value={notes[request.id] ?? ""}
                    maxLength={1000}
                    onChange={(event) =>
                      setNotes((previous) => ({
                        ...previous,
                        [request.id]: event.target.value,
                      }))
                    }
                  />
                  <div className="actions">
                    <Button
                      type="submit"
                      size="sm"
                      variant="primary"
                      disabled={busy || !notes[request.id]?.trim()}
                    >
                      {busy ? "Updating…" : "Update request"}
                    </Button>
                  </div>
                </form>
              )}
              {request.requester === state.user && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void review(request, "canceled")}
                >
                  Cancel repository request
                </Button>
              )}
            </>
          )}
        </div>
      ))}
      {nextOffset !== null && (
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            void load(nextOffset).catch((e) => setError(String(e)))
          }
        >
          Load more requests
        </Button>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
