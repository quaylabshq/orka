import {
  BotIcon,
  CheckIcon,
  CircleDotIcon,
  ClockIcon,
  EyeIcon,
  FileDiffIcon,
  FileIcon,
  FolderIcon,
  HistoryIcon,
  RefreshCwIcon,
  ReplaceIcon,
  TagIcon,
  UserCheckIcon,
  UserIcon,
  XIcon,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { ReviewRequest, Resource } from "@portable/protocol";
import type { Snapshot } from "../types.js";
import { ActivityIndicator } from "./activity-indicator.js";
import { Button } from "./button.js";
import {
  DetailLayout,
  useDetailLayout,
  type DetailFact,
} from "./detail-layout.js";
import {
  changedFiles,
  type FileChange,
  type FileManifestEntry,
} from "./diff-model.js";
import { FileDiffCard, SourceCard, fileKind } from "./file-diff.js";
import { Icon } from "./icon.js";
import { LoadingRegion } from "./loading-region.js";
import type { GovernanceCatalog, ProjectCall } from "./project-permissions.js";
import type { Decision } from "./review-decisions.js";
import { ResourceContent } from "./resource-content.js";
import {
  audienceLabel,
  relativeSent,
  removalStatus,
  requestStatus,
  requestTitle,
  unsentStatus,
  versionChange,
} from "./review-presentation.js";
import { personName, StatusPill } from "./review-status.js";
import { SegmentedControl } from "./segmented-control.js";
import { readSkillMarkdown } from "./skill-markdown.js";
import { ReaderState } from "./skill-state.js";

/** Full file has something to show: text that still exists after the change. */
const readable = (change: FileChange) =>
  change.status !== "removed" && !change.binary;

export interface RequestDetail {
  request: ReviewRequest;
  files?: Record<string, string>;
  before?: Record<string, string>;
  audience?: string[];
  content?: { resource?: Resource };
  manifest?: FileManifestEntry[];
  beforeManifest?: FileManifestEntry[];
}

/**
 * One request on the shared detail layout: the change beside who asked, what
 * it affects, and the decision. A decided or waiting request reads the same
 * without the buttons.
 */
export function RequestReview({
  request: listed,
  state,
  catalog,
  repository,
  title: listedTitle,
  call,
  sending,
  unsent,
  onDecide,
}: {
  /** The request as the list knows it; the page fills in the rest. */
  request: ReviewRequest;
  state: Snapshot;
  catalog: GovernanceCatalog;
  repository?: string;
  title: string;
  call: ProjectCall;
  /** A decision already on its way, started before this page was reopened. */
  sending?: Decision;
  /** The last decision on this request did not reach the service. */
  unsent: boolean;
  /** Resolves with the request as the service left it; rejects when unsent. */
  onDecide: (
    detail: ReviewRequest,
    decision: Decision,
  ) => Promise<ReviewRequest>;
}) {
  const layout = useDetailLayout();
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [local, setDeciding] = useState<Decision | null>(null);
  const deciding = local ?? sending ?? null;
  const [mode, setMode] = useState<"changes" | "file">("changes");
  const [path, setPath] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      setDetail(await call<RequestDetail>("request", { id: listed.id }));
      void call("read-notification", { id: listed.id }).catch(() => {});
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [call, listed.id]);
  useEffect(() => {
    void load();
  }, [load]);
  // The list is reloaded after every decision, so once it shows an outcome
  // that outcome wins over what this page read earlier.
  const request =
    listed.status !== "pending" ? listed : (detail?.request ?? listed);
  const resource = detail?.content?.resource;
  const removed = Boolean(resource?.deleted);
  const changes = useMemo(
    () =>
      detail?.files
        ? changedFiles(detail.before ?? {}, removed ? {} : detail.files, {
            beforeManifest: detail.beforeManifest,
            afterManifest: removed ? [] : (detail.manifest ?? resource?.files),
          })
        : [],
    [detail, removed, resource],
  );
  const change = changes.find((item) => item.path === path) ?? changes[0];
  const name = (id: string) => personName(id, state.user, catalog.members);
  const pending = request.status === "pending";
  const canDecide = pending && Boolean(request.canReview) && !failed;
  const status = unsent
    ? unsentStatus
    : pending
      ? request.canReview
        ? null
        : requestStatus("pending")
      : requestStatus(request.status);
  const version = versionChange(request, removed);
  const seenBy = audienceLabel(detail?.audience, catalog.members, name);
  const audienceNames = detail?.audience?.map(name).join(", ");
  /** Values end in an ellipsis in the panel; the full text stays one hover away. */
  const text = (value: string) => <span title={value}>{value}</span>;
  const sent = relativeSent(request.createdAt);
  const memory = resource?.memory;
  const facts: DetailFact[] = [
    ...(status
      ? [
          {
            label: "Status",
            icon: CircleDotIcon,
            value: (
              <span role={unsent ? "alert" : undefined}>
                <StatusPill status={status} />
              </span>
            ),
          },
        ]
      : []),
    { label: "From", icon: UserIcon, value: text(name(request.author)) },
    {
      label: "Sent",
      icon: ClockIcon,
      value: <time dateTime={request.createdAt}>{sent}</time>,
    },
    ...(!pending && request.reviewer
      ? [
          {
            label: "Decided by",
            icon: UserCheckIcon,
            value: text(name(request.reviewer)),
          },
        ]
      : []),
    ...(repository
      ? [{ label: "Repository", icon: FolderIcon, value: text(repository) }]
      : []),
    ...(detail
      ? [{ label: "Version", icon: HistoryIcon, value: version }]
      : []),
    ...(memory
      ? [
          { label: "Topic", icon: TagIcon, value: text(memory.topic) },
          {
            label: "Scope",
            icon: TagIcon,
            value: text(memory.scope || "Project"),
          },
          { label: "Provider", icon: BotIcon, value: text(memory.provider) },
          ...(memory.supersedes?.length
            ? [
                {
                  label: "Replaces",
                  icon: ReplaceIcon,
                  value: text(memory.supersedes.join(", ")),
                },
              ]
            : []),
        ]
      : []),
    ...(seenBy
      ? [
          {
            label: "Seen by",
            icon: EyeIcon,
            value: (
              <span title={audienceNames}>
                {seenBy}
                {seenBy !== audienceNames && (
                  <span className="sr-only">: {audienceNames}</span>
                )}
              </span>
            ),
          },
        ]
      : []),
  ];
  const decide = (decision: Decision) => {
    if (deciding || !detail) return;
    setDeciding(decision);
    void onDecide(detail.request, decision)
      .then((result) => {
        // A stale result stays on this page with its new status.
        setDetail((current) =>
          current ? { ...current, request: result } : current,
        );
      })
      .catch(() => {})
      .finally(() => setDeciding(null));
  };
  const actions = canDecide ? (
    <>
      <Button
        variant="primary"
        disabled={!detail || deciding !== null}
        aria-busy={deciding === "approve"}
        onClick={() => decide("approve")}
      >
        {deciding === "approve" ? (
          <ActivityIndicator />
        ) : (
          <Icon icon={CheckIcon} size="sm" />
        )}
        Approve
      </Button>
      <Button
        variant="secondary"
        disabled={!detail || deciding !== null}
        aria-busy={deciding === "reject"}
        onClick={() => decide("reject")}
      >
        {deciding === "reject" ? (
          <ActivityIndicator />
        ) : (
          <Icon icon={XIcon} size="sm" />
        )}
        Reject
      </Button>
    </>
  ) : null;
  const description =
    resource?.kind === "skill" && detail?.files?.["SKILL.md"]
      ? readSkillMarkdown(detail.files["SKILL.md"]).description
      : "";
  const title = resource ? requestTitle(request, resource) : listedTitle;
  return (
    <DetailLayout
      layout={layout}
      label="Review"
      infoLabel="Request details"
      className={`resource-detail--review${actions ? "" : " resource-detail--readonly"}`}
      title={title}
      status={removed ? <StatusPill status={removalStatus} /> : undefined}
      summary={
        description ? (
          <p className="skill-description">{description}</p>
        ) : undefined
      }
      meta={
        <>
          {status && (
            <span role={unsent ? "alert" : undefined}>
              <StatusPill status={status} />
            </span>
          )}
          {[
            `From ${name(request.author)}`,
            sent,
            !pending && request.reviewer
              ? `Decided by ${name(request.reviewer)}`
              : undefined,
            repository,
            detail ? version : undefined,
            memory ? `Topic ${memory.topic}` : undefined,
            memory ? `Scope ${memory.scope || "Project"}` : undefined,
            memory ? `Provider ${memory.provider}` : undefined,
            memory?.supersedes?.length
              ? `Replaces ${memory.supersedes.join(", ")}`
              : undefined,
            seenBy ? `Seen by ${seenBy}` : undefined,
          ]
            .filter(Boolean)
            .join(" · ")}
        </>
      }
      facts={facts}
      note={
        seenBy ? (
          <p className="detail-info-note">Source restrictions still apply.</p>
        ) : undefined
      }
      primaryActions={actions}
      toolbar={
        detail && changes.some(readable) ? (
          <SegmentedControl
            label="Review view"
            value={mode}
            options={[
              {
                value: "changes",
                label: (
                  <>
                    <Icon icon={FileDiffIcon} size="sm" />
                    Changes
                  </>
                ),
              },
              {
                value: "file",
                label: (
                  <>
                    <Icon icon={FileIcon} size="sm" />
                    Full file
                  </>
                ),
              },
            ]}
            onChange={setMode}
          />
        ) : undefined
      }
      files={
        changes.length > 0
          ? {
              count: changes.length,
              rows: changes.map((item) => {
                const selected = item.path === change?.path;
                return (
                  <li key={item.path}>
                    <button
                      type="button"
                      className="detail-file"
                      aria-current={selected ? "true" : undefined}
                      title={item.path}
                      onClick={() => setPath(item.path)}
                    >
                      <Icon
                        icon={fileKind(item.path).listIcon}
                        size="sm"
                        variant={selected ? "primary" : "tertiary"}
                      />
                      <span className="detail-file-name">{item.path}</span>
                    </button>
                  </li>
                );
              }),
            }
          : undefined
      }
      bodyClassName="detail-document review-document"
    >
      {failed ? (
        <ReaderState
          illustration="file-unavailable-offline"
          title="Couldn’t load this request"
          tone="alert"
          action={
            <Button size="sm" variant="secondary" onClick={() => void load()}>
              <Icon icon={RefreshCwIcon} size="sm" />
              Retry
            </Button>
          }
        />
      ) : loading || !detail ? (
        <LoadingRegion
          id={`review:${listed.id}`}
          label="Loading request…"
          loading
          skeleton={
            <div className="review-skeleton" aria-hidden="true">
              {[62, 84, 48, 76, 58, 70].map((width, index) => (
                <span key={index} style={{ width: `${width}%` }} />
              ))}
            </div>
          }
        >
          <div />
        </LoadingRegion>
      ) : !change ? (
        <p className="detail-context">No file changes.</p>
      ) : mode === "file" && readable(change) ? (
        <SourceCard path={change.path} content={change.after} />
      ) : (
        <FileDiffCard
          {...change}
          showRemovedContent
          fallback={
            <ResourceContent
              inspection={{
                content: change.after,
                previous: change.before,
                paths: null,
              }}
              changes
              markdown={false}
            />
          }
        />
      )}
    </DetailLayout>
  );
}
