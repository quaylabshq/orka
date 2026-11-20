import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Project } from "../../types.js";
import { Button } from "../button.js";
import { useToastNotice } from "../toasts.js";
import { useSettingsQuery } from "./use-settings-query.js";

type TrustState =
  | "trusted"
  | "folder-not-trusted"
  | "folder-untrusted"
  | "hooks-not-approved"
  | "hooks-changed"
  | "hooks-disabled"
  | "unknown";

type Status = {
  state: "ready" | "unsupported" | "unavailable";
  folders: {
    sourceId: string | null;
    path: string;
    state: TrustState;
    folderToken: string | null;
  }[];
};

const fixable: TrustState[] = [
  "folder-not-trusted",
  "hooks-not-approved",
  "hooks-changed",
];

function message(state: TrustState, name: string) {
  switch (state) {
    case "folder-not-trusted":
      return `Codex isn’t loading Orka in ${name}, so Codex sessions there don’t get shared memory.`;
    case "hooks-not-approved":
      return `Codex hasn’t approved all of Orka’s hooks in ${name}. Shared memory may be incomplete there.`;
    case "hooks-changed":
      return `Orka changed since Codex last approved it in ${name}. Shared memory may be incomplete there.`;
    case "folder-untrusted":
      return `${name} is marked untrusted in Codex. Review trust for this folder or its parent.`;
    case "hooks-disabled":
      return "Hooks are turned off in Codex for one or more source folders. Turn them back on in Codex to get shared memory there.";
    default:
      return null;
  }
}

/** Shows folders where Codex skips Orka's hooks and, on request, fixes them. */
export function CodexTrustNotices({
  project,
  user,
  service,
  busy,
}: {
  project: Project;
  user: string | null | undefined;
  service: string | null | undefined;
  busy: boolean;
}) {
  const notice = useToastNotice();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const revision = JSON.stringify([
    project.path,
    (project.sources ?? []).map(({ id, path, folderState }) => [
      id,
      path,
      folderState,
    ]),
  ]);
  const load = useCallback(
    () =>
      invoke<Status>("settings_command", {
        action: "codex-trust",
        context: { user, service },
        input: { projectId: project.id },
      }),
    [project.id, user, service],
  );
  const status = useSettingsQuery(load, null, revision);
  const name = (sourceId: string | null, path: string) =>
    project.sources?.find((source) => source.id === sourceId)?.name ??
    path.split("/").filter(Boolean).at(-1) ??
    path;
  const folders = (status.data?.folders ?? []).filter(
    (folder) => message(folder.state, "") !== null,
  );
  // Group folders with disabled hooks into one notice.
  const shown = folders.filter(
    (folder, index) =>
      folder.state !== "hooks-disabled" ||
      folders.findIndex((other) => other.state === "hooks-disabled") === index,
  );
  if (shown.length === 0 && !error) return null;
  const trust = async (
    sourceId: string,
    label: string,
    folderToken: string,
  ) => {
    setPending(sourceId);
    setError("");
    try {
      const result = await invoke<{ state: TrustState }>("settings_command", {
        action: "trust-codex",
        context: { user, service },
        input: { projectId: project.id, sourceId, folderToken },
      });
      if (result.state === "trusted")
        notice(`Codex will load Orka in ${label} from its next session`);
      else setError(`Codex still isn’t loading Orka in ${label}.`);
    } catch (failure) {
      setError(String(failure));
    } finally {
      await status.refresh();
      setPending(null);
    }
  };
  return (
    <div className="settings-codex-trust">
      {shown.map((folder) => {
        const label = name(folder.sourceId, folder.path);
        const sourceId = folder.sourceId ?? project.id;
        const folderToken = folder.folderToken;
        return (
          <div
            key={`${folder.path}:${folder.state}`}
            className="settings-notice settings-folder-notice"
            title={folder.path}
          >
            <p>{message(folder.state, label)}</p>
            {fixable.includes(folder.state) && folderToken && (
              <>
                <p className="settings-codex-trust-detail">
                  {folder.state === "folder-not-trusted"
                    ? "Codex will load this folder’s project configuration and approve Orka’s hooks."
                    : "This approves Orka’s hooks in your Codex settings."}
                </p>
                <Button
                  size="sm"
                  disabled={
                    busy || status.loading || !!status.error || pending !== null
                  }
                  aria-label={`Trust ${label} in Codex`}
                  onClick={() => void trust(sourceId, label, folderToken)}
                >
                  {pending === sourceId ? "Trusting…" : "Trust in Codex"}
                </Button>
              </>
            )}
          </div>
        );
      })}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
