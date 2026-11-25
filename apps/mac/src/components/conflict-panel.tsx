import { useProductView } from "./desktop-usage.js";
import { TriangleAlertIcon } from "lucide-react";
import React from "react";
import type { SessionConflict } from "@portable/protocol";
import { Button } from "./button.js";
import type {
  SessionActionName,
  SessionVersion,
} from "./use-resource-actions.js";

/** One unresolved session conflict with its preview and resolution actions. */
export function ConflictPanel({
  conflict,
  deviceId,
  user,
  owner,
  busy,
  recovery,
  multipleCandidates,
  canPublish,
  preview,
  onPreview,
  onResolve,
}: {
  conflict: SessionConflict;
  deviceId: string;
  user: string | null;
  /** The session owner; only they can keep or override. */
  owner: string;
  busy: boolean;
  recovery?: boolean;
  multipleCandidates?: boolean;
  canPublish?: boolean;
  /** The conflict being read, or empty for the shared version. */
  preview: string;
  onPreview: (conflictId: string) => void;
  onResolve: (
    action: SessionActionName,
    conflictId: string,
    selected: SessionVersion,
  ) => void;
}) {
  useProductView("conflict_viewed", conflict.id);
  const local: SessionVersion =
    conflict.deviceId === deviceId ? "candidate" : "current";
  const remote: SessionVersion = local === "current" ? "candidate" : "current";
  const ownerOnly = busy || owner !== user || canPublish === false;
  const session = conflict.candidate.kind === "session";
  return (
    <div className="conflict rounded-xl border border-line bg-panel">
      <strong>
        <TriangleAlertIcon size={16} aria-hidden="true" />
        {recovery
          ? "This shared session was deleted."
          : session
            ? "Two session versions need a choice."
            : "Two versions need a choice."}
      </strong>
      <p>
        {recovery
          ? multipleCandidates
            ? "Keeping it deleted or restoring this version closes every incoming version for this session. Create a copy to preserve one separately."
            : "Review the incoming copy before deciding whether to restore the session."
          : session
            ? "Open sessions stay untouched. Override applies after the session closes."
            : "Review the shared and incoming versions before choosing which to keep."}
      </p>
      <div className="actions">
        {!recovery && (
          <Button
            aria-pressed={!preview}
            onClick={() => onPreview("")}
            variant="secondary"
            size="sm"
          >
            View shared version
          </Button>
        )}
        <Button
          aria-pressed={preview === conflict.id}
          onClick={() => onPreview(conflict.id)}
          variant="secondary"
          size="sm"
        >
          View incoming version
        </Button>
        <Button
          disabled={ownerOnly}
          onClick={() =>
            onResolve("keep", conflict.id, recovery ? "current" : local)
          }
          variant="secondary"
          size="sm"
        >
          {recovery ? "Keep deleted" : "Keep local"}
        </Button>
        <Button
          disabled={ownerOnly}
          onClick={() =>
            onResolve("override", conflict.id, recovery ? "candidate" : remote)
          }
          variant="secondary"
          size="sm"
        >
          {recovery ? "Restore session" : "Override"}
        </Button>
        <Button
          disabled={busy || conflict.author !== user}
          onClick={() =>
            onResolve("copy", conflict.id, recovery ? "candidate" : local)
          }
          variant="tertiary"
          size="sm"
        >
          Create copy
        </Button>
      </div>
    </div>
  );
}
