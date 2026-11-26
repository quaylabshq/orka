import { productAction } from "./desktop-usage.js";
import {
  BookOpenIcon,
  CodeIcon,
  CopyIcon,
  DownloadIcon,
  EllipsisIcon,
  EyeIcon,
  FileIcon,
  FilesIcon,
  FileTextIcon,
  FolderIcon,
  GitCompareIcon,
  GitForkIcon,
  LinkIcon,
  RefreshCwIcon,
  TrashIcon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import React, {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Channel } from "@tauri-apps/api/core";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "./product-command.js";
import type {
  Project,
  ProjectResource,
  Snapshot,
  SyncProgress,
} from "../types.js";
import {
  ItemContextMenu,
  ItemMenuButton,
  type ItemMenuAction,
} from "./item-menu.js";
import { Overlay } from "./overlay.js";
import { Button } from "./button.js";
import { Icon } from "./icon.js";
import { IconButton } from "./icon-button.js";
import { MarkdownMarkIcon } from "./icons.js";
import { SessionLauncher } from "./session-launcher.js";
import type { ResourceView } from "./use-resource-view.js";
import { sourcePath } from "./project-sources.js";
import { skillReviewState } from "./skill-review-state.js";
import { useResourceActions, type Run } from "./use-resource-actions.js";
import { QueuedUploadReview } from "./queued-upload-review.js";
import { ArtifactLinkDialog } from "./artifact-link-dialog.js";
import { useWorkspaceScope } from "./workspace-cache.js";
import { ShareDialog } from "./share-dialog.js";

type ResourceRequest =
  "share" | "delete" | "launch" | "retry-upload" | "public-link";

interface ResourceMenuContextValue {
  scope: string;
  state: Snapshot;
  busy: boolean;
  sharedArtifact: (resource: ProjectResource) => ProjectResource | undefined;
  act: Run;
  onOpen: (resource: ProjectResource, compare?: boolean) => void;
  onReview: (resource: ProjectResource, mode: "incoming" | "outgoing") => void;
  onOpenRequests: (projectId: string) => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
  onRefresh: () => Promise<void>;
  isCurrent: (resource: ProjectResource) => boolean;
  request: (
    kind: ResourceRequest,
    resource: ProjectResource,
    uploadId?: string,
  ) => void;
  reviewUpload: (uploadId: string) => void;
}

const ResourceMenuContext = createContext<ResourceMenuContextValue | null>(
  null,
);
// A Pi row exposes Orka's private copy of the live session, not the shared
// snapshot. Later private turns must not invalidate a review of that snapshot.
const identity = (resource: ProjectResource) =>
  JSON.stringify([
    resource.projectId,
    resource.resourceId,
    resource.source === "pi"
      ? (resource.sharedRevision ?? resource.revision)
      : resource.revision,
    resource.source === "pi" ? null : resource.hash,
    resource.source === "pi" ? null : resource.files,
  ]);

const resourceKey = (resource: ProjectResource) =>
  `${resource.projectId}/${resource.resourceId}`;

export function canDeleteSharedResource(
  resource: ProjectResource,
  project: Project,
  state: Snapshot,
) {
  if (
    resource.local ||
    (resource.localChanges && resource.source !== "pi") ||
    resource.revision < 1 ||
    resource.deleted
  )
    return false;
  if (
    resource.kind === "memory" &&
    (!project.governed ||
      resource.source !== "shared" ||
      resource.logicalPath.startsWith("instructions/"))
  )
    return false;
  const category = resource.kind;
  const access =
    resource.access?.mode ??
    state.governance?.find((entry) => entry.projectId === project.id)?.catalog
      .access[category]?.mode ??
    (project.role === "owner" || !project.governed ? "publish" : "read");
  if (project.rolePolicies)
    return (
      project.role === "owner" ||
      (project.role === "admin" && access === "publish")
    );
  return (
    access === "publish" &&
    (resource.kind !== "session" || resource.owner === state.user)
  );
}

export function ResourceMenuProvider({
  resources,
  children,
  ...props
}: Omit<
  ResourceMenuContextValue,
  "isCurrent" | "request" | "reviewUpload" | "sharedArtifact"
> & {
  resources: ProjectResource[];
  children: React.ReactNode;
}) {
  const currentResources = useRef(resources);
  currentResources.current = resources;
  const scope = useRef(props.scope);
  scope.current = props.scope;
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const account = props.state.user;
  const service = props.state.config?.apiUrl;
  const cloud = props.state.config?.mode !== "self-hosted";
  const online = props.state.sync?.online;
  const [linkCapability, setLinkCapability] = useState<{
    account: string;
    service: string;
    origin: string;
  } | null>(null);
  useEffect(() => {
    if (!account || !service || !cloud) return;
    let active = true;
    void invoke<{
      artifactLibrary?: number;
      auth?: { browserOrigin?: string };
    }>("auth_capabilities", { apiUrl: service })
      .then((instance) => {
        if (!active) return;
        const origin = instance?.auth?.browserOrigin;
        setLinkCapability(
          instance?.artifactLibrary === 1 && typeof origin === "string"
            ? { account, service, origin }
            : null,
        );
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [account, service, cloud, online]);
  const publicLinkOrigin =
    cloud &&
    linkCapability?.account === account &&
    linkCapability?.service === service
      ? linkCapability.origin
      : null;
  const sharedArtifacts = useMemo(
    () =>
      new Map(
        publicLinkOrigin
          ? props.state.resources
              .filter(
                (item) =>
                  item.kind !== "memory" && !item.deleted && item.revision > 0,
              )
              .map((item) => [resourceKey(item), item])
          : [],
      ),
    [publicLinkOrigin, props.state.resources],
  );
  const sharedArtifact = (resource: ProjectResource) => {
    if (resource.local || resource.deleted) return;
    const item = sharedArtifacts.get(resourceKey(resource));
    if (item?.revision === (resource.sharedRevision ?? resource.revision))
      return item;
  };
  const [request, setRequest] = useState<
    | {
        kind: "retry-upload";
        upload: Snapshot["outbox"][number];
        scope: string;
      }
    | {
        kind: Exclude<ResourceRequest, "retry-upload">;
        resource: ProjectResource;
        scope: string;
      }
    | null
  >(null);
  useEffect(() => {
    setRequest(null);
  }, [props.scope]);
  const requestedArtifact =
    request?.kind === "public-link"
      ? sharedArtifact(request.resource)
      : undefined;
  const isCurrent = (resource: ProjectResource) =>
    active.current &&
    scope.current === props.scope &&
    currentResources.current.some(
      (item) => !item.deleted && identity(item) === identity(resource),
    );
  const context: ResourceMenuContextValue = {
    ...props,
    isCurrent,
    sharedArtifact,
    request: (kind, resource, uploadId) => {
      if (!isCurrent(resource)) return;
      const upload = props.state.outbox.find(
        (entry) =>
          entry.reviewable &&
          entry.project === resource.projectId &&
          entry.resourceId === resource.resourceId &&
          (!uploadId || entry.id === uploadId),
      );
      if (kind === "retry-upload") {
        if (upload) setRequest({ kind, upload, scope: props.scope });
      } else if (kind === "public-link") {
        const artifact = sharedArtifact(resource);
        if (artifact)
          setRequest({ kind, resource: artifact, scope: props.scope });
      } else setRequest({ kind, resource, scope: props.scope });
    },
    reviewUpload: (uploadId) => {
      const upload = props.state.outbox.find(
        (entry) =>
          entry.id === uploadId && entry.reviewable && entry.resourceId,
      );
      if (upload)
        setRequest({ kind: "retry-upload", upload, scope: props.scope });
    },
  };
  return (
    <ResourceMenuContext.Provider value={context}>
      {children}
      {request &&
        request.scope === props.scope &&
        (request.kind === "retry-upload" ? (
          <QueuedUploadReview
            key={`${props.scope}:upload:${request.upload.id}`}
            input={{
              accountId: props.state.user,
              serviceOrigin: props.state.config?.apiUrl,
              projectId: request.upload.project,
              resourceId: request.upload.resourceId!,
              uploadId: request.upload.id,
            }}
            title={request.upload.title ?? "Queued plan"}
            stale={
              !props.state.outbox.some(
                (upload) =>
                  upload.id === request.upload.id && upload.reviewable,
              )
            }
            parentBusy={props.busy}
            onClose={() => setRequest(null)}
            onRefresh={props.onRefresh}
            onNotice={props.onNotice}
          />
        ) : request.kind === "launch" ? (
          <SessionLaunchDialog
            key={`${props.scope}:launch:${identity(request.resource)}`}
            resource={request.resource}
            context={context}
            onClose={() => setRequest(null)}
          />
        ) : request.kind === "public-link" ? (
          <ArtifactLinkDialog
            key={identity(request.resource)}
            resource={request.resource}
            accountId={account}
            serviceOrigin={service}
            linkOrigin={publicLinkOrigin}
            stale={
              !requestedArtifact ||
              identity(requestedArtifact) !== identity(request.resource)
            }
            onClose={() => setRequest(null)}
            onCloseAutoFocus={(event) =>
              restoreResourceFocus(event, request.resource.resourceId)
            }
          />
        ) : request.kind === "share" ? (
          <ShareRequest
            key={`${props.scope}:share:${identity(request.resource)}`}
            resource={request.resource}
            context={context}
            onClose={() => setRequest(null)}
          />
        ) : (
          <DeleteDialog
            key={`${props.scope}:delete:${identity(request.resource)}`}
            resource={request.resource}
            context={context}
            onClose={() => setRequest(null)}
          />
        ))}
    </ResourceMenuContext.Provider>
  );
}

export function useQueuedUploadReview() {
  return useContext(ResourceMenuContext)?.reviewUpload;
}

/**
 * Where an item lives on this Mac: its repository folder, and, when asked
 * for, the files Copy local path reports. Neither exists off this Mac.
 */
export function useLocalLocation(resource: ProjectResource, files: boolean) {
  const context = useContext(ResourceMenuContext);
  const scope = useWorkspaceScope();
  const project = context?.state.projects.find(
    (item) => item.id === resource.projectId,
  );
  const folder =
    (project && sourcePath(project, resource.sourceId)) || undefined;
  const { data } = useQuery({
    queryKey: [
      "local-paths",
      scope,
      resource.projectId,
      resource.resourceId,
      resource.hash,
      folder,
    ],
    enabled: files && Boolean(context && folder),
    queryFn: async () =>
      (
        await invoke<{ paths: string[] }>("resource_command", {
          action: "paths",
          input: {
            accountId: context?.state.user,
            serviceOrigin: context?.state.config?.apiUrl,
            projectId: resource.projectId,
            resourceId: resource.resourceId,
          },
        })
      ).paths,
  });
  return { folder, files: data };
}

export function resourceViewMenuActions(
  view: ResourceView,
  session: boolean,
): ItemMenuAction[] {
  const items: ItemMenuAction[] = [];
  if (!session && view.changes)
    items.push({
      id: "show-content",
      label: "Show content",
      icon: FileTextIcon,
      onSelect: () => view.setChanges(false),
    });
  if (session ? !view.fullTranscript : view.canRenderMarkdown && !view.changes)
    items.push({
      id: "markdown",
      label: view.rawMarkdown ? "Show formatted" : "Show Markdown",
      icon: view.rawMarkdown ? BookOpenIcon : MarkdownMarkIcon,
      onSelect: () => view.setRawMarkdown((value) => !value),
    });
  return items;
}

/** Actions not listed here open, copy or locate the item. */
const actionGroups: Record<string, string> = {
  share: "share",
  "public-link": "share",
  "review-incoming": "review",
  "review-outgoing": "review",
  "review-instructions": "review",
  "review-upload": "review",
  delete: "remove",
};

function ResourceMenuTarget({
  resource,
  file,
  extraActions = [],
  children,
}: {
  resource: ProjectResource;
  file?: string;
  extraActions?: ItemMenuAction[];
  children: (actions: ItemMenuAction[]) => React.ReactNode;
}) {
  const context = useContext(ResourceMenuContext)!;
  const project = context.state.projects.find(
    (item) => item.id === resource.projectId,
  );
  const actions = useResourceActions({
    act: context.act,
    resource,
    user: context.state.user,
    onNotice: context.onNotice,
    scope: context.scope,
  });
  if (!project) return children([]);
  const shared = !resource.local && resource.revision > 0;
  const connected = Boolean(sourcePath(project, resource.sourceId));
  const selectedFile =
    file ??
    (resource.kind === "skill" ? "SKILL.md" : (resource.files[0]?.path ?? ""));
  const input = {
    accountId: context.state.user,
    serviceOrigin: context.state.config?.apiUrl,
    projectId: project.id,
    resourceId: resource.resourceId,
  };
  const copy = (
    load: () => Promise<string>,
    successTitle: string,
    event?: "resource_path_copied" | "session_prompt_copied",
  ) => {
    const record = productAction();
    void context.act(
      async () => {
        const text = await load();
        if (!context.isCurrent(resource))
          throw new Error("This item changed. Open its actions again.");
        await navigator.clipboard.writeText(text);
        if (event) record(event);
      },
      { successTitle, errorTitle: "Couldn’t copy", retryable: true },
    );
  };
  const review = skillReviewState(resource, context.state, project);
  const queuedUpload = context.state.outbox.find(
    (entry) =>
      entry.reviewable &&
      entry.project === resource.projectId &&
      entry.resourceId === resource.resourceId,
  );
  const items: ItemMenuAction[] = [
    {
      id: "open",
      label: "Open",
      icon: BookOpenIcon,
      onSelect: () => context.onOpen(resource),
    },
  ];
  if (
    (resource.local || resource.localChanges) &&
    resource.sharing !== "queued" &&
    resource.sharing !== "approval" &&
    (resource.kind === "skill" || resource.owner === context.state.user)
  )
    items.push({
      id: "share",
      icon: UploadIcon,
      label: "Share with team…",
      disabled: context.busy || !connected,
      reason: !connected
        ? "Connect this repository on this Mac first"
        : undefined,
      onSelect: () => context.request("share", resource),
    });
  if (resource.kind === "session") {
    items.push({
      id: "launch",
      icon: GitForkIcon,
      label: "Continue or fork in…",
      disabled: context.busy,
      onSelect: () => context.request("launch", resource),
    });
    items.push({
      id: "prompt",
      icon: CopyIcon,
      label: "Copy session prompt",
      disabled: context.busy,
      onSelect: () =>
        copy(
          actions.sessionPrompt,
          "Session prompt copied",
          "session_prompt_copied",
        ),
    });
    if (shared && !resource.localChanges)
      items.push({
        id: "copy",
        label: "Create copy",
        icon: FilesIcon,
        disabled: context.busy,
        onSelect: () => void actions.sessionAction("copy"),
      });
  } else {
    items.push({
      id: "editor",
      icon: CodeIcon,
      label: "Open in editor",
      disabled: context.busy || !connected,
      reason: !connected
        ? "Connect this repository on this Mac first"
        : undefined,
      onSelect: () => void actions.openEditor(selectedFile),
    });
    items.push({
      id: "content",
      icon: CopyIcon,
      label: resource.kind === "skill" ? "Copy file content" : "Copy content",
      disabled: context.busy,
      onSelect: () =>
        copy(async () => {
          const result = await invoke<{ content: string | null }>(
            "inspect_resource",
            { id: resource.resourceId, file: selectedFile, conflictId: null },
          );
          if (result.content === null)
            throw new Error("This file has no text preview.");
          return result.content;
        }, "Content copied"),
    });
    if (shared && !resource.localChanges)
      items.push({
        id: "compare",
        icon: GitCompareIcon,
        label: "Compare with previous revision",
        onSelect: () => context.onOpen(resource, true),
      });
  }
  if (shared)
    items.push({
      id: "link",
      icon: LinkIcon,
      label: resource.localChanges ? "Copy shared snapshot link" : "Copy link",
      onSelect: () =>
        copy(
          () =>
            Promise.resolve(
              `orka://project/${project.id}/${resource.resourceId}`,
            ),
          "Link copied",
        ),
    });
  const artifact = context.sharedArtifact(resource);
  if (
    artifact &&
    (project.role === "owner" || artifact.owner === context.state.user)
  )
    items.push({
      id: "public-link",
      icon: LinkIcon,
      label: "Manage public link…",
      disabled: context.busy,
      onSelect: () => context.request("public-link", resource),
    });
  const secondary: ItemMenuAction[] = [];
  if (connected) {
    secondary.push({
      id: "reveal",
      icon: FolderIcon,
      label: "Show in Finder",
      disabled: context.busy,
      onSelect: () =>
        void context.act(
          () => invoke("resource_command", { action: "reveal", input }),
          { errorTitle: "Couldn’t show this item in Finder" },
        ),
    });
    secondary.push({
      id: "path",
      icon: CopyIcon,
      label: "Copy local path",
      disabled: context.busy,
      onSelect: () =>
        copy(
          async () =>
            (
              await invoke<{ paths: string[] }>("resource_command", {
                action: "paths",
                input,
              })
            ).paths.join("\n"),
          "Local path copied",
          "resource_path_copied",
        ),
    });
  }
  if (queuedUpload)
    items.push({
      id: "review-upload",
      icon: EyeIcon,
      label: "Review queued upload…",
      disabled: context.busy,
      onSelect: () =>
        context.request("retry-upload", resource, queuedUpload.id),
    });
  if (review.incoming)
    secondary.push({
      id: "review-incoming",
      icon: EyeIcon,
      label: "Review local update…",
      onSelect: () => context.onReview(resource, "incoming"),
    });
  if (review.outgoing)
    secondary.push({
      id: "review-outgoing",
      icon: EyeIcon,
      label: "Review local edits…",
      onSelect: () => context.onReview(resource, "outgoing"),
    });
  if (
    resource.kind === "memory" &&
    shared &&
    project.governed &&
    resource.logicalPath.startsWith("instructions/")
  )
    secondary.push({
      id: "review-instructions",
      icon: EyeIcon,
      label: "Review local update…",
      onSelect: () => context.onReview(resource, "incoming"),
    });
  if (resource.kind !== "memory")
    secondary.unshift({
      id: "export",
      icon: DownloadIcon,
      label:
        resource.kind === "session"
          ? "Download session (.zip)…"
          : "Export ZIP…",
      disabled: context.busy,
      onSelect: () => void actions.exportZip(),
    });
  const configureAction = (item: ItemMenuAction): ItemMenuAction => ({
    ...item,
    group: actionGroups[item.id] ?? "item",
    restoreFocus: ![
      "open",
      "compare",
      "launch",
      "share",
      "public-link",
      "delete",
      "review-incoming",
      "review-upload",
      "review-outgoing",
      "review-instructions",
    ].includes(item.id),
  });
  const primary = [...items.map(configureAction), ...extraActions];
  if (secondary.length)
    primary.push({
      id: "more",
      label: "More actions",
      icon: EllipsisIcon,
      group: "more",
      children: secondary.map(configureAction),
      onSelect: () => {},
    });
  if (canDeleteSharedResource(resource, project, context.state))
    primary.push({
      id: "delete",
      icon: TrashIcon,
      label:
        resource.kind === "session"
          ? "Remove from history…"
          : `Delete shared ${resource.kind}…`,
      danger: true,
      group: "remove",
      restoreFocus: false,
      disabled: context.busy,
      onSelect: () => context.request("delete", resource),
    });
  return children(primary);
}

/** One list: the "More actions" submenu's items take its place. */
const flatten = (actions: ItemMenuAction[]) =>
  actions.flatMap((action) =>
    action.id === "more" && action.children ? action.children : [action],
  );

export function ResourceItemMenu({
  resource,
  file,
  extraActions,
  flat = false,
  onOpenChange,
  children,
}: {
  resource: ProjectResource;
  file?: string;
  extraActions?: ItemMenuAction[];
  /** Show every action in one list instead of nesting the rest under More. */
  flat?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: (actions: ItemMenuAction[]) => React.ReactElement;
}) {
  const context = useContext(ResourceMenuContext);
  if (!context) return children([]);
  return (
    <ResourceMenuTarget
      resource={resource}
      file={file}
      extraActions={extraActions}
    >
      {(nested) => {
        const actions = flat ? flatten(nested) : nested;
        return (
          <ItemContextMenu
            actions={actions}
            label={`${resource.kind} actions`}
            onOpenChange={onOpenChange}
          >
            {children(actions)}
          </ItemContextMenu>
        );
      }}
    </ResourceMenuTarget>
  );
}

export function ResourceMenuButton({
  resource,
  file,
  extraActions,
  label = "More resource actions",
}: {
  resource: ProjectResource;
  file?: string;
  extraActions?: ItemMenuAction[];
  label?: string;
}) {
  const context = useContext(ResourceMenuContext);
  if (!context) return null;
  return (
    <ResourceMenuTarget
      resource={resource}
      file={file}
      extraActions={extraActions}
    >
      {(actions) => (
        <ItemMenuButton
          actions={actions}
          label={label}
          disabled={context.busy}
        />
      )}
    </ResourceMenuTarget>
  );
}

function restoreResourceFocus(event: Event, resourceId: string) {
  event.preventDefault();
  document
    .querySelector<HTMLElement>(
      `button[data-resource-id="${CSS.escape(resourceId)}"]`,
    )
    ?.focus();
}

function SessionLaunchDialog({
  resource,
  context,
  onClose,
}: {
  resource: ProjectResource;
  context: ResourceMenuContextValue;
  onClose: () => void;
}) {
  const title = "Continue or fork session";
  const project = context.state.projects.find(
    (item) => item.id === resource.projectId,
  );
  const stale = !context.isCurrent(resource) || !project;
  const actions = useResourceActions({
    act: context.act,
    resource,
    user: context.state.user,
    onNotice: context.onNotice,
    scope: context.scope,
  });
  return (
    <Overlay
      open
      title={title}
      className="session-launch-dialog"
      onClose={onClose}
      onCloseAutoFocus={(event) =>
        restoreResourceFocus(event, resource.resourceId)
      }
    >
      <div className="session-launch-heading">
        <h2>{title}</h2>
        <IconButton
          icon={XIcon}
          variant="tertiary"
          size="sm"
          aria-label="Close session launcher"
          onClick={onClose}
        />
      </div>
      <p className="session-launch-title" title={resource.title}>
        {resource.title}
      </p>
      {stale && (
        <p className="session-launch-alert" role="alert">
          This session or account changed. Reopen the launcher from the
          session’s actions.
        </p>
      )}
      {project && (
        <div className="actions">
          <SessionLauncher
            resource={resource}
            project={project}
            scope={context.scope}
            busy={context.busy || stale}
            actions={actions}
            onError={context.onError}
          />
        </div>
      )}
    </Overlay>
  );
}

function ShareRequest({
  resource,
  context,
  onClose,
}: {
  resource: ProjectResource;
  context: ResourceMenuContextValue;
  onClose: () => void;
}) {
  const project = context.state.projects.find(
    (item) => item.id === resource.projectId,
  );
  if (!project) return null;
  return (
    <ShareDialog
      resource={resource}
      project={project}
      state={context.state}
      parentBusy={context.busy}
      stale={!context.isCurrent(resource)}
      onNotice={context.onNotice}
      onError={context.onError}
      onRefresh={context.onRefresh}
      onReview={context.onReview}
      onOpenRequests={context.onOpenRequests}
      onClose={onClose}
      onCloseAutoFocus={(event) =>
        restoreResourceFocus(event, resource.resourceId)
      }
    />
  );
}

interface DeletePreview {
  previewToken: string;
  title: string;
  note: string;
  paths?: string[];
}

function DeleteDialog({
  resource,
  context,
  onClose,
}: {
  resource: ProjectResource;
  context: ResourceMenuContextValue;
  onClose: () => void;
}) {
  const project = context.state.projects.find(
    (item) => item.id === resource.projectId,
  );
  const [preview, setPreview] = useState<DeletePreview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [attempt, setAttempt] = useState(0);
  const active = useRef(true);
  const workspace = useRef<HTMLDivElement>(null);
  const stale = !context.isCurrent(resource) || !project;
  const current = useRef(true);
  current.current = !stale;
  const input = {
    accountId: context.state.user,
    serviceOrigin: context.state.config?.apiUrl,
    projectId: resource.projectId,
    resourceId: resource.resourceId,
  };
  const accountId = context.state.user;
  const serviceOrigin = context.state.config?.apiUrl;
  const projectId = resource.projectId;
  const resourceId = resource.resourceId;
  useLayoutEffect(() => {
    if (workspace.current) workspace.current.scrollTop = 0;
  }, [loading, busy, error, stale]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    let canceled = false;
    setLoading(true);
    setError("");
    setPreview(null);
    setProgress({ label: "Preparing deletion for review…" });
    const onProgress = new Channel<SyncProgress>((value) => {
      if (!canceled && active.current && current.current) setProgress(value);
    });
    void invoke<DeletePreview>("resource_command", {
      action: "preview-delete",
      input: { accountId, serviceOrigin, projectId, resourceId },
      onProgress,
    })
      .then((result) => {
        if (!canceled) setPreview(result);
      })
      .catch((failure: unknown) => {
        if (!canceled) setError(String(failure));
      })
      .finally(() => {
        if (!canceled) {
          canceled = true;
          setLoading(false);
        }
      });
    return () => {
      canceled = true;
    };
  }, [attempt, accountId, serviceOrigin, projectId, resourceId]);
  const submit = async () => {
    if (busy || !preview || stale) return;
    const record = productAction();
    setBusy(true);
    setError("");
    setProgress({ label: "Confirming shared deletion…" });
    let finished = false;
    const onProgress = new Channel<SyncProgress>((value) => {
      if (!finished && active.current && current.current) setProgress(value);
    });
    try {
      const result = await invoke<{ status: string }>("resource_command", {
        action: "delete",
        input: { ...input, previewToken: preview.previewToken },
        onProgress,
      });
      if (result.status === "deleted") record("resource_deleted");
      if (!active.current) return;
      if (result.status !== "deleted") {
        setError(
          "The item changed before it could be deleted. Review the latest version and try again.",
        );
        return;
      }
      context.onNotice(
        resource.source === "pi"
          ? "Snapshot removed from shared history. The Pi session on its Mac is unchanged."
          : "Shared item deleted. Local copies follow sync and review rules.",
      );
      finished = true;
      setProgress({ label: "Refreshing project…" });
      await context.onRefresh();
      if (active.current) onClose();
    } catch (failure) {
      if (active.current) setError(String(failure));
    } finally {
      finished = true;
      if (active.current) setBusy(false);
    }
  };
  const title =
    resource.kind === "session"
      ? "Remove from history"
      : `Delete shared ${resource.kind}`;
  const total = progress?.total;
  const completed =
    total && total > 0 && progress?.completed !== undefined
      ? Math.min(total, Math.max(0, progress.completed))
      : null;
  const percentage =
    completed !== null && total ? (completed / total) * 100 : null;
  const progressCount =
    completed !== null && total
      ? `${completed} of ${total}`
      : progress?.completed
        ? `${progress.completed} checked`
        : undefined;
  return (
    <Overlay
      open
      title={title}
      onClose={() => {
        if (!busy) onClose();
      }}
      className="resource-command-dialog"
      onCloseAutoFocus={(event) =>
        restoreResourceFocus(event, resource.resourceId)
      }
    >
      <h2 title={title}>{title}</h2>
      <section className="resource-command-item" aria-label="Selected item">
        <Icon icon={FileIcon} size="sm" variant="secondary" />
        <div>
          <span className="resource-command-kind">{resource.kind}</span>
          <p title={preview?.title ?? resource.title}>
            {preview?.title ?? resource.title}
          </p>
        </div>
      </section>
      <div
        className="resource-command-workspace"
        ref={workspace}
        role="region"
        aria-label="Review details"
        tabIndex={0}
      >
        {stale && (
          <p role="alert">
            This item or account changed. Close this review and open the item’s
            actions again.
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        {(loading || busy) && !stale && progress ? (
          <section
            className="resource-command-progress"
            aria-label="Item action progress"
          >
            <div
              className="resource-command-progress-status"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              <Icon
                icon={RefreshCwIcon}
                size="sm"
                className="sync-activity-icon"
              />
              <div>
                <strong title={progress.label}>{progress.label}</strong>
                {progress.detail && (
                  <p title={progress.detail}>{progress.detail}</p>
                )}
              </div>
              <span
                className="resource-command-progress-count"
                title={progressCount}
              >
                {progressCount}
              </span>
            </div>
            <div
              className="resource-command-progress-track"
              data-indeterminate={percentage === null || undefined}
              role="progressbar"
              aria-label={progress.label}
              aria-valuemin={0}
              aria-valuemax={
                completed === null ? undefined : (total ?? undefined)
              }
              aria-valuenow={completed ?? undefined}
              aria-valuetext={progressCount}
            >
              <span
                style={
                  percentage === null ? undefined : { width: `${percentage}%` }
                }
              />
            </div>
          </section>
        ) : (
          !!preview?.paths?.length && (
            <section
              className="resource-command-paths"
              aria-label="Local copies affected"
            >
              <h3>Local copies affected</h3>
              <ul tabIndex={0}>
                {preview.paths.map((path) => (
                  <li key={path}>{path}</li>
                ))}
              </ul>
            </section>
          )
        )}
        {preview?.note && (
          <p className="resource-command-note">{preview.note}</p>
        )}
      </div>
      <div className="actions">
        {error && !preview && (
          <Button
            disabled={busy || loading || stale}
            onClick={() => setAttempt((value) => value + 1)}
          >
            Try again
          </Button>
        )}
        <div className="resource-command-main-actions">
          <Button variant="tertiary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            className="resource-command-confirm management-danger"
            disabled={busy || context.busy || loading || !preview || stale}
            onClick={() => void submit()}
          >
            <span className="resource-command-button-size" aria-hidden="true">
              Confirm deletion
            </span>
            <span>{busy ? "Working…" : "Confirm deletion"}</span>
          </Button>
        </div>
      </div>
    </Overlay>
  );
}
