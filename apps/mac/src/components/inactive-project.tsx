import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import type { Project } from "../types.js";
import { Button } from "./button.js";
import { Overlay } from "./overlay.js";
import { projectLabel } from "./project-navigation.js";
import {
  inactiveBadge,
  inactiveMessage,
  removalWarning,
} from "./project-inactive.js";
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
  const badge = inactiveBadge(project);
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
      <div className="banner inactive-project-banner">
        <div className="inactive-project-copy">
          {badge && <strong>{badge}</strong>}
          <p>{inactiveMessage(project)}</p>
        </div>
        <div className="inactive-project-actions">
          <Button
            size="sm"
            disabled={busy || exporting}
            onClick={() => void exportProject()}
          >
            {exporting ? "Exporting…" : "Export"}
          </Button>
          <Button
            size="sm"
            variant="tertiary"
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            Remove from this Mac
          </Button>
        </div>
      </div>
      {error && (
        <p className="content-message" role="alert">
          {error}
        </p>
      )}
      <p className="content-message">
        Nothing here syncs until this project is active again.
      </p>
      <Overlay
        open={confirming}
        title="Remove from this Mac?"
        className="settings-confirm"
        onClose={() => {
          if (!busy) setConfirming(false);
        }}
      >
        <h2>Remove this project?</h2>
        <p>{removalWarning(project)}</p>
        <div className="settings-confirm-actions">
          <Button disabled={busy} onClick={() => setConfirming(false)}>
            Keep it
          </Button>
          <Button
            variant="primary"
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
    </section>
  );
}
