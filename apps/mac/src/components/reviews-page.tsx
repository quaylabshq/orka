import {
  ChevronRightIcon,
  CircleDotIcon,
  ClockIcon,
  FileDiffIcon,
  FileIcon,
  FolderIcon,
  HistoryIcon,
  KeyRoundIcon,
  LayersIcon,
  ListChecksIcon,
  MessagesSquareIcon,
  MonitorIcon,
  RefreshCwIcon,
  ScrollTextIcon,
  UserIcon,
  UsersIcon,
} from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { defaultProjectRules, type ReviewRequest } from "@portable/protocol";
import type { Project, Snapshot } from "../types.js";
import { Button } from "./button.js";
import { CollectionSkeleton } from "./collection-skeleton.js";
import { AccessRequestDialog } from "./access-request-dialog.js";
import { Icon } from "./icon.js";
import { IconButton } from "./icon-button.js";
import type { IconGlyph } from "./icons.js";
import { LoadingRegion } from "./loading-region.js";
import { PermissionSetup } from "./permission-setup.js";
import {
  ProjectChangeReview,
  type SuggestionDetail,
} from "./project-change-review.js";
import {
  governanceCall,
  type GovernanceCatalog,
} from "./project-permissions.js";
import { repositoryLabel } from "./project-sources.js";
import { displayText } from "./resource-presentation.js";
import { RequestReview } from "./request-review.js";
import {
  reviewDecisions,
  useReviewDecisions,
  type Decision,
} from "./review-decisions.js";
import {
  localStatus,
  relativeSent,
  requestKind,
  requestStatus,
  requestTitle,
  type ReviewKind,
} from "./review-presentation.js";
import { Person, personName, StatusPill } from "./review-status.js";
import { SegmentedControl } from "./segmented-control.js";
import { ReaderState } from "./skill-state.js";
import { projectAttention } from "./sync-attention.js";
import { useToastNotice, useToasts } from "./toasts.js";
import "./reviews-page.css";

export type ReviewsView = "open" | "history";
const rememberedViews = new Map<string, ReviewsView>();

const kindIcons: Record<ReviewKind | "change", IconGlyph> = {
  access: KeyRoundIcon,
  change: FileDiffIcon,
  memory: LayersIcon,
  plan: ScrollTextIcon,
  session: MessagesSquareIcon,
  skill: FileIcon,
};
const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function Repository({ name }: { name?: string }) {
  if (!name) return null;
  return (
    <span
      className="review-repository"
      title={name}
      aria-label={`Repository: ${name}`}
    >
      <FolderIcon size={14} aria-hidden="true" />
      <span>{name}</span>
    </span>
  );
}

function Sent({ value }: { value: string }) {
  const date = new Date(value);
  return (
    <time
      dateTime={value}
      title={Number.isNaN(date.getTime()) ? undefined : dateTime.format(date)}
    >
      {relativeSent(value)}
    </time>
  );
}

interface Column {
  id: "repository" | "person" | "date" | "status";
  label: string;
  icon: IconGlyph;
}
interface Row {
  key: string;
  icon: IconGlyph;
  title: string;
  cells: React.ReactNode[];
  onOpen: () => void;
}

/** A titled table whose whole row opens the review. */
function ReviewSection({
  title,
  first,
  columns,
  rows,
  disabled,
}: {
  title?: string;
  first: string;
  columns: Column[];
  rows: Row[];
  disabled: boolean;
}) {
  const heading = React.useId();
  return (
    <section
      className="review-section"
      aria-labelledby={title ? heading : undefined}
      aria-label={title ? undefined : first + "s"}
    >
      {title && (
        <h2 id={heading} className="review-section-title">
          {title} <span>{rows.length}</span>
        </h2>
      )}
      <table
        className={`resource-table review-table${title ? "" : " review-table--history"}`}
      >
        <colgroup>
          <col />
          {columns.map((column) => (
            <col key={column.id} className={`review-col-${column.id}`} />
          ))}
          <col className="review-col-open" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">
              <span className="review-column">
                <FileIcon size={14} aria-hidden="true" />
                {first}
              </span>
            </th>
            {columns.map((column) => (
              <th
                key={column.id}
                scope="col"
                className={`review-cell-${column.id}`}
              >
                <span className="review-column">
                  <column.icon size={14} aria-hidden="true" />
                  {column.label}
                </span>
              </th>
            ))}
            <th scope="col">
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.key}
              aria-disabled={disabled || undefined}
              onClick={(event) => {
                if (disabled) return;
                // WebKit does not focus a clicked control, so name the row's
                // button as the place focus returns to when the review closes.
                event.currentTarget
                  .querySelector<HTMLElement>(".resource-table-open")
                  ?.focus();
                row.onOpen();
              }}
            >
              <th scope="row" className="resource-table-title">
                <div className="resource-table-title-content">
                  <row.icon
                    className="review-kind"
                    size={16}
                    aria-hidden="true"
                  />
                  <button
                    type="button"
                    className="resource-table-open"
                    title={row.title}
                    data-review-id={row.key}
                    disabled={disabled}
                    onClick={(event) => {
                      event.stopPropagation();
                      event.currentTarget.focus();
                      row.onOpen();
                    }}
                  >
                    {row.title}
                  </button>
                </div>
              </th>
              {columns.map((column, index) => (
                <td key={column.id} className={`review-cell-${column.id}`}>
                  {row.cells[index]}
                </td>
              ))}
              <td className="review-cell-open">
                <ChevronRightIcon size={16} aria-hidden="true" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

const repositoryColumn: Column = {
  id: "repository",
  label: "Repository",
  icon: FolderIcon,
};
const statusColumn: Column = {
  id: "status",
  label: "Status",
  icon: CircleDotIcon,
};
const sentColumn: Column = { id: "date", label: "Sent", icon: ClockIcon };

/** Fades the edge of a scrolling list where rows are hidden. */
function useScrollFade(content: string) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => {
      node.toggleAttribute("data-fade-top", node.scrollTop > 1);
      node.toggleAttribute(
        "data-fade-bottom",
        node.scrollTop + node.clientHeight < node.scrollHeight - 1,
      );
    };
    update();
    node.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(node);
    for (const child of Array.from(node.children)) observer.observe(child);
    return () => {
      node.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [content]);
  return ref;
}

export interface ReviewSelection {
  id: string;
  /** The requests the stepper walks: the section the review was opened from. */
  queue: string[];
}

export function ReviewsPage({
  project,
  scope,
  state,
  review,
  onReview,
  destination,
  onDestinationShown,
  onRefresh,
  onReviewFile,
}: {
  project: Project;
  scope: string;
  state: Snapshot;
  /** The request open on the review page; the list stays mounted behind it. */
  review: ReviewSelection | null;
  onReview: (review: ReviewSelection | null) => void;
  destination?: { view: ReviewsView; request: symbol };
  onDestinationShown: (request: symbol) => void;
  onRefresh: () => Promise<void>;
  onReviewFile: (id: string) => void;
}) {
  const [catalog, setCatalog] = useState<GovernanceCatalog | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The view survives a trip through Settings, which unmounts this page.
  const [view, setView] = useState<ReviewsView>(
    () => rememberedViews.get(scope) ?? "open",
  );
  useEffect(() => {
    rememberedViews.set(scope, view);
  }, [scope, view]);
  const setMessage = useToastNotice();
  const { notify } = useToasts();
  const root = useRef<HTMLElement>(null);
  const [access, setAccess] = useState<string | null>(null);
  const settled = useReviewDecisions();
  const decision = (id: string) => reviewDecisions.get(scope, id);
  const mounted = useRef(true);
  const loadGeneration = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [suggestion, setSuggestion] = useState<SuggestionDetail | null>(null);
  const call = useCallback(
    <T,>(action: string, input: Record<string, unknown> = {}) =>
      governanceCall<T>(action, { projectId: project.id, ...input }),
    [project.id],
  );
  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    try {
      const value = await call<GovernanceCatalog>("catalog");
      if (mounted.current && generation === loadGeneration.current) {
        setCatalog(value);
        setLoadFailed(false);
      }
      return value;
    } catch (error) {
      if (mounted.current && generation === loadGeneration.current)
        setLoadFailed(true);
      throw error;
    }
  }, [call]);
  // Snapshots are polled even when nothing changed. Revalidate only when
  // a request changes, ignoring notification-read updates and list order.
  const requestState = JSON.stringify(
    (state.reviewRequests ?? [])
      .filter((item) => item.projectId === project.id)
      .map(({ id, status, canReview }) => [id, status, canReview])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
  );
  useEffect(() => {
    void load().catch(() => {});
  }, [load, project.policyRevision, requestState]);
  const focusView = useRef<ReviewsView | null>(null);
  useEffect(() => {
    if (!destination) return;
    focusView.current = destination.view;
    setView(destination.view);
    onDestinationShown(destination.request);
  }, [destination, onDestinationShown]);
  useEffect(() => {
    if (focusView.current !== view) return;
    focusView.current = null;
    root.current
      ?.querySelector<HTMLElement>('.reviews-views [aria-pressed="true"]')
      ?.focus();
  });
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
      await load();
      await onRefresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const retry = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await load();
      await onRefresh();
    } catch {
      setLoadFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const members = catalog?.members ?? [];
  // The decision response is authoritative even if reading the catalog fails.
  const requests = (catalog?.requests ?? []).map((item) => {
    const outcome = decision(item.id).outcome;
    return outcome ? { ...item, ...outcome } : item;
  });
  useEffect(() => {
    if (catalog) reviewDecisions.confirm(scope, catalog.requests);
  }, [scope, catalog, settled]);
  const attention = catalog
    ? projectAttention({ ...state, reviewRequests: requests }, project.id)
    : null;
  const resources = new Map(
    state.resources
      .filter((resource) => resource.projectId === project.id)
      .map((resource) => [resource.resourceId, resource]),
  );
  const repositoryName = (resource?: { sourceId?: string | null }) =>
    repositoryLabel(project.sources ?? [], resource?.sourceId ?? undefined);
  const repository = (resource?: { sourceId?: string | null }) => (
    <Repository name={repositoryName(resource)} />
  );
  const titleOf = (item: ReviewRequest) =>
    requestTitle(item, resources.get(item.resourceId));
  /** Sends one decision. The lists refresh behind it; a failed refresh is not a failed decision. */
  const decide = async (item: ReviewRequest, choice: Decision) => {
    const prior = decision(item.id);
    if (prior.sending || prior.outcome)
      throw new Error("Decision already submitted");
    reviewDecisions.start(scope, item.id, choice);
    let result: ReviewRequest;
    try {
      result = await call<ReviewRequest>("decide", {
        id: item.id,
        decision: choice,
        previewHash: item.previewHash,
        expectedPolicyRevision: catalog!.policyRevision,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /^4\d\d(?=:)/.exec(message)?.[0];
      const latest =
        status === "403" || status === "409"
          ? await load().catch(() => undefined)
          : undefined;
      const failure = {
        serviceRejected: Boolean(status),
        message: message.replace(/^4\d\d:\s*/, ""),
      };
      reviewDecisions.fail(scope, item.id, failure);
      // The message still matters if the reviewer left or lost access.
      if (
        !mounted.current ||
        viewing.current !== item.id ||
        (latest && !latest.requests.some(({ id }) => id === item.id))
      ) {
        if (failure.serviceRejected && failure.message)
          notify({ title: failure.message, kind: "error" });
        else setMessage(`Couldn’t send your decision on ${titleOf(item)}`);
      }
      throw error;
    }
    // The request stays locked until the lists show its new status.
    await load()
      .then(onRefresh)
      .catch(() => {})
      .finally(() => reviewDecisions.settle(scope, item.id, result));
    setMessage(
      result.status === "stale"
        ? "The resource or permissions changed. A refreshed suggestion is needed."
        : `${result.status === "approved" ? "Approved" : "Rejected"} ${titleOf(item)}`,
    );
    return result;
  };
  const openAccess = (item: ReviewRequest) => {
    setAccess(item.id);
    void call("read-notification", { id: item.id }).catch(() => {});
  };
  // A decision can land after the reviewer has moved on. It must not pull them back.
  const viewing = useRef<string | undefined>(undefined);
  useEffect(() => {
    viewing.current = review?.id ?? access ?? undefined;
    return () => {
      viewing.current = undefined;
    };
  });
  // A page mounted after a decision was sent reloads once it settles.
  const seenSettled = useRef(settled);
  useEffect(() => {
    if (seenSettled.current === settled) return;
    seenSettled.current = settled;
    void load().catch(() => {});
  }, [settled, load]);
  const newest = (a: ReviewRequest, b: ReviewRequest) =>
    b.createdAt.localeCompare(a.createdAt);
  const requestRows = (
    items: ReviewRequest[],
    cells: (item: ReviewRequest) => React.ReactNode[],
  ): Row[] => {
    const sorted = [...items].sort(newest);
    // Access requests open a dialog, so the stepper walks only the pages.
    const queue = sorted
      .filter((item) => item.type !== "access")
      .map((item) => item.id);
    return sorted.map((item) => {
      const resource = resources.get(item.resourceId);
      return {
        key: item.id,
        icon: kindIcons[requestKind(item, resource) ?? "change"],
        title: titleOf(item),
        cells: [repository(resource), ...cells(item)],
        onOpen: () =>
          item.type === "access"
            ? openAccess(item)
            : onReview({ id: item.id, queue }),
      };
    });
  };
  const person = (id?: string | null) =>
    id ? <Person id={id} user={state.user} members={members} /> : null;
  const toDecide = requestRows(
    attention?.items.flatMap((item) => item.requests) ?? [],
    (item) => [person(item.author), <Sent value={item.createdAt} />],
  );
  const sentByYou = requestRows(attention?.waitingRequests ?? [], (item) => [
    <Sent value={item.createdAt} />,
    <StatusPill status={requestStatus(item.status)} />,
  ]);
  // An item can hold a shared update and local edits at once. Each keeps its
  // own row, because each opens a different review.
  const onThisMac = (
    attention?.items.filter((item) => item.binding || item.draft) ?? []
  ).flatMap((item): Row[] => {
    const resource = item.resourceId
      ? resources.get(item.resourceId)
      : undefined;
    const title = displayText(item.title).trim() || "Untitled";
    const { binding, draft, resourceId } = item;
    const rows: Row[] = [];
    if (binding && resourceId)
      rows.push({
        key: `${item.key}:update`,
        icon: UsersIcon,
        title,
        cells: [
          repository(resource),
          person(resource?.updatedBy),
          <StatusPill status={localStatus(item)} />,
        ],
        onOpen: () => onReviewFile(resourceId),
      });
    if (draft)
      rows.push({
        key: `${item.key}:edits`,
        icon: MonitorIcon,
        title,
        cells: [
          repository(resource ?? draft.resource),
          person(state.user),
          <StatusPill status={localStatus({ draft })} />,
        ],
        onOpen: () =>
          void run(async () => {
            setSuggestion(
              await call<SuggestionDetail>("draft", { id: draft.id }),
            );
          }),
      });
    return rows;
  });
  const history = requestRows(attention?.historyRequests ?? [], (item) => [
    person(item.author),
    <StatusPill status={requestStatus(item.status)} />,
    <Sent value={item.createdAt} />,
  ]);
  const personColumn = (label: string): Column => ({
    id: "person",
    label,
    icon: UserIcon,
  });
  const scroll = useScrollFade(
    [view, toDecide.length, sentByYou.length, onThisMac.length, history.length]
      .concat(catalog ? 1 : 0, review ? 1 : 0, error ? 1 : 0)
      .join(),
  );
  const reviewed = review
    ? requests.find((item) => item.id === review.id)
    : undefined;
  const accessRequest = access
    ? requests.find((item) => item.id === access)
    : undefined;
  const lostAccess = Boolean(access && catalog && !accessRequest);
  useEffect(() => {
    if (lostAccess) setAccess(null);
  }, [lostAccess]);
  const lostReview = Boolean(review && catalog && !reviewed);
  useEffect(() => {
    // The request left the project while its page was open.
    if (lostReview) onReview(null);
  }, [lostReview, onReview]);

  const openedId = reviewed?.id;
  const returnTo = useRef<string | null>(null);
  const advanced = useRef(false);
  useEffect(() => {
    // Opening a review moves focus onto the page. Going back returns it to
    // the row it came from, or to the page when that row is gone.
    if (openedId) {
      // Also after a decision, when the button that had focus is gone.
      if (!returnTo.current || advanced.current) root.current?.focus();
      advanced.current = false;
      returnTo.current = openedId;
      return;
    }
    const from = returnTo.current;
    if (!from) return;
    returnTo.current = null;
    (
      root.current?.querySelector<HTMLElement>(
        `[data-review-id="${CSS.escape(from)}"]`,
      ) ?? root.current
    )?.focus();
  }, [openedId]);
  return (
    <section
      className="reviews-page"
      aria-label="Reviews"
      ref={root}
      tabIndex={-1}
    >
      {review && reviewed && catalog && (
        <RequestReview
          key={reviewed.id}
          request={reviewed}
          state={state}
          catalog={catalog}
          sources={project.sources}
          listedSourceId={resources.get(reviewed.resourceId)?.sourceId}
          title={titleOf(reviewed)}
          call={call}
          sending={decision(reviewed.id).sending}
          failure={decision(reviewed.id).failure}
          onDecide={async (item, decision) => {
            const result = await decide(item, decision);
            if (result.status !== "stale" && viewing.current === item.id) {
              // The next request takes this one's place; after the last, the list.
              const index = review.queue.indexOf(item.id);
              const queue = review.queue.filter((id) => id !== item.id);
              const next = index >= 0 ? queue[index] : undefined;
              advanced.current = true;
              onReview(next ? { id: next, queue } : null);
            }
          }}
        />
      )}
      <div className="reviews-scroll" ref={scroll} hidden={Boolean(reviewed)}>
        {catalog?.governed !== false && (
          <div className="reviews-toolbar">
            <SegmentedControl
              className="reviews-views"
              label="Reviews view"
              value={view}
              options={[
                {
                  value: "open",
                  label: (
                    <>
                      <Icon icon={ListChecksIcon} size="sm" />
                      Open
                    </>
                  ),
                },
                {
                  value: "history",
                  label: (
                    <>
                      <Icon icon={HistoryIcon} size="sm" />
                      History
                    </>
                  ),
                },
              ]}
              onChange={setView}
            />
            <IconButton
              icon={RefreshCwIcon}
              size="sm"
              variant="tertiary"
              aria-label="Refresh reviews"
              title="Refresh reviews"
              disabled={busy}
              onClick={() => void (catalog ? run(async () => {}) : retry())}
            />
          </div>
        )}
        {error && !suggestion && (
          <p className="reviews-error" role="alert">
            {error}
          </p>
        )}
        {catalog && loadFailed && !error && (
          <div className="reviews-error">
            <p role="alert">Couldn’t refresh reviews.</p>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => void retry()}
            >
              <Icon icon={RefreshCwIcon} size="sm" />
              Retry
            </Button>
          </div>
        )}
        {!catalog && loadFailed ? (
          <ReaderState
            illustration="file-unavailable-offline"
            title="Couldn’t load reviews"
            tone="alert"
            action={
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => void retry()}
              >
                <Icon icon={RefreshCwIcon} size="sm" />
                Retry
              </Button>
            }
          />
        ) : !catalog ? (
          <LoadingRegion
            id={`reviews:${project.id}`}
            label="Loading reviews…"
            loading
            skeleton={<CollectionSkeleton />}
          >
            <div />
          </LoadingRegion>
        ) : !catalog.governed ? (
          <PermissionSetup
            heading="h2"
            catalog={catalog}
            queuedChanges={
              state.outbox.filter((item) => item.project === project.id).length
            }
            busy={busy}
            onEnable={() =>
              void run(async () => {
                await call("activate", {
                  expectedPolicyRevision: catalog.policyRevision,
                  rules: defaultProjectRules,
                });
              })
            }
          />
        ) : view === "history" ? (
          history.length ? (
            <ReviewSection
              first="Request"
              columns={[
                repositoryColumn,
                personColumn("From"),
                { ...statusColumn, label: "Outcome" },
                sentColumn,
              ]}
              rows={history}
              disabled={busy}
            />
          ) : (
            !loadFailed && (
              <ReaderState
                illustration="previous-version-unavailable"
                title="No decisions yet"
              />
            )
          )
        ) : toDecide.length + sentByYou.length + onThisMac.length === 0 ? (
          !loadFailed && (
            <ReaderState illustration="up-to-date" title="Nothing to review" />
          )
        ) : (
          <>
            {toDecide.length > 0 && (
              <ReviewSection
                title="To decide"
                first="Request"
                columns={[repositoryColumn, personColumn("From"), sentColumn]}
                rows={toDecide}
                disabled={busy}
              />
            )}
            {sentByYou.length > 0 && (
              <ReviewSection
                title="Sent by you"
                first="Item"
                columns={[repositoryColumn, sentColumn, statusColumn]}
                rows={sentByYou}
                disabled={busy}
              />
            )}
            {onThisMac.length > 0 && (
              <ReviewSection
                title="On this Mac"
                first="Item"
                columns={[
                  repositoryColumn,
                  personColumn("Changed by"),
                  statusColumn,
                ]}
                rows={onThisMac}
                disabled={busy}
              />
            )}
          </>
        )}
      </div>
      {accessRequest && catalog && (
        <AccessRequestDialog
          key={accessRequest.id}
          request={accessRequest}
          catalog={catalog}
          title={titleOf(accessRequest)}
          author={personName(accessRequest.author, state.user, members)}
          sending={decision(accessRequest.id).sending}
          failure={decision(accessRequest.id).failure}
          onDecide={async (item, decision) => {
            const result = await decide(item, decision);
            if (result.status !== "stale") setAccess(null);
          }}
          onClose={() => setAccess(null)}
          onCloseAutoFocus={(event) => {
            // A row opened by pointer leaves focus on the page body. Return it
            // to that row, or to the page when the decision removed the row.
            event.preventDefault();
            (
              root.current?.querySelector<HTMLElement>(
                `[data-review-id="${CSS.escape(accessRequest.id)}"]`,
              ) ?? root.current
            )?.focus();
          }}
        />
      )}
      {suggestion && (
        <ProjectChangeReview
          detail={suggestion}
          busy={busy}
          error={error}
          onClose={() => setSuggestion(null)}
          onRefresh={() =>
            run(async () => {
              await call("refresh-draft", { id: suggestion.draft.id });
              setSuggestion(
                await call<SuggestionDetail>("draft", {
                  id: suggestion.draft.id,
                }),
              );
            })
          }
          onSubmit={() =>
            run(async () => {
              await call("submit-draft", {
                id: suggestion.draft.id,
                reviewedFiles: suggestion.draft.resource.files,
                ...(suggestion.baseRevision === undefined
                  ? {}
                  : { reviewedRevision: suggestion.baseRevision }),
              });
              setSuggestion(null);
              setMessage(
                suggestion.canPublish
                  ? "Change queued for sharing."
                  : "Suggestion submitted for publisher review.",
              );
            })
          }
        />
      )}
    </section>
  );
}
