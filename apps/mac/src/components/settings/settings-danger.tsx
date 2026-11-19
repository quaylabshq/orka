import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Project } from "../../types.js";
import { ActivityIndicator } from "../activity-indicator.js";
import { Button } from "../button.js";
import { Overlay } from "../overlay.js";
import { TextField } from "../text-field.js";

const errorText = (error: unknown) => String(error).replace(/^Error:\s*/, "");

/** Format only an authoritative deadline returned by the service. */
export function restorableUntil(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? null
    : new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(date);
}

type ProjectCapabilities = {
  softDelete?: number;
  projectRestoreWindowDays?: number;
};

type Dialog = { kind: "delete" | "purge" | "leave"; project: Project };

export function SettingsDanger({
  project,
  deletedProjects = [],
  archivedProjects = [],
  serviceUrl,
  members,
  busy,
  run,
  onComplete,
}: {
  project?: Project;
  deletedProjects?: Project[];
  archivedProjects?: Project[];
  serviceUrl?: string;
  members: number | null;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<unknown>;
  onComplete?: (message?: string) => void;
}) {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [typed, setTyped] = useState("");
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const [policyRevision, setPolicyRevision] = useState(0);
  const [dialogError, setDialogError] = useState("");
  const [sectionError, setSectionError] = useState("");
  const [notice, setNotice] = useState("");
  const [working, setWorking] = useState(false);
  const disabled = busy || working;
  const [capabilities, setCapabilities] = useState<ProjectCapabilities | null>(
    null,
  );
  const [capabilityError, setCapabilityError] = useState("");
  const [capabilityAttempt, setCapabilityAttempt] = useState(0);
  const needsDeletionCapabilities =
    project?.role === "owner" || deletedProjects.length > 0;
  useEffect(() => {
    if (!needsDeletionCapabilities) return;
    let active = true;
    setCapabilities(null);
    setCapabilityError("");
    void invoke<ProjectCapabilities>("project_command", {
      action: "capabilities",
      input: {},
    }).then(
      (value) => {
        if (active) setCapabilities(value);
      },
      () => {
        if (active)
          setCapabilityError("Could not check project deletion support.");
      },
    );
    return () => {
      active = false;
    };
  }, [serviceUrl, capabilityAttempt, needsDeletionCapabilities]);
  const supportsDelete = capabilities?.softDelete === 1;
  const days = capabilities?.projectRestoreWindowDays;
  const restoreWindow =
    typeof days === "number" && Number.isSafeInteger(days) && days > 0
      ? `${days} ${days === 1 ? "day" : "days"}`
      : null;
  const restorePromise = restoreWindow
    ? `This service keeps deleted projects for ${restoreWindow}.`
    : "It can be restored during this service’s restore window.";

  const open = (kind: Dialog["kind"], target: Project) => {
    setDialog({ kind, project: target });
    setTyped("");
    setDialogError("");
    setMemberCount(kind === "delete" ? (members ?? null) : null);
    setPolicyRevision(target.policyRevision ?? 0);
    if (kind === "purge") return;
    void invoke<{ members?: unknown[]; policyRevision?: number }>(
      "governance_command",
      { action: "catalog", input: { projectId: target.id } },
    )
      .then((catalog) => {
        if (kind === "delete" && Array.isArray(catalog.members))
          setMemberCount(catalog.members.length);
        if (kind === "leave" && typeof catalog.policyRevision === "number")
          setPolicyRevision(catalog.policyRevision);
      })
      // Membership counts are optional; never fabricate a team size.
      .catch(() => {});
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
      onComplete?.();
    } catch (error) {
      setSectionError(errorText(error));
    } finally {
      setWorking(false);
    }
  };

  const submit = async () => {
    if (!dialog || disabled) return;
    const leaving = dialog.kind === "leave";
    if (!leaving && (typed.trim() !== dialog.project.name || !supportsDelete))
      return;
    const target = dialog;
    setDialogError("");
    setWorking(true);
    try {
      await run(() =>
        invoke("project_command", {
          action: leaving
            ? "leave"
            : target.kind === "delete"
              ? "delete"
              : "purge",
          input: leaving
            ? {
                projectId: target.project.id,
                expectedPolicyRevision: policyRevision,
              }
            : {
                projectId: target.project.id,
                requestId: crypto.randomUUID(),
                expectedRevision: target.project.lifecycleRevision ?? 0,
                confirmation: typed.trim(),
              },
        }),
      );
      setDialog(null);
      setTyped("");
      onComplete?.(
        leaving
          ? "You left the project. Your account no longer has access on any device."
          : undefined,
      );
    } catch (error) {
      const message = errorText(error);
      setDialogError(
        leaving && message.includes("Transfer ownership before leaving")
          ? `${message} Transfer ownership to another member from Members first.`
          : message,
      );
    } finally {
      setWorking(false);
    }
  };

  const matches = Boolean(
    dialog &&
    !disabled &&
    (dialog.kind === "leave" ||
      (typed.trim() === dialog.project.name && supportsDelete)),
  );
  const count = memberCount !== null && memberCount > 0 ? memberCount : null;
  const title =
    dialog?.kind === "leave"
      ? "Leave project?"
      : dialog?.kind === "purge"
        ? "Delete project permanently?"
        : "Delete project?";

  return (
    <>
      {project && (
        <section className="settings-danger" aria-label="Danger zone">
          <div className="settings-danger-heading">
            <h3>Danger zone</h3>
            <p>
              {project.role === "owner"
                ? "Changes here affect every member of this project."
                : "Changes here affect your account’s access to this project."}
            </p>
          </div>
          {project.role === "owner" ? (
            <>
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
                  <p>
                    Remove it for all members.{" "}
                    {capabilities === null
                      ? "Checking deletion support…"
                      : supportsDelete
                        ? restorePromise
                        : "Update this service to use recoverable project deletion."}
                  </p>
                </div>
                <Button
                  size="sm"
                  className="management-danger"
                  disabled={disabled || !supportsDelete}
                  onClick={() => open("delete", project)}
                >
                  Delete project
                </Button>
              </div>
            </>
          ) : (
            <div className="settings-row">
              <div>
                <h3>Leave project</h3>
                <p>
                  Leave this project on all your devices. The project and its
                  other members stay as they are.
                </p>
              </div>
              <Button
                size="sm"
                className="management-danger"
                disabled={disabled}
                onClick={() => open("leave", project)}
              >
                Leave project
              </Button>
            </div>
          )}
        </section>
      )}
      {archivedProjects.length > 0 && (
        <section className="settings-danger" aria-label="Archived projects">
          <div className="settings-danger-heading">
            <h3>Archived projects</h3>
            <p>Projects you own with sync paused for all members.</p>
          </div>
          <ul className="settings-group settings-deleted-list">
            {archivedProjects.map((item) => (
              <li className="settings-deleted-row" key={item.id}>
                <div className="settings-project-summary">
                  <strong title={item.name}>{item.name}</strong>
                  <p>Archived</p>
                </div>
                <div className="settings-inline-actions">
                  <Button
                    size="sm"
                    disabled={disabled}
                    onClick={() => void lifecycle(item, "restore")}
                  >
                    Restore
                  </Button>
                </div>
              </li>
            ))}
          </ul>
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
                <div className="settings-project-summary">
                  <strong title={item.name}>{item.name}</strong>
                  <p>
                    {restorableUntil(item.purgeAfter)
                      ? `Restorable until ${restorableUntil(item.purgeAfter)}`
                      : "Restore deadline unavailable."}
                  </p>
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
                    disabled={disabled || !supportsDelete}
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
      {capabilityError && (
        <p role="alert">
          {capabilityError}{" "}
          <Button
            size="sm"
            disabled={disabled}
            onClick={() => setCapabilityAttempt((attempt) => attempt + 1)}
          >
            Retry
          </Button>
        </p>
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
          {dialog.kind === "leave" ? (
            <p>
              Leave “{dialog.project.name}”? Your account will lose access to
              its shared content on all your devices. The project and its other
              members stay as they are.
            </p>
          ) : dialog.kind === "delete" ? (
            <p>
              {count === null
                ? "All members of this project will lose access."
                : `The ${count} ${count === 1 ? "member" : "members"} of this project will lose access.`}{" "}
              {restorePromise}
            </p>
          ) : (
            <p>
              Delete “{dialog.project.name}” permanently? This can’t be undone.
            </p>
          )}
          {dialog.kind !== "leave" && (
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
          )}
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
              {dialog.kind === "leave"
                ? "Leave project"
                : dialog.kind === "delete"
                  ? "Delete project"
                  : "Delete now"}
            </Button>
          </div>
        </Overlay>
      )}
    </>
  );
}
