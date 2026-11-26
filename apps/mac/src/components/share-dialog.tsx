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
import { policyClass } from "@portable/protocol";
import type { ProjectResource, Snapshot, SyncProgress } from "../types.js";
import { ActivityIndicator } from "./activity-indicator.js";
import { Button } from "./button.js";
import { productAction, useDesktopFeature } from "./desktop-usage.js";
import { Icon } from "./icon.js";
import { IconButton } from "./icon-button.js";
import type { IconGlyph } from "./icons.js";
import { Overlay } from "./overlay.js";
import { invoke } from "./product-command.js";
import {
  shareStatus,
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
}

export interface ShareDialogContext {
  state: Snapshot;
  busy: boolean;
  isCurrent: (resource: ProjectResource) => boolean;
  onNotice: (message: string) => void;
  onRefresh: () => Promise<void>;
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

/** The notice for a result that lands after the dialog was closed. */
const closedNotice: Record<string, string> = {
  published: "Shared with team",
  approval_required: "Sent for approval",
  conflict: "Someone changed it first",
  queued: "Queued to share",
};

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
  const project = state.projects.find((item) => item.id === resource.projectId);
  const startFeature = useDesktopFeature();
  const [phase, setPhase] = useState<SharePhase>({ step: "preparing" });
  const [preview, setPreview] = useState<SharePreview | null>(null);
  const [attempt, setAttempt] = useState(0);
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

  useEffect(() => {
    let canceled = false;
    setPhase({ step: "preparing" });
    setPreview(null);
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
  const access = !project?.governed
    ? undefined
    : (resource.access?.mode ??
      governance?.access[policyClass(resource)]?.mode);
  const files = preview?.files ?? resource.files;
  const bytes =
    preview?.totalBytes ?? files.reduce((total, file) => total + file.size, 0);
  const status = shareStatus({
    phase,
    resource,
    stale,
    files: preview?.files?.length,
    access,
    online: state.sync?.online !== false,
  });

  const submit = async () => {
    if (!preview || stale) return;
    const record = productAction();
    record("share_submitted");
    const recordShared = startFeature(shareEvents[resource.kind]);
    setPhase({ step: "sending", progress: null });
    const onProgress = new Channel<SyncProgress>((progress) => {
      if (open.current) setPhase({ step: "sending", progress });
    });
    try {
      const result = await invoke<{ status: string; reason?: string }>(
        "resource_command",
        {
          action: "share",
          input: {
            accountId,
            serviceOrigin,
            projectId,
            resourceId,
            previewToken: preview.previewToken,
          },
          onProgress,
        },
      );
      if (result.status === "published") recordShared();
      if (result.status === "queued") record("share_queued");
      if (result.status === "conflict") record("share_failed");
      // The share already landed; a failed refresh must not report it failed.
      await context.onRefresh().catch(() => {});
      if (!open.current) {
        context.onNotice(closedNotice[result.status] ?? "Queued to share");
        return;
      }
      if (result.status === "published") {
        context.onNotice("Shared with team");
        onClose();
      } else if (result.status === "approval_required")
        setPhase({ step: "approval" });
      else if (result.status === "conflict") setPhase({ step: "conflict" });
      else
        setPhase({
          step: "queued",
          unsupported: result.reason === "unsupported",
        });
    } catch (failure) {
      record("share_failed");
      if (open.current)
        setPhase({ step: "share-failed", error: String(failure) });
      else context.onNotice("Couldn’t share");
    }
  };

  const act = () => {
    if (status.action === "close") onClose();
    // A failed share prepares a fresh review rather than resending a token
    // that may have expired or no longer matches the item.
    else if (status.action === "retry") setAttempt((value) => value + 1);
    else if (status.action === "share") void submit();
  };
  const error =
    phase.step === "preview-failed" || phase.step === "share-failed"
      ? phase.error
      : undefined;
  const kindIcon = resourceKindIcons[resource.kind];
  const title = preview?.title ?? resource.title;
  const detail = `${files.length} ${files.length === 1 ? "file" : "files"} · ${fileSize(bytes)}`;
  const members = governance?.members?.length;
  const projectName = project
    ? `${project.name}${state.config?.mode === "self-hosted" ? " · Self-hosted" : ""}`
    : "";
  const people = members
    ? `Everyone · ${members} ${members === 1 ? "member" : "members"}`
    : "Everyone in this project";

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
            <dd title={people}>{people}</dd>
          </div>
          <div>
            <dt>
              <Icon icon={ActivityIcon} size="sm" />
              Status
            </dt>
            <dd>
              <span
                className={`share-dialog-pill share-dialog-pill--${status.tone}`}
                role={status.tone === "danger" ? "alert" : "status"}
                aria-live="polite"
                title={error ?? status.pill}
                data-shimmer={phase.step === "sending" || undefined}
              >
                {status.icon === "loader" ? (
                  <ActivityIndicator />
                ) : (
                  <Icon icon={statusIcons[status.icon]} size="sm" />
                )}
                <span>{status.pill}</span>
                {error && <span className="sr-only">{error}</span>}
              </span>
            </dd>
          </div>
        </dl>
      </div>
      <div className="share-dialog-footer">
        <Button
          variant="primary"
          size="sm"
          className="share-dialog-action"
          disabled={
            status.actionDisabled || (status.action === "share" && context.busy)
          }
          onClick={act}
        >
          {status.actionLabel}
        </Button>
      </div>
    </Overlay>
  );
}
