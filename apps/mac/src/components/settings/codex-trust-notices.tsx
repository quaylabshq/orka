import { useCallback, useEffect, useState } from "react";
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

function actionFor(state: TrustState) {
  if (state === "folder-not-trusted") return "open-codex-source";
  if (state === "hooks-not-approved" || state === "hooks-changed")
    return "approve-codex-hooks";
  return null;
}

type Action = NonNullable<ReturnType<typeof actionFor>>;

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

/** Helps users trust the folder in Codex and approve Orka hooks in Settings. */
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
  const { loading, refresh } = status;
  const recheckOnReturn =
    status.data?.state === "unavailable" ||
    status.data?.folders?.some(
      ({ state }) =>
        state === "folder-not-trusted" || state === "folder-untrusted",
    );
  useEffect(() => {
    if (!recheckOnReturn || loading) return;
    let checking = false;
    const onReturn = () => {
      if (checking || document.hidden) return;
      checking = true;
      void refresh().finally(() => {
        checking = false;
      });
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [loading, recheckOnReturn, refresh]);
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
  const run = async (
    action: Action,
    sourceId: string,
    label: string,
    folderToken: string,
  ) => {
    setPending(sourceId);
    setError("");
    try {
      const result = await invoke<{ state: TrustState } | null>(
        "settings_command",
        {
          action,
          context: { user, service },
          input: { projectId: project.id, sourceId, folderToken },
        },
      );
      if (action === "approve-codex-hooks") {
        if (result?.state === "trusted")
          notice(`Codex will load Orka in ${label} from its next session`);
        else if (result?.state !== "folder-not-trusted")
          setError(`Codex still isn’t loading Orka in ${label}.`);
      }
    } catch (failure) {
      setError(String(failure));
    } finally {
      if (action === "approve-codex-hooks") await refresh();
      setPending(null);
    }
  };
  return (
    <div className="settings-codex-trust">
      {shown.map((folder) => {
        const label = name(folder.sourceId, folder.path);
        const sourceId = folder.sourceId ?? project.id;
        const folderToken = folder.folderToken;
        const action = actionFor(folder.state);
        const opensCodex = action === "open-codex-source";
        return (
          <div
            key={folder.path}
            className="settings-notice settings-folder-notice"
            title={folder.path}
          >
            <p>{message(folder.state, label)}</p>
            {action && folderToken && (
              <>
                {opensCodex && (
                  <p className="settings-codex-trust-detail">
                    Trust this folder in Codex, then return to Orka.
                  </p>
                )}
                <Button
                  size="sm"
                  disabled={
                    busy || loading || !!status.error || pending !== null
                  }
                  aria-label={
                    opensCodex
                      ? `Open in Codex for ${label}`
                      : `Approve Orka hooks in ${label}`
                  }
                  onClick={() => void run(action, sourceId, label, folderToken)}
                >
                  {opensCodex
                    ? pending === sourceId
                      ? "Opening…"
                      : "Open in Codex"
                    : pending === sourceId
                      ? "Approving…"
                      : "Approve Orka hooks"}
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
