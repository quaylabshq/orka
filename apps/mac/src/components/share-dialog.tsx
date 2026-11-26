import {
  ActivityIcon,
  ArrowLeftRightIcon,
  ClockIcon,
  CloudOffIcon,
  FileIcon,
  FolderIcon,
  LaptopIcon,
  LoaderCircleIcon,
  LockIcon,
  MessagesSquareIcon,
  RefreshCwIcon,
  ScrollTextIcon,
  ShieldIcon,
  TriangleAlertIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { invoke } from "./product-command.js";
import { productAction, useDesktopFeature } from "./desktop-usage.js";
import type {
  Project,
  ProjectResource,
  Snapshot,
  SyncProgress,
} from "../types.js";
import { Overlay } from "./overlay.js";
import { Button } from "./button.js";
import { Icon } from "./icon.js";
import { IconButton } from "./icon-button.js";
import { MarkdownMarkIcon, type IconGlyph } from "./icons.js";
import { fileSize } from "./file-size.js";
import {
  canConfirm,
  confirmLabel,
  sendingPill,
  shareStatus,
  shareStatuses,
  type ShareAction,
  type ShareFacts,
  type ShareIcon,
  type SharePreview,
  type ShareStep,
} from "./share-status.js";
import "./share-dialog.css";

const shareEvents = {
  memory: "feature:memory_shared",
  skill: "feature:skill_shared",
  plan: "feature:plan_shared",
  session: "feature:session_shared",
} as const;

const kinds: Record<
  ProjectResource["kind"],
  { icon: IconGlyph; label: string }
> = {
  memory: { icon: MarkdownMarkIcon, label: "Memory" },
  skill: { icon: FileIcon, label: "Skill" },
  plan: { icon: ScrollTextIcon, label: "Plan" },
  session: { icon: MessagesSquareIcon, label: "Session" },
};

const icons: Record<ShareIcon, IconGlyph> = {
  lock: LockIcon,
  folder: FolderIcon,
  refresh: RefreshCwIcon,
  warning: TriangleAlertIcon,
  loader: LoaderCircleIcon,
  file: FileIcon,
  clock: ClockIcon,
  shield: ShieldIcon,
  laptop: LaptopIcon,
  compare: ArrowLeftRightIcon,
  "cloud-off": CloudOffIcon,
};

/** Status-free result text for a share that finishes after the dialog closed. */
const closedNotice = {
  published: "Shared with team",
  approval_required: "Sent for approval",
  conflict: "Share needs conflict review",
  queued: "Share queued",
} as const;

function accessMode(
  resource: ProjectResource,
  project: Project,
  state: Snapshot,
): ShareFacts["access"] {
  const catalog = state.governance?.find(
    (entry) => entry.projectId === project.id,
  )?.catalog.access[resource.kind];
  const fresh = resource.local || resource.revision < 1;
  return (
    (fresh ? catalog?.create : (resource.access?.mode ?? catalog?.mode)) ??
    (project.role === "owner" || !project.governed ? "publish" : "read")
  );
}

export function ShareDialog({
  resource,
  project,
  state,
  parentBusy,
  stale,
  onNotice,
  onError,
  onRefresh,
  onReview,
  onOpenRequests,
  onClose,
  onCloseAutoFocus,
}: {
  resource: ProjectResource;
  project: Project;
  state: Snapshot;
  parentBusy: boolean;
  stale: boolean;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
  onRefresh: () => Promise<void>;
  onReview: (resource: ProjectResource, mode: "outgoing") => void;
  onOpenRequests: (projectId: string) => void;
  onClose: () => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const startFeature = useDesktopFeature();
  const [step, setStep] = useState<ShareStep>({
    step: "preparing",
    progress: null,
  });
  const [attempt, setAttempt] = useState(0);
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  const accountId = state.user;
  const serviceOrigin = state.config?.apiUrl;
  const projectId = resource.projectId;
  const resourceId = resource.resourceId;
  const input = { accountId, serviceOrigin, projectId, resourceId };

  useEffect(() => {
    let canceled = false;
    setStep({ step: "preparing", progress: null });
    const onProgress = new Channel<SyncProgress>((progress) => {
      if (!canceled)
        setStep((current) =>
          current.step === "preparing" ? { ...current, progress } : current,
        );
    });
    invoke<SharePreview>("resource_command", {
      action: "preview-share",
      input: { accountId, serviceOrigin, projectId, resourceId },
      onProgress,
    }).then(
      (preview) => {
        if (canceled) return;
        productAction()("share_preview_viewed");
        setStep({ step: "review", preview });
      },
      (error: unknown) => {
        if (!canceled)
          setStep({ step: "preview-failed", error: String(error) });
      },
    );
    return () => {
      canceled = true;
    };
  }, [attempt, accountId, serviceOrigin, projectId, resourceId]);

  // A reviewed preview lasts ten minutes; fetch a fresh one instead of failing the send.
  const expiresAt = step.step === "review" ? step.preview.expiresAt : undefined;
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setTimeout(
      () => setAttempt((value) => value + 1),
      Math.max(0, expiresAt * 1000 - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [expiresAt]);

  const facts: ShareFacts = {
    stale,
    access: accessMode(resource, project, state),
    pi: resource.source === "pi",
    update: !resource.local && resource.revision > 0,
  };
  const key = shareStatus(step, facts);
  const status = shareStatuses[key];

  const send = async (preview: SharePreview) => {
    const record = productAction();
    record("share_submitted");
    const recordShared = startFeature(shareEvents[resource.kind]);
    setStep({ step: "sending", preview, progress: null });
    const onProgress = new Channel<SyncProgress>((progress) => {
      if (open.current)
        setStep((current) =>
          current.step === "sending" ? { ...current, progress } : current,
        );
    });
    try {
      const result = await invoke<{
        status: keyof typeof closedNotice;
        error?: string | null;
      }>("resource_command", {
        action: "share",
        input: { ...input, previewToken: preview.previewToken },
        onProgress,
      });
      if (result.status === "published") recordShared();
      if (result.status === "queued") record("share_queued");
      if (result.status === "conflict") record("share_failed");
      if (result.status === "published" || !open.current)
        onNotice(closedNotice[result.status] ?? closedNotice.queued);
      await onRefresh();
      if (!open.current) return;
      if (result.status === "published") onClose();
      else
        setStep({
          step: "sent",
          preview,
          status: result.status,
          error: result.error,
        });
    } catch (failure) {
      record("share_failed");
      if (open.current)
        setStep({ step: "send-failed", preview, error: String(failure) });
      else onError(String(failure));
    }
  };

  const run: Record<ShareAction, () => void> = {
    confirm: () => {
      if (step.step === "review" && !parentBusy) void send(step.preview);
    },
    preview: () => setAttempt((value) => value + 1),
    resend: () => {
      if (step.step === "send-failed") void send(step.preview);
    },
    requests: () => {
      onClose();
      onOpenRequests(projectId);
    },
    compare: () => {
      onClose();
      onReview(resource, "outgoing");
    },
    close: onClose,
  };
  const label: Record<ShareAction, string> = {
    confirm: step.step === "sending" ? "Sharing…" : confirmLabel(facts),
    preview: key === "preview-failed" ? "Try again" : "Review again",
    resend: "Try again",
    requests: "View request",
    compare: "Review changes",
    close: key === "account-changed" ? "Close" : "Done",
  };

  const preview = "preview" in step ? step.preview : null;
  const kind = kinds[resource.kind];
  const title = preview?.title ?? resource.title;
  const detail = preview?.files
    ? `${preview.files.length} ${preview.files.length === 1 ? "file" : "files"} · ${fileSize(
        preview.totalBytes ??
          preview.files.reduce((bytes, file) => bytes + file.size, 0),
      )}`
    : resource.logicalPath;
  const members = state.governance?.find(
    (entry) => entry.projectId === projectId,
  )?.catalog.members?.length;
  const people = members
    ? `Everyone · ${members} ${members === 1 ? "member" : "members"}`
    : "Everyone";
  const place =
    state.config?.mode === "self-hosted"
      ? `${project.name} · Self-hosted`
      : project.name;
  const pill =
    step.step === "sending" ? sendingPill(step.progress) : status.pill;
  const progress =
    step.step === "preparing" || step.step === "sending"
      ? step.progress?.label
      : undefined;
  const heading = ("heading" in status && status.heading) || "Share with team";

  return (
    <Overlay
      open
      title={heading}
      onClose={onClose}
      className="share-dialog"
      onCloseAutoFocus={onCloseAutoFocus}
    >
      <div className="share-dialog-header">
        <h2 title={heading}>{heading}</h2>
        <IconButton
          icon={XIcon}
          size="sm"
          variant="tertiary"
          aria-label="Close"
          onClick={onClose}
        />
      </div>
      <div className="share-dialog-body">
        <section className="share-dialog-preview" aria-label="Selected item">
          <div className="share-dialog-card" aria-hidden="true" />
          <div className="share-dialog-card">
            <span className="share-dialog-kind">
              <Icon icon={kind.icon} size="xs" variant="secondary" />
              {kind.label}
            </span>
            <p className="share-dialog-title" title={title}>
              {title}
            </p>
            <p className="share-dialog-detail" title={detail}>
              {detail}
            </p>
          </div>
        </section>
        <dl className="share-dialog-details">
          <div>
            <dt>
              <Icon icon={FolderIcon} size="sm" variant="secondary" />
              Project
            </dt>
            <dd title={place}>{place}</dd>
          </div>
          <div>
            <dt>
              <Icon icon={UsersIcon} size="sm" variant="secondary" />
              People
            </dt>
            <dd title={people}>{people}</dd>
          </div>
          <div>
            <dt>
              <Icon icon={ActivityIcon} size="sm" variant="secondary" />
              Status
            </dt>
            <dd>
              <span
                className="share-dialog-pill"
                data-tone={status.tone}
                data-status={key}
                role="status"
                aria-live="polite"
                title={progress ?? pill}
              >
                <Icon
                  icon={icons[status.icon]}
                  size="xs"
                  className={
                    status.icon === "loader" ? "share-dialog-spin" : ""
                  }
                />
                {pill}
              </span>
            </dd>
          </div>
        </dl>
      </div>
      <div className="share-dialog-footer">
        {status.actions.map((action, index) => (
          <Button
            key={action}
            size="sm"
            variant={
              index === status.actions.length - 1 ? "primary" : "secondary"
            }
            disabled={
              action === "confirm" && (!canConfirm(step, key) || parentBusy)
            }
            onClick={run[action]}
          >
            {label[action]}
          </Button>
        ))}
      </div>
    </Overlay>
  );
}
