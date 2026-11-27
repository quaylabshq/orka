import {
  CircleAlertIcon,
  ActivityIcon,
  ClockIcon,
  CloudOffIcon,
  FileIcon,
  FolderIcon,
  GitCompareIcon,
  LaptopIcon,
  LayersIcon,
  LockIcon,
  MessagesSquareIcon,
  RefreshCwIcon,
  ScrollTextIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { policyClass, type AccessMode } from "@portable/protocol";
import type { ProjectResource, Snapshot, SyncProgress } from "../types.js";
import { ActivityIndicator } from "./activity-indicator.js";
import { Button } from "./button.js";
import { productAction, useDesktopFeature } from "./desktop-usage.js";
import { Icon } from "./icon.js";
import { IconButton } from "./icon-button.js";
import type { IconGlyph } from "./icons.js";
import { Overlay } from "./overlay.js";
import { invoke } from "./product-command.js";
import { useToasts, type ToastInput } from "./toasts.js";
import {
  shareStatus,
  type ShareAction,
  type ShareIcon,
  type SharePhase,
} from "./share-status.js";
import "./share-dialog.css";

/** One glyph per shareable kind, shared with Reviews. */
export const resourceKindIcons: Record<ProjectResource["kind"], IconGlyph> = {
  memory: LayersIcon,
  plan: ScrollTextIcon,
  session: MessagesSquareIcon,
  skill: FileIcon,
};

const statusIcons: Record<Exclude<ShareIcon, "loader">, IconGlyph> = {
  laptop: LaptopIcon,
  shield: ShieldCheckIcon,
  refresh: RefreshCwIcon,
  lock: LockIcon,
  warning: TriangleAlertIcon,
  file: CircleAlertIcon,
  clock: ClockIcon,
  compare: GitCompareIcon,
  "cloud-off": CloudOffIcon,
};

const kindNames: Record<ProjectResource["kind"], string> = {
  memory: "Memory",
  plan: "Plan",
  session: "Session",
  skill: "Skill",
};

const shareEvents = {
  memory: "feature:memory_shared",
  skill: "feature:skill_shared",
  plan: "feature:plan_shared",
  session: "feature:session_shared",
} as const;

interface SharePreview {
  previewToken: string;
  title: string;
  expiresAt?: number;
  files?: { path: string; size: number }[];
  totalBytes?: number;
  baseRevision?: number;
  publicationMode?: AccessMode | null;
  note?: string;
  piScope?: { entries: number; offBranchEntries: number };
}

export interface ShareDialogContext {
  state: Snapshot;
  busy: boolean;
  isCurrent: (resource: ProjectResource) => boolean;
  onRefresh: () => Promise<Snapshot | undefined>;
  onOpen: (resource: ProjectResource, target: { conflictId: string }) => void;
  onOpenRequests: (projectId: string) => void;
}

export function fileSize(bytes: number) {
  for (const [size, unit] of [
    [1e9, "GB"],
    [1e6, "MB"],
    [1e3, "KB"],
    [1, "B"],
  ] as const) {
    if (bytes >= size || size === 1)
      return `${(bytes / size).toLocaleString(undefined, { maximumFractionDigits: size === 1 ? 0 : 1 })} ${unit}`;
  }
}

const shareNotices = {
  published: { title: "Shared with team", kind: "success" },
  approval_required: { title: "Sent for approval", kind: "info" },
  conflict: { title: "Someone changed it first", kind: "warning" },
  queued: { title: "Queued to share", kind: "queued" },
} satisfies Record<string, ToastInput>;

/**
 * Shares one reviewed snapshot of a local item. The frame never changes size;
 * only the heading, the Status pill and the footer button follow the phase.
 */
export function ShareDialog({
  resource,
  context,
  onClose,
  onCloseAutoFocus,
}: {
  resource: ProjectResource;
  context: ShareDialogContext;
  onClose: () => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const { state } = context;
  const { notify } = useToasts();
  const project = state.projects.find((item) => item.id === resource.projectId);
  const startFeature = useDesktopFeature();
  const [phase, setPhase] = useState<SharePhase>({ step: "preparing" });
  const [preview, setPreview] = useState<SharePreview | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [acknowledgedPiToken, setAcknowledgedPiToken] = useState<string | null>(
    null,
  );
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  const stale = !context.isCurrent(resource) || !project;
  const accountId = state.user;
  const serviceOrigin = state.config?.apiUrl;
  const { projectId, resourceId } = resource;
  const policyRevision = project?.policyRevision;
  const previousPolicyRevision = useRef(policyRevision);
  useEffect(() => {
    if (previousPolicyRevision.current === policyRevision) return;
    previousPolicyRevision.current = policyRevision;
    if (phase.step === "preparing" || phase.step === "ready")
      setAttempt((value) => value + 1);
  }, [policyRevision, phase.step]);

  useEffect(() => {
    let canceled = false;
    setPhase({ step: "preparing" });
    setPreview(null);
    setAcknowledgedPiToken(null);
    void invoke<SharePreview>("resource_command", {
      action: "preview-share",
      input: { accountId, serviceOrigin, projectId, resourceId },
      onProgress: new Channel<SyncProgress>(),
    })
      .then((result) => {
        if (canceled) return;
        productAction()("share_preview_viewed");
        setPreview(result);
        setPhase({ step: "ready" });
      })
      .catch((failure: unknown) => {
        if (!canceled)
          setPhase({ step: "preview-failed", error: String(failure) });
      });
    return () => {
      canceled = true;
    };
  }, [attempt, accountId, serviceOrigin, projectId, resourceId]);

  // A review is valid for ten minutes. Prepare a fresh one before it lapses
  // instead of letting Share fail on an expired token.
  useEffect(() => {
    if (phase.step !== "ready" || !preview?.expiresAt) return;
    const wait = preview.expiresAt * 1000 - Date.now() - 5_000;
    const timer = setTimeout(
      () => setAttempt((value) => value + 1),
      Math.max(0, wait),
    );
    return () => clearTimeout(timer);
  }, [phase.step, preview]);

  const governance = state.governance?.find(
    (entry) => entry.projectId === resource.projectId,
  )?.catalog;
  const baseRevision =
    preview?.baseRevision ??
    resource.sharedRevision ??
    (resource.local ? 0 : resource.revision);
  const classAccess = governance?.access[policyClass(resource)];
  const cachedMode =
    baseRevision > 0
      ? (resource.access?.mode ?? classAccess?.mode)
      : (classAccess?.create ?? resource.access?.create);
  const access =
    preview?.publicationMode ?? (project?.governed ? cachedMode : undefined);
  const files = preview?.files ?? resource.files;
  const bytes =
    preview?.totalBytes ?? files.reduce((total, file) => total + file.size, 0);
  const status = shareStatus({
    phase,
    source: resource.source,
    update: baseRevision > 0,
    stale,
    files: preview?.files?.length,
    access,
    online: state.sync?.online !== false,
  });

  const piSession = resource.source === "pi" || Boolean(preview?.piScope);
  const piConfirmed =
    preview !== null && acknowledgedPiToken === preview.previewToken;

  const submit = async () => {
    if (!preview || stale || (piSession && !piConfirmed)) return;
    const record = productAction();
    record("share_submitted");
    const recordShared = startFeature(shareEvents[resource.kind]);
    setPhase({ step: "sending", progress: null });
    const onProgress = new Channel<SyncProgress>((progress) => {
      if (open.current) setPhase({ step: "sending", progress });
    });
    try {
      const result = await invoke<{
        status: keyof typeof shareNotices;
        requestId: string;
        reason?: string;
      }>("resource_command", {
        action: "share",
        input: {
          accountId,
          serviceOrigin,
          projectId,
          resourceId,
          previewToken: preview.previewToken,
          ...(piSession && { acknowledgedPiPreviewToken: acknowledgedPiToken }),
          ...(access === "suggest" && { requireApproval: true }),
        },
        onProgress,
      });
      if (result.status === "published") recordShared();
      if (result.status === "queued") record("share_queued");
      if (result.status === "conflict") record("share_failed");
      // The share already landed; a failed refresh must not report it failed.
      await context.onRefresh().catch(() => {});
      if (!open.current) {
        if (result.reason === "project_inactive")
          notify({ title: "Queued until project restore", kind: "warning" });
        else if (result.reason === "unsupported")
          notify({ title: "Waiting for Orka update", kind: "warning" });
        else notify(shareNotices[result.status]);
        return;
      }
      if (result.status === "published") {
        notify(shareNotices.published);
        onClose();
      } else if (result.status === "approval_required")
        setPhase({ step: "approval" });
      else if (result.status === "conflict")
        setPhase({ step: "conflict", requestId: result.requestId });
      else if (result.reason === "project_inactive") setPhase({ step: "held" });
      else
        setPhase({
          step: "queued",
          unsupported: result.reason === "unsupported",
        });
    } catch (failure) {
      record("share_failed");
      if (open.current)
        setPhase({ step: "share-failed", error: String(failure) });
      else notify({ title: "Couldn’t share", kind: "error" });
    }
  };

  const reviewConflict = async (requestId: string) => {
    const sharedVersion = (snapshot: Snapshot) => {
      const conflict = snapshot.conflicts.find(
        (item) =>
          item.id === requestId && item.candidate.projectId === projectId,
      );
      return (
        conflict &&
        snapshot.resources.find(
          (item) =>
            item.projectId === projectId &&
            item.resourceId === conflict.resourceId,
        )
      );
    };
    let shared = sharedVersion(state);
    if (!shared) {
      setPhase({ step: "conflict", requestId, checking: true });
      const next = await context.onRefresh().catch(() => undefined);
      if (!open.current) return;
      if (!next) {
        setPhase({
          step: "conflict",
          requestId,
          error: "Couldn’t refresh the project. Try Review changes again.",
        });
        return;
      }
      if (
        next.user !== accountId ||
        next.profile !== state.profile ||
        next.config?.apiUrl !== serviceOrigin
      )
        return;
      shared = sharedVersion(next);
      if (!shared) {
        setPhase({ step: "conflict-unavailable" });
        return;
      }
    }
    onClose();
    context.onOpen(shared, { conflictId: requestId });
  };

  const act = (action: ShareAction) => {
    if (action === "close") onClose();
    // A failed share prepares a fresh review rather than resending a token
    // that may have expired or no longer matches the item.
    else if (action === "retry") setAttempt((value) => value + 1);
    else if (action === "share") void submit();
    else if (action === "requests") {
      onClose();
      context.onOpenRequests(projectId);
    } else if (action === "compare" && phase.step === "conflict") {
      void reviewConflict(phase.requestId);
    }
  };
  const error =
    phase.step === "preview-failed" ||
    phase.step === "share-failed" ||
    phase.step === "conflict"
      ? phase.error
      : undefined;
  const kindIcon = resourceKindIcons[resource.kind];
  const title = preview?.title ?? resource.title;
  const count = preview?.piScope
    ? `${preview.piScope.entries} saved ${preview.piScope.entries === 1 ? "entry" : "entries"}`
    : `${files.length} ${files.length === 1 ? "file" : "files"}`;
  const detail = `${count} · ${fileSize(bytes)}`;
  const piWarningId = React.useId();
  const projectName = project
    ? `${project.name}${state.config?.mode === "self-hosted" ? " · Self-hosted" : ""}`
    : "";

  return (
    <Overlay
      open
      title={status.heading}
      onClose={onClose}
      className="share-dialog"
      onCloseAutoFocus={onCloseAutoFocus}
    >
      <div className="share-dialog-header">
        <h2 title={status.heading}>{status.heading}</h2>
        <IconButton
          icon={XIcon}
          size="sm"
          variant="tertiary"
          aria-label="Close"
          title="Close"
          onClick={onClose}
        />
      </div>
      <div className="share-dialog-body">
        <section
          className="share-dialog-preview"
          aria-label="Selected item"
          data-kind={resource.kind}
          data-pi={piSession || undefined}
        >
          <div className="share-dialog-card share-dialog-card--back" />
          <div className="share-dialog-card">
            <span className="share-dialog-kind">
              <Icon icon={kindIcon} size="sm" />
              {kindNames[resource.kind]}
            </span>
            <p className="share-dialog-title" title={title}>
              {title}
            </p>
            <p className="share-dialog-detail" title={detail}>
              {detail}
            </p>
          </div>
          {piSession && (
            <p
              className="share-dialog-scope-note"
              id={piWarningId}
              title={preview?.note}
            >
              {preview?.piScope && (
                <span>
                  {preview.piScope.offBranchEntries}{" "}
                  {preview.piScope.offBranchEntries === 1 ? "entry" : "entries"}{" "}
                  outside the current branch.
                </span>
              )}
              Includes any hidden tool records and reasoning.
            </p>
          )}
        </section>
        <dl className="share-dialog-facts">
          <div>
            <dt>
              <Icon icon={FolderIcon} size="sm" />
              Project
            </dt>
            <dd title={projectName}>{projectName}</dd>
          </div>
          <div>
            <dt>
              <Icon icon={UsersIcon} size="sm" />
              People
            </dt>
            <dd>Project members with access</dd>
          </div>
          <div>
            <dt>
              <Icon icon={ActivityIcon} size="sm" />
              Status
            </dt>
            <dd>
              <span
                className={`share-dialog-pill share-dialog-pill--${status.tone}`}
                role="status"
                aria-live="polite"
                title={status.pill}
                data-shimmer={phase.step === "sending" || undefined}
              >
                {status.icon === "loader" ? (
                  <ActivityIndicator />
                ) : (
                  <Icon icon={statusIcons[status.icon]} size="sm" />
                )}
                <span>{status.pill}</span>
              </span>
            </dd>
          </div>
        </dl>
      </div>
      <div className="share-dialog-footer">
        {piSession && status.action === "share" && (
          <label className="share-dialog-pi-consent">
            <input
              type="checkbox"
              checked={piConfirmed}
              disabled={!preview || status.actionDisabled || context.busy}
              aria-describedby={piWarningId}
              onChange={(event) =>
                setAcknowledgedPiToken(
                  event.target.checked && preview ? preview.previewToken : null,
                )
              }
            />
            Include the complete Pi session
          </label>
        )}
        {error && (
          <p className="share-dialog-error" role="alert" title={error}>
            {error}
          </p>
        )}
        {status.secondary && (
          <Button size="sm" onClick={() => act(status.secondary!.action)}>
            {status.secondary.label}
          </Button>
        )}
        <Button
          variant="primary"
          size="sm"
          className="share-dialog-action"
          aria-describedby={
            piSession && status.action === "share" ? piWarningId : undefined
          }
          disabled={
            status.actionDisabled ||
            (status.action === "share" &&
              (context.busy || (piSession && !piConfirmed)))
          }
          onClick={() => act(status.action)}
        >
          {status.actionLabel}
        </Button>
      </div>
    </Overlay>
  );
}
