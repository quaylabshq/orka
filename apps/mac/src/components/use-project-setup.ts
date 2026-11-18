import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Project, ProjectSharing } from "../types.js";
import type { ProjectSetupMode } from "./project-setup.js";
import { defaultSharing } from "./project-sharing.js";
import { hasConnectedSource } from "./project-sources.js";
import {
  joinErrorMessage,
  parseProjectInvite,
  sameServiceUrl,
} from "./project-invite.js";
import { useInvitePreview } from "./use-invite-preview.js";
import { useToastNotice } from "./toasts.js";
import { useSourceFolders } from "./source-folders.js";

export async function connectProject(
  id: string,
  sourceId?: string,
  defaultPath?: string,
) {
  const path = await open({
    directory: true,
    multiple: !sourceId,
    title: "Connect source folders on this Mac",
    defaultPath,
  });
  const paths = typeof path === "string" ? [path] : (path ?? []);
  if (paths.length)
    await invoke("connect_project_sources", { id, paths, sourceId });
  return paths.length > 0;
}

export function useProjectSetup(
  onProject: (id: string) => void,
  onError: (message: string) => void,
  apiUrl?: string,
  onRepositorySetup?: (id: string) => void,
  existingProjects: readonly Project[] = [],
) {
  const setNotice = useToastNotice();
  const [repositoryEnabled, setRepositoryEnabled] = useState(false);
  const [sourceChoice, setSourceChoice] = useState<"github" | "folder" | null>(
    null,
  );
  const sourceMode = sourceChoice ?? (repositoryEnabled ? "github" : "folder");
  useEffect(() => {
    let canceled = false;
    void invoke<{ repositories?: { github?: number } }>("auth_capabilities")
      .then((value) => {
        if (!canceled) setRepositoryEnabled(value.repositories?.github === 1);
      })
      .catch(() => {});
    return () => {
      canceled = true;
    };
  }, [apiUrl]);
  const [dialog, setDialog] = useState<ProjectSetupMode | null>(null);
  const [input, setInput] = useState("");
  const selection = useSourceFolders();
  const [sharing, setSharing] = useState<ProjectSharing>(defaultSharing);
  let inviteService: string | undefined;
  let inviteToken = "";
  if (dialog === "join") {
    try {
      const invite = parseProjectInvite(input);
      inviteService = invite.serviceUrl;
      inviteToken = invite.token;
    } catch {
      // Partial input is validated when the form is submitted.
    }
  }
  const invitePreview = useInvitePreview(inviteToken, inviteService ?? "");
  const serviceMismatch = Boolean(
    inviteService && apiUrl && !sameServiceUrl(inviteService, apiUrl),
  );

  const show = (mode: ProjectSetupMode, value = "") => {
    onError("");
    setInput(value);
    selection.clear();
    setSourceChoice(null);
    setSharing(defaultSharing);
    setDialog(mode);
  };
  const submit = async () => {
    if (!dialog) return;
    const creating = dialog === "create";
    let invite: ReturnType<typeof parseProjectInvite> | null = null;
    if (!creating) {
      try {
        invite = parseProjectInvite(input);
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error));
        return;
      }
      if (
        invite.serviceUrl &&
        (!apiUrl || !sameServiceUrl(invite.serviceUrl, apiUrl))
      ) {
        onError(`Sign in to ${invite.serviceUrl} before joining this project.`);
        return;
      }
    }
    let result: { id: string; repositorySetup?: boolean };
    try {
      result = await invoke("cloud_action", {
        action: dialog,
        input: creating
          ? { name: input.trim(), sharing }
          : { ...invite, sharing },
      });
    } catch (error) {
      if (creating) throw error;
      // The dialog shows the reason on its own line, without the native
      // bridge's status prefix.
      onError(joinErrorMessage(error));
      return;
    }
    // The service keeps the invite when the account already belongs to the
    // project, so a known project id means this join changed nothing. Open it
    // instead of asking for folders this Mac already has.
    const known = creating
      ? undefined
      : existingProjects.find((item) => item.id === result.id);
    onProject(result.id);
    setDialog(null);
    setInput("");
    if (known) {
      setNotice("You’re already in this project");
      if (hasConnectedSource(known)) return;
    }
    if (creating) {
      if (sourceMode === "folder" && selection.folders.length)
        await invoke("connect_project_sources", {
          id: result.id,
          paths: selection.folders,
        });
      selection.clear();
      if (
        sourceMode === "github" &&
        result.repositorySetup &&
        onRepositorySetup
      )
        onRepositorySetup(result.id);
    } else if (result.repositorySetup && onRepositorySetup)
      onRepositorySetup(result.id);
    else await connectProject(result.id);
  };

  return {
    dialog,
    repositoryEnabled,
    sourceMode,
    setSourceMode: (value: "github" | "folder") => {
      setSourceChoice(value);
      selection.clear();
    },
    input,
    setInput,
    selection,
    sharing,
    inviteService,
    invite: invitePreview,
    serviceMismatch,
    setSharing,
    show,
    submit,
    close: () => setDialog(null),
  };
}
