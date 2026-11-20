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
  folders: { sourceId: string | null; path: string; state: TrustState }[];
};

const fixable: TrustState[] = [
  "folder-not-trusted",
  "hooks-not-approved",
  "hooks-changed",
];

function message(state: TrustState, name: string) {
  switch (state) {
    case "folder-not-trusted":
    case "hooks-not-approved":
      return `Codex isn’t loading Orka in ${name}, so Codex sessions there don’t get shared memory.`;
    case "hooks-changed":
      return `Orka changed since Codex last approved it in ${name}, so Codex sessions there don’t get shared memory.`;
    case "folder-untrusted":
      return `${name} is marked untrusted in Codex, so Codex sessions there don’t get shared memory. Change this in Codex if you want it.`;
    case "hooks-disabled":
      return "Hooks are turned off in Codex, so Codex sessions don’t get shared memory. Turn them back on in Codex if you want it.";
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
  const revision = (project.sources ?? [])
    .map(
      (source) =>
        `${source.id}:${source.path ?? ""}:${source.folderState ?? ""}`,
    )
    .join("|");
  const load = useCallback(
    () =>
      invoke<Status>("settings_command", {
        action: "codex-trust",
        context: { user, service },
        input: { projectId: project.id },
      }),
    [project.id, user, service],
  );
  const status = useSettingsQuery(
    load,
    null,
    `${project.path ?? ""}|${revision}`,
  );
  const name = (sourceId: string | null, path: string) =>
    project.sources?.find((source) => source.id === sourceId)?.name ??
    path.split("/").filter(Boolean).at(-1) ??
    path;
  const folders = (status.data?.folders ?? []).filter(
    (folder) => message(folder.state, "") !== null,
  );
  // Hooks turned off is one Codex-wide setting; say it once.
  const shown = folders.filter(
    (folder, index) =>
      folder.state !== "hooks-disabled" ||
      folders.findIndex((other) => other.state === "hooks-disabled") === index,
  );
  if (shown.length === 0) return null;
  const trust = async (sourceId: string, label: string) => {
    setPending(sourceId);
    setError("");
    try {
      const result = await invoke<{ state: TrustState }>("settings_command", {
        action: "trust-codex",
        context: { user, service },
        input: { projectId: project.id, sourceId },
      });
      if (result.state === "trusted")
        notice(`Codex will load Orka in ${label} from its next session`);
      else setError(`Codex still isn’t loading Orka in ${label}.`);
    } catch (failure) {
      setError(String(failure));
    } finally {
      setPending(null);
      await status.refresh();
    }
  };
  return (
    <div className="settings-codex-trust">
      {shown.map((folder) => {
        const label = name(folder.sourceId, folder.path);
        const sourceId = folder.sourceId ?? project.id;
        return (
          <div
            key={`${folder.path}:${folder.state}`}
            className="settings-notice settings-folder-notice"
          >
            <p>{message(folder.state, label)}</p>
            {fixable.includes(folder.state) && (
              <>
                <p className="settings-codex-trust-detail">
                  This trusts the folder and Orka’s hooks in your Codex
                  settings. Nothing else in Codex changes.
                </p>
                <Button
                  size="sm"
                  disabled={busy || pending !== null}
                  aria-label={`Trust ${label} in Codex`}
                  onClick={() => void trust(sourceId, label)}
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
