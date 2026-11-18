import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Project } from "../../types.js";
import { ActivityIndicator } from "../activity-indicator.js";
import { Button } from "../button.js";
import { Overlay } from "../overlay.js";
import { TextField } from "../text-field.js";

const errorText = (error: unknown) => String(error).replace(/^Error:\s*/, "");

/** The service keeps a deleted project for 30 days unless its receipt says otherwise. */
export function restorableUntil(value?: string | null) {
  const fallback = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const date = value ? new Date(value) : new Date(fallback);
  return new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(
    Number.isNaN(date.getTime()) ? new Date(fallback) : date,
  );
}

type Dialog = { kind: "delete" | "purge"; project: Project };

export function SettingsDanger({
  project,
  deletedProjects,
  members,
  busy,
  run,
}: {
  project?: Project;
  deletedProjects: Project[];
  members: number | null;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<unknown>;
}) {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [typed, setTyped] = useState("");
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const [dialogError, setDialogError] = useState("");
  const [sectionError, setSectionError] = useState("");
  const [notice, setNotice] = useState("");
  const [working, setWorking] = useState(false);
  const disabled = busy || working;

  const open = (kind: Dialog["kind"], target: Project) => {
    setDialog({ kind, project: target });
    setTyped("");
    setDialogError("");
    setMemberCount(kind === "delete" ? (members ?? null) : null);
    if (kind !== "delete") return;
    void invoke<{ members?: unknown[] }>("governance_command", {
      action: "catalog",
      input: { projectId: target.id },
    })
      .then((catalog) => {
        if (Array.isArray(catalog.members))
          setMemberCount(catalog.members.length);
      })
      .catch(() => setMemberCount((count) => count ?? 1));
  };

  const lifecycle = async (target: Project, action: "archive" | "restore") => {
    setSectionError("");
    setNotice("");
    setWorking(true);
    try {
      await run(() =>
        invoke("project_command", {
          action,
          input: {
            projectId: target.id,
            requestId: crypto.randomUUID(),
            expectedRevision: target.lifecycleRevision ?? 0,
          },
        }),
      );
      setNotice(`Project ${action === "archive" ? "archived" : "restored"}.`);
    } catch (error) {
      setSectionError(errorText(error));
    } finally {
      setWorking(false);
    }
  };

  const submit = async () => {
    if (!dialog || typed.trim() !== dialog.project.name || disabled) return;
    const target = dialog;
    setDialogError("");
    setWorking(true);
    try {
      await run(() =>
        invoke("project_command", {
          action: target.kind === "delete" ? "delete" : "purge",
          input: {
            projectId: target.project.id,
            requestId: crypto.randomUUID(),
            expectedRevision: target.project.lifecycleRevision ?? 0,
            confirmation: typed.trim(),
          },
        }),
      );
      setDialog(null);
      setTyped("");
    } catch (error) {
      setDialogError(errorText(error));
    } finally {
      setWorking(false);
    }
  };

  const matches = Boolean(
    dialog && typed.trim() === dialog.project.name && !disabled,
  );
  const count = Math.max(1, memberCount ?? 1);
  const title =
    dialog?.kind === "purge"
      ? "Delete project permanently?"
      : "Delete project?";

  return (
    <>
      {project && (
        <section className="settings-danger" aria-label="Danger zone">
          <div className="settings-danger-heading">
            <h3>Danger zone</h3>
            <p>Changes here affect every member of this project.</p>
          </div>
          <div className="settings-row">
            <div>
              <h3>
                {project.archivedAt ? "Restore project" : "Archive project"}
              </h3>
              <p>
                {project.archivedAt
                  ? "Return this project to the workspace and resume its sync."
                  : "Hide this project from the workspace and pause its sync."}
              </p>
            </div>
            <Button
              size="sm"
              disabled={disabled}
              onClick={() =>
                void lifecycle(
                  project,
                  project.archivedAt ? "restore" : "archive",
                )
              }
            >
              {project.archivedAt ? "Restore project" : "Archive project"}
            </Button>
          </div>
          <div className="settings-row">
            <div>
              <h3>Delete project</h3>
              <p>Remove it for all members. It can be restored for 30 days.</p>
            </div>
            <Button
              size="sm"
              className="management-danger"
              disabled={disabled}
              onClick={() => open("delete", project)}
            >
              Delete project
            </Button>
          </div>
        </section>
      )}
      {deletedProjects.length > 0 && (
        <section className="settings-danger" aria-label="Recently deleted">
          <div className="settings-danger-heading">
            <h3>Recently deleted</h3>
            <p>Projects you own that can still be restored.</p>
          </div>
          <ul className="settings-group settings-deleted-list">
            {deletedProjects.map((item) => (
              <li className="settings-deleted-row" key={item.id}>
                <div>
                  <strong>{item.name}</strong>
                  <p>Restorable until {restorableUntil(item.purgeAfter)}</p>
                </div>
                <div className="settings-inline-actions">
                  <Button
                    size="sm"
                    disabled={disabled}
                    onClick={() => void lifecycle(item, "restore")}
                  >
                    Restore
                  </Button>
                  <Button
                    size="sm"
                    className="management-danger"
                    disabled={disabled}
                    onClick={() => open("purge", item)}
                  >
                    Delete now
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {sectionError && <p role="alert">{sectionError}</p>}
      {notice && <p role="status">{notice}</p>}
      {dialog && (
        <Overlay
          open
          title={title}
          className="settings-confirm"
          onClose={() => {
            if (!working) setDialog(null);
          }}
        >
          <h2>{title}</h2>
          {dialog.kind === "delete" ? (
            <p>
              {memberCount === null
                ? "Counting who will lose access."
                : `The ${count} ${count === 1 ? "member" : "members"} of this project will lose access.`}{" "}
              It can be restored until{" "}
              {restorableUntil(dialog.project.purgeAfter)}.
            </p>
          ) : (
            <p>
              Delete “{dialog.project.name}” permanently? This can’t be undone.
            </p>
          )}
          <TextField
            label="Project name"
            autoFocus
            value={typed}
            disabled={working}
            hint={`Type ${dialog.project.name} to confirm.`}
            onChange={(event) => {
              setTyped(event.target.value);
              setDialogError("");
            }}
          />
          {dialogError && <p role="alert">{dialogError}</p>}
          <div className="settings-confirm-actions">
            <Button disabled={working} onClick={() => setDialog(null)}>
              Stay
            </Button>
            <Button
              variant="secondary"
              className="management-danger"
              disabled={!matches}
              onClick={() => void submit()}
            >
              {working && <ActivityIndicator />}
              {dialog.kind === "delete" ? "Delete project" : "Delete now"}
            </Button>
          </div>
        </Overlay>
      )}
    </>
  );
}
