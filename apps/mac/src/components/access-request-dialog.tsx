import { ArrowRightIcon } from "lucide-react";
import React, { useState } from "react";
import type { ReviewRequest } from "@portable/protocol";
import { ActivityIndicator } from "./activity-indicator.js";
import { Button } from "./button.js";
import { Modal } from "./modal.js";
import {
  accessNames,
  memberRule,
  type GovernanceCatalog,
} from "./project-permissions.js";
import {
  accessSentence,
  relativeSent,
  requestStatus,
  unsentStatus,
} from "./review-presentation.js";
import { StatusPill } from "./review-status.js";
import type { Decision, DecisionFailure } from "./review-decisions.js";

/** An access request has nothing to read, so it is decided in a small dialog. */
export function AccessRequestDialog({
  request,
  catalog,
  title,
  author,
  sending,
  failure,
  onDecide,
  onClose,
  onCloseAutoFocus,
}: {
  request: ReviewRequest;
  catalog: GovernanceCatalog;
  /** "Access to Sessions". */
  title: string;
  author: string;
  /** A decision already on its way, started before the dialog was reopened. */
  sending?: Decision;
  failure?: DecisionFailure;
  onDecide: (request: ReviewRequest, decision: Decision) => Promise<void>;
  onClose: () => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const [local, setDeciding] = useState<Decision | null>(null);
  const deciding = local ?? sending ?? null;
  const pending = request.status === "pending";
  const canDecide = pending && Boolean(request.canReview);
  const unsent = pending && failure && !failure.serviceRejected;
  const decisionError = failure?.serviceRejected && failure.message;
  const current = request.requestedClass
    ? memberRule(catalog, request.author, request.requestedClass)?.mode
    : undefined;
  // A request the app cannot name still gets a sentence that reads.
  const named = title.startsWith("Access to ");
  const target = named ? title.slice("Access to ".length) : "this item";
  const heading = !canDecide
    ? title
    : named
      ? `Approve access to ${target}?`
      : "Approve this access request?";
  const status = unsent
    ? unsentStatus
    : canDecide
      ? null
      : requestStatus(request.status);
  // A level this build does not know is left out, not shown as an empty pill.
  const requested = request.requestedMode
    ? accessNames[request.requestedMode]
    : undefined;
  const decide = (decision: Decision) => {
    if (deciding) return;
    setDeciding(decision);
    void onDecide(request, decision)
      .catch(() => {})
      .finally(() => setDeciding(null));
  };
  return (
    <Modal
      title={heading}
      size="compact"
      className="settings-confirm access-request-dialog"
      closeDisabled={deciding !== null}
      footer={
        canDecide && (
          <>
            <Button
              size="sm"
              variant="secondary"
              disabled={deciding !== null}
              aria-busy={deciding === "reject"}
              onClick={() => decide("reject")}
            >
              {deciding === "reject" && <ActivityIndicator />}
              Reject
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={deciding !== null}
              aria-busy={deciding === "approve"}
              onClick={() => decide("approve")}
            >
              {deciding === "approve" && <ActivityIndicator />}
              Approve
            </Button>
          </>
        )
      }
      onClose={() => {
        if (!deciding) onClose();
      }}
      onEscapeKeyDown={(event) => {
        if (deciding) event.preventDefault();
      }}
      onCloseAutoFocus={onCloseAutoFocus}
    >
      <p>
        {accessSentence({
          name: author,
          sent: relativeSent(request.createdAt),
          target,
          requested: request.requestedMode,
          current,
        })}
      </p>
      {requested && (
        <div className="access-request-change">
          {current && current !== request.requestedMode && (
            <>
              <span className="access-request-level">
                {accessNames[current]}
              </span>
              <ArrowRightIcon size={14} aria-hidden="true" />
              <span className="sr-only">to</span>
            </>
          )}
          <span className="access-request-level">{requested}</span>
        </div>
      )}
      {status && (
        <div role={unsent ? "alert" : "status"}>
          <StatusPill status={status} />
        </div>
      )}
      {decisionError && (
        <p className="detail-info-note detail-info-note--error" role="alert">
          {decisionError}
        </p>
      )}
    </Modal>
  );
}
