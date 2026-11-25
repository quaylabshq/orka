import React, { useRef, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { Button } from "./button.js";
import { invoke } from "./product-command.js";
import type { RecoveryEpisode } from "./session-recovery.js";

export type RecoveryResult = { queued: number; failures: string[] };

export function SessionRecoveryCard({
  episode,
  device,
  busy,
  onOpen,
  onFinish,
}: {
  episode: RecoveryEpisode;
  device?: string;
  busy: boolean;
  onOpen: (id: string) => void;
  onFinish: (result: RecoveryResult) => void;
}) {
  const [excluded, setExcluded] = useState<string[]>([]);
  const [queued, setQueued] = useState<string[]>([]);
  const [working, setWorking] = useState(false);
  const inFlight = useRef(false);
  const selected = episode.sessions.filter(
    (s) => !excluded.includes(s.id) && !queued.includes(s.id),
  );
  async function submit(choice: "keep" | "restore") {
    if (inFlight.current || !selected.length) return;
    inFlight.current = true;
    setWorking(true);
    const failures: string[] = [];
    const done: string[] = [];
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
        done.push(session.id);
      } catch (error) {
        failures.push(
          `${session.title} — ${String(error).replace(/^Error: /, "")}`,
        );
      }
    }
    setQueued((previous) => [...previous, ...done]);
    setWorking(false);
    inFlight.current = false;
    onFinish({ queued: done.length, failures });
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
      <details>
        <summary>
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
                  checked={
                    !queued.includes(session.id) &&
                    !excluded.includes(session.id)
                  }
                  disabled={working || busy || queued.includes(session.id)}
                  onChange={(e) =>
                    setExcluded((ids) =>
                      e.target.checked
                        ? ids.filter((id) => id !== session.id)
                        : [...ids, session.id],
                    )
                  }
                />
                {session.title}
              </label>
              <Button
                variant="tertiary"
                size="sm"
                aria-label={`Review ${session.title}`}
                disabled={working}
                onClick={() => onOpen(session.id)}
              >
                View
              </Button>
            </div>
          ))}
          <small>
            Restoring makes the selected incoming copies shared again. Keeping
            them deleted discards those copies.
          </small>
          <div className="session-recovery-actions">
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || working || !selected.length}
              onClick={() => void submit("keep")}
            >
              Keep deleted ({selected.length})
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || working || !selected.length}
              onClick={() => void submit("restore")}
            >
              Restore ({selected.length})
            </Button>
          </div>
        </div>
      </details>
    </section>
  );
}
