import {
  ChevronRightIcon,
  RefreshCwIcon,
  SettingsIcon,
  XIcon,
} from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import type { Resource } from "@portable/protocol";
import type { Snapshot, SyncQueueEntry } from "../types.js";
import { Button } from "./button.js";
import { IconButton } from "./icon-button.js";
import { Icon } from "./icon.js";
import { useMemberLabel } from "./member-names.js";
import { projectLabel } from "./project-navigation.js";

import {
  canCancel,
  lastSyncLabel,
  queueStateLabel,
  retryTime,
} from "./sync-queue.js";
import { syncIssueRecovery } from "./sync-issues.js";
import type { ProjectAttention, SyncReviewItem } from "./sync-attention.js";
import { useQueuedUploadReview } from "./resource-menu.js";

export function SyncMenu({
  state,
  attention,
  projectId,
  reviews = [],
  onReviewItem,
  busy,
  onSync,
  onRetry,
  onSettings,
  onConnect,
  onOpen,
  canConnect = true,
  open: controlledOpen,
  onOpenChange,
  onReview,
  placement = "sidebar",
  actionError = "",
  onDismissError,
  onResumeSetup,
  skillUsagePartial = false,
  queue = [],
  onCancel,
}: {
  placement?: "sidebar" | "header";
  actionError?: string;
  queue?: SyncQueueEntry[];
  onCancel?: (projectId: string) => void;
  onDismissError?: () => void;
  onResumeSetup?: () => void;
  skillUsagePartial?: boolean;
  state: Snapshot;
  attention: ProjectAttention;
  projectId?: string;
  reviews?: SyncReviewItem[];
  onReviewItem?: (review: SyncReviewItem) => void;
  busy: boolean;
  onSync: () => void;
  onRetry: () => void;
  onSettings: () => void;
  onConnect: () => void;
  onOpen: (id: string) => void;
  canConnect?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onReview?: () => void;
}) {
  const reviewUpload = useQueuedUploadReview();
  const memberName = useMemberLabel(state.user);
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = onOpenChange ?? setLocalOpen;
  const running = Boolean(state.daemon?.running);
  const connected = running && state.sync?.online && !attention.accountError;
  const liveProgress = running && state.user ? state.syncProgress : null;
  const active =
    running && state.user
      ? queue.find((entry) => entry.state === "running")
      : undefined;
  const progress =
    active && liveProgress?.projectId !== active.projectId
      ? null
      : liveProgress;
  const stopping = Boolean(active?.cancelRequested);
  const hasActivity = Boolean(active || liveProgress);
  const waiting = queue.filter(
    (entry) => entry.projectId !== active?.projectId,
  );
  const [now, setNow] = useState(Date.now);
  const content = useRef<HTMLDivElement>(null);
  const focusedAction = useRef<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [open]);
  useEffect(() => {
    const id = focusedAction.current;
    if (!id) return;
    const entry = queue.find((entry) => entry.projectId === id);
    if (id === "*" ? !hasActivity : entry && !entry.cancelRequested) return;
    if (document.activeElement === document.body) {
      content.current
        ?.querySelector<HTMLButtonElement>(
          'button[aria-label^="Cancel sync for"]:not(:disabled), button[data-sync-now], button[aria-label="Close sync status"]',
        )
        ?.focus();
    }
    focusedAction.current = null;
  }, [queue, hasActivity]);
  const total = progress?.total;
  const completed =
    total && total > 0 && progress?.completed !== undefined
      ? Math.min(total, Math.max(0, progress.completed))
      : null;
  const percentage =
    completed !== null && total ? Math.round((completed / total) * 100) : null;
  const pending = attention.outbox.filter((item) => item.error);
  const setup = state.onboarding?.setup;
  const setupProjects =
    setup?.projects.filter((p) => setup.selected.includes(p.path)) ?? [];
  const setupRunning = setup?.step === "syncing" || setup?.step === "retrying";
  const needsReconnect = attention.items.some((item) =>
    item.messages.some((message) =>
      /folder (changed|unavailable)|mount is missing/i.test(message),
    ),
  );
  const independentActionError =
    actionError &&
    actionError !== attention.accountError &&
    !attention.items.some((item) => item.messages.includes(actionError));
  const attentionItems = attention.items.filter(
    (item) =>
      !reviews.some(
        (review) => review.projectId === projectId && review.item === item,
      ),
  );
  const attentionCount =
    attentionItems.length +
    Number(Boolean(attention.accountError)) +
    Number(Boolean(independentActionError)) +
    Number(Boolean(setup && !setup.deferred && !setupRunning));
  const count = attentionCount + reviews.length;
  const historyCount =
    attention.historyRequests.length +
    attention.historyDrafts.length +
    attention.activity.length;
  const waitingStatus = waiting.length
    ? waiting.every((entry) => entry.state === "waiting")
      ? "Waiting to retry"
      : "Sync queued"
    : null;
  const visibleStatus = !running
    ? "Sync stopped"
    : stopping
      ? "Stopping…"
      : hasActivity
        ? "Syncing…"
        : (waitingStatus ??
          (attention.outbox.some((item) => !item.error)
            ? "Changes pending"
            : !connected && state.sync?.online === false
              ? "Sync offline"
              : attentionCount
                ? "Needs attention"
                : reviews.length
                  ? "Needs review"
                  : connected
                    ? state.sync?.lastSync
                      ? "Up to date"
                      : "Connected"
                    : "Waiting to connect"));
  const label = `${visibleStatus}${count ? `, ${count} ${count === 1 ? "notification" : "notifications"}` : ""}`;
  const compactStatus: Record<string, string> = {
    "Changes pending": "Pending",
    "Needs attention": "Attention",
    "Sync stopped": "Stopped",
    "Sync offline": "Offline",
    "Sync queued": "Queued",
  };
  const leave = (action: () => void) => {
    setOpen(false);
    action();
  };
  const resourceTitle = (id: string) =>
    state.resources.find((item: Resource) => item.resourceId === id)?.title ??
    "Session";
  const projectName = (id: string) => {
    const project = state.projects.find((item) => item.id === id);
    return project ? projectLabel(project) : "Project";
  };
  const activeId = active?.projectId ?? liveProgress?.projectId;
  const activeName = activeId ? projectName(activeId) : null;
  const activeTitle = activeName
    ? `${stopping ? "Stopping" : "Syncing"} ${activeName}`
    : "Syncing all projects";
  const progressDetail =
    progress?.detail === activeName
      ? null
      : activeName && progress?.detail?.startsWith(`${activeName} · `)
        ? progress.detail.slice(activeName.length + 3)
        : progress?.detail;
  const hasFeed = Boolean(
    waiting.length ||
    count ||
    setup ||
    historyCount ||
    attention.waitingRequests.length ||
    attention.accountIssues.length ||
    skillUsagePartial ||
    needsReconnect,
  );
  const cancelButton = (entry: SyncQueueEntry) =>
    onCancel && (
      <Button
        variant="secondary"
        size="sm"
        className="sync-queue-action"
        disabled={busy || !canCancel(entry)}
        aria-label={`Cancel sync for ${projectName(entry.projectId)}`}
        onFocus={() => {
          focusedAction.current = entry.projectId;
        }}
        onClick={() => onCancel(entry.projectId)}
      >
        Cancel
      </Button>
    );
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={`sync-status sync-status--${placement}`}
          data-offline={(running && state.sync?.online === false) || undefined}
          data-only-offline-notice={
            (state.sync?.online === false &&
              !!state.sync.error &&
              count === 1 &&
              attention.items.length === 0 &&
              pending.length === 0) ||
            undefined
          }
          aria-label={label}
          title={label}
        >
          <span
            className={`sync-status-indicator${connected ? " connected" : ""}`}
            aria-hidden="true"
          >
            {hasActivity ? (
              <Icon
                icon={RefreshCwIcon}
                size="xs"
                className="sync-activity-icon"
              />
            ) : (
              <span className={`dot${connected ? " connected" : ""}`} />
            )}
          </span>
          <span className="sync-status-label">
            {placement === "header"
              ? (compactStatus[visibleStatus] ?? visibleStatus)
              : visibleStatus}
          </span>
          {count > 0 && (
            <span className="sync-status-count" aria-hidden="true">
              {count > 99 ? "99+" : count}
            </span>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          ref={content}
          className="sync-menu"
          side={placement === "header" ? "bottom" : "right"}
          align="end"
          sideOffset={8}
          collisionPadding={12}
          aria-label="Sync status and notifications"
        >
          <div className="sync-menu-heading">
            <div className="sync-menu-heading-copy">
              <h2>Sync</h2>
              <span>All projects</span>
            </div>
            <IconButton
              icon={SettingsIcon}
              size="sm"
              variant="tertiary"
              aria-label="Sync settings"
              onClick={() => leave(onSettings)}
            />
            <Popover.Close asChild>
              <IconButton
                icon={XIcon}
                size="sm"
                variant="tertiary"
                aria-label="Close sync status"
              />
            </Popover.Close>
          </div>
          {hasActivity ? (
            <section className="sync-menu-progress" aria-label="Current sync">
              <div className="sync-queue-row" data-active="true">
                <div
                  className="sync-queue-project sync-menu-active-title"
                  role="status"
                >
                  <strong title={activeTitle}>{activeTitle}</strong>
                </div>
                {active && cancelButton(active)}
              </div>
              <div className="sync-menu-progress-status">
                <div className="sync-menu-progress-copy">
                  <strong>
                    {stopping
                      ? "Finishing the current step"
                      : (progress?.label ?? "Preparing sync")}
                  </strong>
                  {progress?.detail && !stopping && progressDetail && (
                    <p title={progress.detail}>{progressDetail}</p>
                  )}
                </div>
                {percentage !== null && !stopping && (
                  <span className="sync-menu-progress-count">
                    {completed} of {total}
                  </span>
                )}
              </div>
              {percentage !== null && !stopping && progress && (
                <div
                  className="sync-menu-progress-track"
                  role="progressbar"
                  aria-label={progress.label}
                  aria-valuemin={0}
                  aria-valuemax={total ?? undefined}
                  aria-valuenow={completed ?? undefined}
                  aria-valuetext={`${completed} of ${total} complete (${percentage}%)`}
                >
                  <span style={{ width: `${percentage}%` }} />
                </div>
              )}
            </section>
          ) : (
            <div className="sync-menu-status">
              <strong role="status">
                {!running ? "Background sync stopped" : visibleStatus}
              </strong>
              <div className="sync-menu-actions">
                {running ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    data-sync-now
                    disabled={busy}
                    onFocus={() => {
                      focusedAction.current = "*";
                    }}
                    onClick={onSync}
                  >
                    <Icon icon={RefreshCwIcon} />
                    {busy ? "Working…" : "Sync now"}
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => leave(onSettings)}
                  >
                    Set up background sync
                  </Button>
                )}
              </div>
            </div>
          )}
          {hasFeed && (
            <div
              className="sync-menu-feed"
              tabIndex={0}
              aria-label="Sync details"
            >
              {waiting.length > 0 && (
                <section className="sync-menu-queue" aria-label="Sync queue">
                  <h3>
                    {waiting.length}{" "}
                    {waiting.length === 1 ? "project" : "projects"} waiting
                  </h3>
                  {waiting.map((entry) => (
                    <div className="sync-queue-row" key={entry.projectId}>
                      <div className="sync-queue-project">
                        <strong title={projectName(entry.projectId)}>
                          {projectName(entry.projectId)}
                        </strong>
                        <small title={retryTime(entry)}>
                          {queueStateLabel(entry, now)}
                        </small>
                      </div>
                      {cancelButton(entry)}
                    </div>
                  ))}
                </section>
              )}
              {reviews.length > 0 && (
                <section
                  className="sync-menu-queue"
                  aria-label="Changes that need review"
                >
                  <h3>Needs review</h3>
                  {reviews.map((review) => {
                    const { uploadId } = review;
                    const name = projectName(review.projectId);
                    const detail = `${name} · ${review.reason}`;
                    const reviewAction =
                      uploadId && reviewUpload
                        ? () => reviewUpload(uploadId)
                        : onReviewItem && (() => onReviewItem(review));
                    return (
                      <div
                        className="sync-queue-row"
                        key={`${review.projectId}:${review.item.key}`}
                        role="group"
                        aria-label={`${review.item.title} in ${name}`}
                      >
                        <div className="sync-queue-project">
                          <strong title={review.item.title}>
                            {review.item.title}
                          </strong>
                          <small title={detail}>{detail}</small>
                        </div>
                        {reviewAction && (
                          <Button
                            variant="secondary"
                            size="sm"
                            className="sync-queue-action"
                            aria-label={
                              uploadId
                                ? undefined
                                : `Review ${review.item.title}`
                            }
                            disabled={uploadId ? busy : undefined}
                            onClick={() => leave(reviewAction)}
                          >
                            {uploadId ? "Review upload" : "Review"}
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </section>
              )}
              {attentionCount > 0 && (
                <h3 className="sync-menu-attention-heading">Needs attention</h3>
              )}
              {setup && (
                <section className="sync-menu-notification">
                  <h3>
                    {setup.deferred
                      ? "Project setup saved"
                      : setupRunning
                        ? "Initial project sync"
                        : "Project setup needs attention"}
                  </h3>
                  {setup.deferred ? (
                    <p>Resume where you left off when you’re ready.</p>
                  ) : (
                    <>
                      <p>
                        {
                          setupProjects.filter((p) => p.status === "synced")
                            .length
                        }{" "}
                        of {setupProjects.length} projects synced
                      </p>
                      <ul>
                        {setupProjects.map((p) => (
                          <li key={p.path}>
                            {p.name} ·{" "}
                            {p.status === "synced"
                              ? "Synced"
                              : p.error ||
                                (setupRunning ? "In progress" : "Pending")}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {!setupRunning && onResumeSetup && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => leave(onResumeSetup)}
                    >
                      {setup.deferred ? "Resume setup" : "Open setup recovery"}
                    </Button>
                  )}
                </section>
              )}
              {independentActionError && (
                <section
                  className="sync-menu-notification"
                  aria-label="Action details"
                >
                  <h3>Action details</h3>
                  <p>{actionError}</p>
                  {onDismissError && (
                    <Button
                      size="sm"
                      variant="tertiary"
                      onClick={onDismissError}
                    >
                      Dismiss
                    </Button>
                  )}
                </section>
              )}
              {attention.accountError && (
                <section
                  className="sync-menu-notification"
                  aria-label="Account sync"
                >
                  <h3>Account sync</h3>
                  <p>{attention.accountError}</p>
                </section>
              )}
              {attentionItems.map((item) => (
                <section
                  className="sync-menu-notification"
                  key={item.key}
                  role="group"
                  aria-label={item.title}
                >
                  <h4>{item.title}</h4>
                  {item.requests.length > 0 && (
                    <p>
                      {item.requests.length === 1
                        ? "A request is ready for your decision."
                        : `${item.requests.length} requests are ready for your decision.`}
                    </p>
                  )}
                  {item.binding && (
                    <p>
                      {item.binding.installationState === "locally_modified"
                        ? "Local edits are preserved. Review the shared update and local copies."
                        : "A local update needs review."}
                    </p>
                  )}
                  {item.draft && !item.binding && (
                    <p>Local changes are ready for review.</p>
                  )}
                  {item.messages.map((message) => (
                    <p key={message}>{message}</p>
                  ))}
                  {item.paths.length > 0 && (
                    <details>
                      <summary>
                        <ChevronRightIcon
                          className="sync-disclosure-chevron"
                          size={14}
                          aria-hidden="true"
                        />
                        Show affected copies ({item.paths.length})
                      </summary>
                      <ul>
                        {item.paths.map((path) => (
                          <li key={path}>{path}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {item.messages.map(
                    (message) =>
                      syncIssueRecovery(message) && (
                        <small key={message}>
                          {syncIssueRecovery(message)}
                        </small>
                      ),
                  )}
                  {item.messages.some((message) =>
                    /unsupported.*version|unsupported.*format/i.test(message),
                  ) && (
                    <small>
                      Requires compatible tool or transcript support in Orka.
                    </small>
                  )}
                  {item.conflicts.length > 0 ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        leave(() => onOpen(item.conflicts[0].resourceId))
                      }
                    >
                      Review conflict
                    </Button>
                  ) : reviewUpload &&
                    item.uploads.some((upload) => upload.reviewable) ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        leave(() =>
                          reviewUpload(
                            item.uploads.find((upload) => upload.reviewable)!
                              .id,
                          ),
                        )
                      }
                    >
                      Review upload
                    </Button>
                  ) : item.requests.length > 0 || item.binding || item.draft ? (
                    onReview && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => leave(onReview)}
                      >
                        Review changes
                      </Button>
                    )
                  ) : item.uploads.length > 0 ? (
                    item.uploads.every(
                      (upload) =>
                        !/^4\d\d:/.test(upload.error ?? "") ||
                        /^(401|408|429):/.test(upload.error ?? ""),
                    ) ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        onClick={onRetry}
                      >
                        Retry uploads
                      </Button>
                    ) : (
                      item.resourceId && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => leave(() => onOpen(item.resourceId!))}
                        >
                          View change
                        </Button>
                      )
                    )
                  ) : null}
                </section>
              ))}
              {needsReconnect && (
                <div className="sync-menu-notification">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy || !canConnect}
                    onClick={() => leave(onConnect)}
                  >
                    Reconnect folder
                  </Button>
                </div>
              )}
              {attention.waitingRequests.length > 0 && (
                <section className="sync-menu-notification">
                  <h3>Waiting for approval</h3>
                  {attention.waitingRequests.map((request) => (
                    <p key={request.id}>{request.title}</p>
                  ))}
                  {onReview && (
                    <Button
                      size="sm"
                      variant="tertiary"
                      onClick={() => leave(onReview)}
                    >
                      Open requests
                    </Button>
                  )}
                </section>
              )}
              {historyCount > 0 && (
                <section className="sync-menu-notification">
                  <details>
                    <summary>
                      <ChevronRightIcon
                        className="sync-disclosure-chevron"
                        size={14}
                        aria-hidden="true"
                      />
                      History ({historyCount})
                    </summary>
                    {attention.historyRequests.map((request) => (
                      <p key={request.id}>
                        {request.title} · {request.status}
                      </p>
                    ))}
                    {attention.historyDrafts.slice(0, 5).map((draft) => (
                      <p key={draft.id}>
                        {draft.resource.title} ·{" "}
                        {draft.dismissalReason === "superseded"
                          ? "superseded"
                          : draft.status}
                      </p>
                    ))}
                    {attention.historyDrafts.length > 5 && (
                      <p>
                        {attention.historyDrafts.length - 5} more saved changes
                      </p>
                    )}
                    {attention.activity.map((activity) => (
                      <div key={activity.id}>
                        <p>
                          {memberName(activity.author)} continued your session
                          as a copy.
                        </p>
                        <small>{resourceTitle(activity.copyId)}</small>
                        <Button
                          variant="tertiary"
                          size="sm"
                          onClick={() => leave(() => onOpen(activity.copyId))}
                        >
                          View copy
                        </Button>
                      </div>
                    ))}
                    {onReview &&
                      attention.historyRequests.length +
                        attention.historyDrafts.length >
                        0 && (
                        <Button
                          size="sm"
                          variant="tertiary"
                          onClick={() => leave(onReview)}
                        >
                          Open request history
                        </Button>
                      )}
                  </details>
                </section>
              )}
              {skillUsagePartial && (
                <section
                  className="sync-menu-notification"
                  aria-label="Skill usage details"
                >
                  <h3>Skill usage</h3>
                  <p>
                    Usage covers available local history; some records could not
                    be read.
                  </p>
                </section>
              )}
              {attention.accountIssues.length > 0 && (
                <section
                  className="sync-menu-notification"
                  aria-label="Account diagnostics"
                >
                  <details>
                    <summary>
                      <ChevronRightIcon
                        className="sync-disclosure-chevron"
                        size={14}
                        aria-hidden="true"
                      />
                      Account diagnostics ({attention.accountIssues.length})
                    </summary>
                    {attention.accountIssues.map((issue) => (
                      <div key={issue.source}>
                        <p>{issue.error}</p>
                        <small>
                          {issue.source.slice("history:unattributed:".length)}
                        </small>
                      </div>
                    ))}
                  </details>
                </section>
              )}
            </div>
          )}
          <div className="sync-menu-health">
            <span>
              <span
                className={`dot${connected ? " connected" : ""}`}
                aria-hidden="true"
              />
              {!running
                ? "Sync stopped"
                : connected
                  ? "Connected"
                  : state.sync?.online === false
                    ? "Offline"
                    : "Waiting to connect"}
            </span>
            <time
              dateTime={state.sync?.lastSync ?? undefined}
              title={
                state.sync?.lastSync
                  ? new Date(state.sync.lastSync).toLocaleString()
                  : undefined
              }
            >
              {lastSyncLabel(state.sync?.lastSync, now)}
            </time>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
