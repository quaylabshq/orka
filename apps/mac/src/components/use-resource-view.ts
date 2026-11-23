import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import type { SessionConflict } from "@portable/protocol";
import type { WorkspaceResource as Resource } from "../types.js";
import type { Inspection } from "../types.js";

export interface ResourceView {
  /** The inspected file: SKILL.md for skills, otherwise the first file. */
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
    resource?.kind === "skill" ? "SKILL.md" : (resource?.files[0]?.path ?? "");
  const selectionKey = JSON.stringify([
    scope,
    deviceId,
    resourceId,
    loaded,
    defaultFile,
  ]);
  const [file, setFile] = useState(defaultFile);
  const [selection, setSelection] = useState(selectionKey);
  const [preview, setPreview] = useState("");
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
    queryFn: async ({ signal }) => {
      const result = await invoke<Inspection>("inspect_resource", {
        id,
        file,
        conflictId: preview || null,
      });
      // Native IPC itself cannot be aborted. Consuming the signal lets Query
      // discard a response after selection or scope changes.
      if (signal.aborted) throw new Error("Resource inspection canceled");
      return result;
    },
  });
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
