import React, { useEffect, useRef, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import type { Snapshot } from "../types.js";
import { Button } from "./button.js";
import { invoke } from "./product-command.js";
import {
  sessionRecoverySharingHint,
  type RecoveryEpisode,
  type RecoverySession,
} from "./session-recovery.js";

export type RecoveryResult = { queued: number; failures: string[] };

interface ReviewedSession {
  group: string;
  conflictId: string;
  revision: number;
  selected: boolean;
  expanded: boolean;
  queued?: boolean;
}

export function useSessionRecoveryReview({
  conflicts,
  outbox,
}: Pick<Snapshot, "conflicts" | "outbox">) {
  const [rows, setRows] = useState(new Map<string, ReviewedSession>());
  const [working, setWorking] = useState(false);
  const inFlight = useRef(false);
  // SyncMenu lives across popover and card remounts. Its project and account
  // keys isolate these choices from every other workspace.
  useEffect(() => {
    setRows((previous) => {
      if (!previous.size) return previous;
      const unresolved = new Set(conflicts.map((c) => c.resourceId));
      const pending = new Set(outbox.map((entry) => entry.resourceId));
      const next = new Map(previous);
      for (const [id, row] of previous) {
        if (!unresolved.has(id)) next.delete(id);
        // Once the snapshot shows the request, the outbox owns its status.
        // A later rejection or cancellation must allow another explicit choice.
        else if (row.queued && pending.has(id))
          next.set(id, { ...row, queued: false });
      }
      return next;
    });
  }, [conflicts, outbox]);
  function update(
    group: string,
    sessions: RecoverySession[],
    changes: (
      session: RecoverySession,
    ) => Omit<ReviewedSession, "group" | "conflictId" | "revision">,
  ) {
    setRows((previous) => {
      const next = new Map(previous);
      for (const session of sessions) {
        next.set(session.id, {
          group,
          conflictId: session.conflictId,
          revision: session.revision,
          ...changes(session),
        });
      }
      return next;
    });
  }
  async function submit(
    group: string,
    selected: RecoverySession[],
    choice: "keep" | "restore",
    onFinish: (result: RecoveryResult) => void,
  ) {
    if (inFlight.current || !selected.length) return;
    inFlight.current = true;
    setWorking(true);
    const failures: string[] = [];
    const done: RecoverySession[] = [];
    for (const session of selected) {
      try {
        await invoke("resolve_session_recovery", {
          id: session.id,
          projectId: session.projectId,
          expectedRevision: session.revision,
          conflictId: session.conflictId,
          choice,
          singleCandidate: true,
        });
        done.push(session);
      } catch (error) {
        failures.push(
          `${session.title} — ${String(error).replace(/^Error: /, "")}`,
        );
      }
    }
    update(group, done, () => ({
      selected: false,
      expanded: true,
      queued: true,
    }));
    setWorking(false);
    inFlight.current = false;
    onFinish({ queued: done.length, failures });
  }
  return { rows, update, working, submit };
}

export function SessionRecoveryCard({
  episode,
  device,
  busy,
  sharing,
  review,
  onOpen,
  onFinish,
}: {
  episode: RecoveryEpisode;
  device?: string;
  busy: boolean;
  sharing: boolean;
  review: ReturnType<typeof useSessionRecoveryReview>;
  onOpen: (id: string) => void;
  onFinish: (result: RecoveryResult) => void;
}) {
  // Regrouping can bring sessions from two earlier reviews into one card.
  // Carry only the active group's choices into that action.
  const prior = episode.sessions.map((s) => review.rows.get(s.id));
  const existing =
    prior.find((row) => row?.expanded) ?? prior.find((row) => row);
  const group = existing?.group ?? episode.sessions[0].conflictId;
  const expanded = existing?.expanded === true;
  function pinned(session: RecoverySession) {
    const row = review.rows.get(session.id);
    return row?.conflictId === session.conflictId &&
      row.revision === session.revision
      ? row
      : undefined;
  }
  function isSelected(session: RecoverySession) {
    const row = pinned(session);
    return !existing || (row?.group === group && row.selected);
  }
  const selected = episode.sessions.filter(isSelected);
  const disabled = busy || review.working || !sharing;
  function toggle() {
    review.update(group, episode.sessions, (session) => ({
      selected: isSelected(session),
      queued: pinned(session)?.queued,
      expanded: !expanded,
    }));
  }
  const heading = `${episode.sessions.length} deleted sessions have incoming copies`;
  return (
    <section
      className="sync-menu-notification"
      role="group"
      aria-label={heading}
    >
      <h4>{heading}</h4>
      <p>Uploaded from {device || "the same device"} within five minutes.</p>
      <details open={expanded}>
        <summary
          onClick={(event) => {
            event.preventDefault();
            toggle();
          }}
        >
          <ChevronRightIcon
            className="sync-disclosure-chevron"
            size={14}
            aria-hidden
          />
          Review sessions
        </summary>
        <div className="session-recovery-list">
          {episode.sessions.map((session) => (
            <div key={session.id} className="session-recovery-row">
              <label>
                <input
                  type="checkbox"
                  checked={isSelected(session)}
                  disabled={disabled || pinned(session)?.queued}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    review.update(group, [session], () => ({
                      selected: checked,
                      expanded: true,
                    }));
                  }}
                />
                {session.title}
              </label>
              <Button
                variant="tertiary"
                size="sm"
                aria-label={`Review ${session.title}`}
                disabled={review.working}
                onClick={() => onOpen(session.id)}
              >
                View
              </Button>
            </div>
          ))}
          <small>
            {sharing
              ? "Restoring makes the selected incoming copies shared again. Keeping them deleted discards those copies."
              : sessionRecoverySharingHint}
          </small>
          <div className="session-recovery-actions">
            <Button
              variant="secondary"
              size="sm"
              disabled={disabled || !selected.length}
              onClick={() =>
                void review.submit(group, selected, "keep", onFinish)
              }
            >
              Keep deleted ({selected.length})
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={disabled || !selected.length}
              onClick={() =>
                void review.submit(group, selected, "restore", onFinish)
              }
            >
              Restore ({selected.length})
            </Button>
          </div>
        </div>
      </details>
    </section>
  );
}
