import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { DownloadIcon, FolderIcon, PauseIcon } from "lucide-react";
import type { Project } from "../types.js";
import { Button } from "./button.js";
import { Overlay } from "./overlay.js";
import { Icon } from "./icon.js";
import { ActivityIndicator } from "./activity-indicator.js";
import { projectLabel } from "./project-navigation.js";
import { inactiveMessage, removalWarning } from "./project-inactive.js";
import { useToastNotice } from "./toasts.js";
import type { Run } from "./use-resource-actions.js";

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
  const notice = useToastNotice();
  const [exporting, setExporting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const name = projectLabel(project);
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
      await invoke("export_project", {
        projectId: project.id,
        destination,
      });
      notice("Project exported");
    } catch (cause) {
      setError(String(cause));
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
            onClick={() => setConfirming(true)}
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
        <Overlay
          open
          title="Remove from this Mac?"
          className="settings-confirm project-lifecycle-confirm"
          onClose={() => {
            if (!busy) setConfirming(false);
          }}
        >
          <h2>Remove from this Mac?</h2>
          <div className="project-lifecycle-target">
            <Icon icon={FolderIcon} variant="tertiary" />
            <span>{name}</span>
          </div>
          <p>{removalWarning()}</p>
          <div className="settings-confirm-actions">
            <Button disabled={busy} onClick={() => setConfirming(false)}>
              Keep it
            </Button>
            <Button
              className="project-lifecycle-danger"
              disabled={busy}
              onClick={() => {
                void run(
                  () =>
                    invoke("project_command", {
                      action: "remove",
                      input: { projectId: project.id },
                    }),
                  { successTitle: "Project removed from this Mac" },
                ).then(() => setConfirming(false));
              }}
            >
              Remove
            </Button>
          </div>
        </Overlay>
      )}
    </section>
  );
}
