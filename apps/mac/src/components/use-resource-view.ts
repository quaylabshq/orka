import { useProductView } from "./desktop-usage.js";
import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import type { SessionConflict } from "@portable/protocol";
import type { WorkspaceResource as Resource } from "../types.js";
import type { Inspection } from "../types.js";

/**
 * The largest transcript the reader renders. WebKit lays out a single text
 * block on the main thread: about 0.8 s at 4 MB, 3 s at 17 MB and 8 s at 44 MB
 * of transcript text. Larger transcripts offer a download instead.
 */
export const TRANSCRIPT_RENDER_LIMIT = 4 * 1024 * 1024;

export interface ResourceView {
  /** The inspected file: SKILL.md for skills, session.jsonl for sessions, otherwise the first file. */
  file: string;
  setFile: Dispatch<SetStateAction<string>>;
  inspection: Inspection | null;
  inspectionError: string;
  retryInspection: () => void;
  /** The conflict version being read; empty for the shared version. */
  preview: string;
  setPreview: Dispatch<SetStateAction<string>>;
  fullTranscript: boolean;
  setFullTranscript: Dispatch<SetStateAction<boolean>>;
  /** Literal line diff against the previous revision. */
  changes: boolean;
  setChanges: Dispatch<SetStateAction<boolean>>;
  rawMarkdown: boolean;
  setRawMarkdown: Dispatch<SetStateAction<boolean>>;
  canRenderMarkdown: boolean;
}

/**
 * Reading state for the selected resource and the native inspection that
 * matches it. Sessions only inspect the raw transcript in transcript mode.
 */
export function useResourceView(
  resourceId: string,
  resource: Resource | undefined,
  conflicts: SessionConflict[],
  scope: string,
  deviceId?: string,
): ResourceView {
  const loaded = Boolean(resource);
  const defaultFile =
    resource?.kind === "skill"
      ? "SKILL.md"
      : resource?.kind === "session"
        ? "session.jsonl"
        : (resource?.files[0]?.path ?? "");
  const selectionKey = JSON.stringify([
    scope,
    deviceId,
    resourceId,
    loaded,
    defaultFile,
  ]);
  const [file, setFile] = useState(defaultFile);
  const [selection, setSelection] = useState(selectionKey);
  const [chosenPreview, setPreview] = useState("");
  const preview =
    chosenPreview ||
    (resource?.kind === "session" && resource.deleted
      ? (conflicts.find(
          (c) => c.resourceId === resource.resourceId && !c.candidate.deleted,
        )?.id ?? "")
      : "");
  const [fullTranscript, setFullTranscript] = useState(false);
  const [changes, setChanges] = useState(false);
  const [rawMarkdown, setRawMarkdown] = useState(false);
  const id = resource?.resourceId;
  const kind = resource?.kind;
  useEffect(() => {
    setRawMarkdown(false);
  }, [resourceId, file, preview]);
  // Reset on selection, and again when the resource arrives after its id did
  // (a deep link handled before the first snapshot).
  useEffect(() => {
    setFile(defaultFile);
    setSelection(selectionKey);
    setChanges(false);
    setFullTranscript(false);
    setPreview("");
  }, [selectionKey, defaultFile]);
  useEffect(() => {
    if (preview && !conflicts.some((c) => c.id === preview)) setPreview("");
  }, [conflicts, preview]);
  const conflict = conflicts.find((item) => item.id === preview);
  const enabled = Boolean(
    selection === selectionKey &&
    id &&
    file &&
    (!preview || conflict) &&
    (kind !== "session" || fullTranscript),
  );
  const inspection = useQuery({
    queryKey: [
      "resource-inspection",
      scope,
      deviceId,
      resource?.projectId,
      id,
      resource?.revision,
      file,
      resource?.files.find((item) => item.path === file)?.hash,
      preview,
      conflict?.revision,
      conflict?.candidate.files,
    ],
    enabled,
    // Live fork history can change without changing the catalog's file hash.
    // Re-entering Transcript should refresh the version offered for download.
    ...(kind === "session" && { staleTime: 0 }),
    queryFn: async ({ signal }) => {
      const result = await invoke<Inspection>("inspect_resource", {
        id,
        file,
        conflictId: preview || null,
        maxBytes: kind === "session" ? TRANSCRIPT_RENDER_LIMIT : null,
      });
      // Native IPC itself cannot be aborted. Consuming the signal lets Query
      // discard a response after selection or scope changes.
      if (signal.aborted) throw new Error("Resource inspection canceled");
      return result;
    },
  });
  const reading = useRef<{ id?: string; revision?: number }>({});
  const [updatedRevision, setUpdatedRevision] = useState<string>();
  useEffect(() => {
    const revision = resource?.revision;
    if (
      id &&
      revision &&
      reading.current.id === id &&
      reading.current.revision !== undefined &&
      reading.current.revision !== revision
    ) {
      setUpdatedRevision(JSON.stringify([scope, id, revision]));
    } else if (reading.current.id !== id) setUpdatedRevision(undefined);
    reading.current = { id, revision };
  }, [id, resource?.revision, scope]);
  useProductView(
    enabled &&
      inspection.data &&
      updatedRevision === JSON.stringify([scope, id, resource?.revision])
      ? "resource_revision_viewed"
      : undefined,
    updatedRevision,
  );
  useProductView(
    kind === "session" && loaded
      ? `session_reader_viewed:${fullTranscript ? "transcript" : "conversation"}`
      : undefined,
    resourceId,
  );
  useProductView(
    kind === "skill" && enabled && inspection.data
      ? "skill_file_viewed"
      : undefined,
    JSON.stringify([resourceId, file]),
  );
  useProductView(
    changes && enabled && inspection.data?.previous != null
      ? "resource_revisions_compared"
      : undefined,
    resourceId,
  );
  return {
    file,
    setFile,
    inspection: enabled ? (inspection.data ?? null) : null,
    inspectionError:
      enabled && inspection.error ? String(inspection.error) : "",
    retryInspection: () => {
      if (enabled) void inspection.refetch();
    },
    preview,
    setPreview,
    fullTranscript,
    setFullTranscript,
    changes,
    setChanges,
    rawMarkdown,
    setRawMarkdown,
    canRenderMarkdown:
      resource?.kind !== "session" && /\.(md|markdown|mdown)$/i.test(file),
  };
}
