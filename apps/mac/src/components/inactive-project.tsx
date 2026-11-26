import { useState } from "react";
import { invoke } from "./product-command.js";
import { save } from "@tauri-apps/plugin-dialog";
import { DownloadIcon, FolderIcon, PauseIcon } from "lucide-react";
import type { Project } from "../types.js";
import { Button } from "./button.js";
import { Modal } from "./modal.js";
import { Icon } from "./icon.js";
import { ActivityIndicator } from "./activity-indicator.js";
import { projectLabel } from "./project-navigation.js";
import { inactiveMessage, removalWarning } from "./project-inactive.js";
import { useToasts } from "./toasts.js";
import type { Run } from "./use-resource-actions.js";

const errorText = (error: unknown) => String(error).replace(/^Error:\s*/, "");

/** The view for a project that stays visible but no longer syncs. */
export function InactiveProject({
  project,
  busy,
  run,
}: {
  project: Project;
  busy: boolean;
  run: Run;
}) {
  const { notify } = useToasts();
  const [exporting, setExporting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removalError, setRemovalError] = useState("");
  const [error, setError] = useState("");
  const name = projectLabel(project);
  const removeProject = async () => {
    if (busy || removing) return;
    setRemoving(true);
    setRemovalError("");
    try {
      await run(
        () =>
          invoke("project_command", {
            action: "remove",
            input: { projectId: project.id },
          }),
        { successTitle: "Project removed from this Mac" },
      );
      setConfirming(false);
    } catch (cause) {
      setRemovalError(errorText(cause));
    } finally {
      setRemoving(false);
    }
  };
  const exportProject = async () => {
    setError("");
    setExporting(true);
    try {
      const destination = await save({
        title: "Export project",
        defaultPath: `${name.replace(/[^\w.-]+/g, "-") || "project"}.zip`,
        filters: [{ name: "Zip archive", extensions: ["zip"] }],
      });
      if (!destination) return;
      const cachedOnly = await invoke<boolean>("export_project", {
        projectId: project.id,
        destination,
      });
      notify(
        cachedOnly
          ? {
              kind: "warning",
              title: "Saved content exported. Recent edits may be missing.",
            }
          : { kind: "success", title: "Project exported" },
      );
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setExporting(false);
    }
  };
  return (
    <section className="inactive-project" aria-label={name}>
      <div className="inactive-project-banner">
        <div className="inactive-project-icon">
          <Icon icon={PauseIcon} size="lg" />
        </div>
        <div className="inactive-project-copy">
          <h2>Sync paused</h2>
          <p>{inactiveMessage(project)}</p>
        </div>
        <p className="inactive-project-hint">
          Export the content saved on this Mac before removing the project.
        </p>
        <div className="inactive-project-actions">
          <Button
            variant="primary"
            aria-busy={exporting}
            disabled={busy || exporting}
            onClick={() => void exportProject()}
          >
            {exporting ? <ActivityIndicator /> : <Icon icon={DownloadIcon} />}
            {exporting ? "Exporting…" : "Export"}
          </Button>
          <Button
            disabled={busy || exporting}
            onClick={() => {
              setRemovalError("");
              setConfirming(true);
            }}
          >
            Remove from this Mac
          </Button>
        </div>
        {error && (
          <p className="project-lifecycle-feedback" role="alert">
            {error}
          </p>
        )}
      </div>
      {confirming && (
        <Modal
          title="Remove from this Mac?"
          className="settings-confirm project-lifecycle-confirm"
          onClose={() => {
            if (!busy && !removing) setConfirming(false);
          }}
          size="compact"
          closeDisabled={busy || removing}
          footer={
            <>
              <Button
                size="sm"
                disabled={busy || removing}
                onClick={() => setConfirming(false)}
              >
                Keep it
              </Button>
              <Button
                size="sm"
                className="project-lifecycle-danger"
                aria-busy={removing}
                disabled={busy || removing}
                onClick={() => void removeProject()}
              >
                {removing && <ActivityIndicator />}
                Remove
              </Button>
            </>
          }
        >
          <div className="project-lifecycle-target">
            <Icon icon={FolderIcon} variant="tertiary" />
            <span>{name}</span>
          </div>
          <p>{removalWarning(project)}</p>
          {removalError && (
            <p className="project-lifecycle-feedback" role="alert">
              {removalError}
            </p>
          )}
        </Modal>
      )}
    </section>
  );
}
