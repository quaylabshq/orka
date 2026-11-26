import { useEffect, useRef, useState } from "react";
import { invoke } from "../product-command.js";
import {
  ArchiveIcon,
  FolderIcon,
  LogOutIcon,
  PauseIcon,
  PlusIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react";
import type { Project, Snapshot } from "../../types.js";
import { ActivityIndicator } from "../activity-indicator.js";
import { Button } from "../button.js";
import { Modal } from "../modal.js";
import { TextField } from "../text-field.js";
import { Icon } from "../icon.js";
import { inactiveReason } from "../project-inactive.js";
import { projectLabel } from "../project-navigation.js";

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

type ProjectCatalog = Pick<
  Snapshot,
  | "projects"
  | "managedProjects"
  | "archivedProjects"
  | "deletedProjects"
  | "inactive"
>;

const projectGroups = [
  { id: "active", label: "Active projects", icon: FolderIcon },
  { id: "disabled", label: "Disabled on this Mac", icon: PauseIcon },
  { id: "archived", label: "Archived projects", icon: ArchiveIcon },
  { id: "deleted", label: "Recently deleted", icon: Trash2Icon },
  { id: "unavailable", label: "Unavailable projects", icon: FolderIcon },
] as const;

function groupProjects(catalog?: ProjectCatalog) {
  const groups: Record<(typeof projectGroups)[number]["id"], Project[]> = {
    active: [],
    disabled: [],
    archived: [],
    deleted: [],
    unavailable: [],
  };
  // The owner recovery lists also include projects removed from this Mac.
  const projects = new Map(
    [
      ...(catalog?.managedProjects ?? []),
      ...(catalog?.archivedProjects ?? []),
      ...(catalog?.deletedProjects ?? []),
      ...(catalog?.inactive ?? []),
      ...(catalog?.projects ?? []),
    ].map((project) => [project.id, project] as const),
  );
  for (const project of projects.values()) {
    const reason = inactiveReason(project);
    if (reason === "removed" || reason === "purged") {
      if (!project.hidden) groups.unavailable.push(project);
    } else {
      groups[reason ?? (project.hidden ? "disabled" : "active")].push(project);
    }
  }
  return groups;
}

export function changeProjectArchive(
  target: Project,
  action: "archive" | "restore",
) {
  return invoke("project_command", {
    action,
    input: {
      projectId: target.id,
      requestId: crypto.randomUUID(),
      expectedRevision: target.lifecycleRevision ?? 0,
    },
  });
}

export function SettingsDanger({
  project,
  catalog,
  serviceUrl,
  members,
  busy,
  run,
  onComplete,
  standaloneDelete,
}: {
  project?: Project;
  catalog?: {
    state: ProjectCatalog;
    onManage: (id: string) => void;
    onViewInactive: (id: string) => void;
  };
  serviceUrl?: string;
  members: number | null;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<unknown>;
  onComplete?: (message?: string) => void;
  standaloneDelete?: {
    onClose: () => void;
    onCloseAutoFocus: (event: Event) => void;
  };
}) {
  const [dialog, setDialog] = useState<Dialog | null>(() =>
    standaloneDelete && project?.role === "owner"
      ? { kind: "delete", project }
      : null,
  );
  const [typed, setTyped] = useState("");
  const [memberCount, setMemberCount] = useState<number | null>(members);
  const [policyRevision, setPolicyRevision] = useState(0);
  const [dialogError, setDialogError] = useState("");
  const [lifecycleError, setLifecycleError] = useState<{
    projectId: string;
    message: string;
  } | null>(null);
  const lifecycleErrorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    lifecycleErrorRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [lifecycleError]);
  const [notice, setNotice] = useState("");
  const [operation, setOperation] = useState<
    "confirm" | { projectId: string } | null
  >(null);
  const working = operation !== null;
  const lifecycleProjectId =
    typeof operation === "object" ? operation?.projectId : null;
  const disabled = busy || working;
  const [capabilities, setCapabilities] = useState<ProjectCapabilities | null>(
    null,
  );
  const [capabilityError, setCapabilityError] = useState("");
  const [capabilityAttempt, setCapabilityAttempt] = useState(0);
  const groups = groupProjects(catalog?.state);
  const localCopies = new Set(catalog?.state.inactive?.map((item) => item.id));
  const needsDeletionCapabilities =
    project?.role === "owner" ||
    groups.deleted.some((item) => item.role === "owner");
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

  const deletionDescription =
    capabilities === null
      ? capabilityError
        ? "Check deletion support to continue."
        : "Checking deletion support…"
      : supportsDelete
        ? restorePromise
        : "Update this service to use recoverable project deletion.";
  const capabilityFeedback = capabilityError && (
    <p className="project-lifecycle-feedback" role="alert">
      {capabilityError}{" "}
      <Button
        size="sm"
        disabled={disabled}
        onClick={() => setCapabilityAttempt((attempt) => attempt + 1)}
      >
        Retry
      </Button>
    </p>
  );

  useEffect(() => {
    if (!dialog || dialog.kind === "purge") return;
    const { kind, project: target } = dialog;
    let active = true;
    void invoke<{ members?: unknown[]; policyRevision?: number }>(
      "governance_command",
      { action: "catalog", input: { projectId: target.id } },
    )
      .then((catalog) => {
        if (!active) return;
        if (kind === "delete" && Array.isArray(catalog.members))
          setMemberCount(catalog.members.length);
        if (kind === "leave" && typeof catalog.policyRevision === "number")
          setPolicyRevision(catalog.policyRevision);
      })
      // Membership counts are optional; never fabricate a team size.
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [dialog]);

  const open = (kind: Dialog["kind"], target: Project) => {
    setDialog({ kind, project: target });
    setTyped("");
    setDialogError("");
    setMemberCount(kind === "delete" ? members : null);
    setPolicyRevision(target.policyRevision ?? 0);
  };

  const close = () => {
    setDialog(null);
    standaloneDelete?.onClose();
  };

  const lifecycle = async (
    target: Project,
    action: "archive" | "restore" | "show",
  ) => {
    setLifecycleError(null);
    setNotice("");
    setOperation({ projectId: target.id });
    try {
      await run(() =>
        action === "show"
          ? invoke("project_command", {
              action,
              input: { projectId: target.id },
            })
          : changeProjectArchive(target, action),
      );
      setNotice(
        {
          archive: "Project archived.",
          restore: "Project restored.",
          show: "Project added to this Mac.",
        }[action],
      );
      onComplete?.();
    } catch (error) {
      setLifecycleError({ projectId: target.id, message: errorText(error) });
    } finally {
      setOperation(null);
    }
  };

  const submit = async () => {
    if (!dialog || disabled) return;
    const leaving = dialog.kind === "leave";
    if (!leaving && (typed.trim() !== dialog.project.name || !supportsDelete))
      return;
    const target = dialog;
    setDialogError("");
    setOperation("confirm");
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
      close();
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
      setOperation(null);
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
  const lifecycleFeedback = (projectId: string) =>
    lifecycleError?.projectId === projectId && (
      <p
        ref={lifecycleErrorRef}
        className="project-lifecycle-feedback settings-lifecycle-feedback"
        role="alert"
      >
        {lifecycleError.message}
      </p>
    );

  return (
    <>
      {!standaloneDelete && capabilityFeedback}
      {!standaloneDelete && project && (
        <section className="settings-danger" aria-label="Danger zone">
          <div className="settings-danger-heading">
            <h3>Danger zone</h3>
            <p>
              {project.role === "owner"
                ? "Changes here affect every member of this project."
                : "Changes here affect your account’s access to this project."}
            </p>
          </div>
          <div className="settings-group settings-lifecycle-actions">
            {project.role === "owner" ? (
              <>
                <div className="settings-row">
                  <div>
                    <h3>
                      {project.archivedAt
                        ? "Restore project"
                        : "Archive project"}
                    </h3>
                    <p>
                      {project.archivedAt
                        ? "Return this project to the workspace and resume its sync."
                        : "Hide this project from the workspace and pause its sync."}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    aria-busy={lifecycleProjectId === project.id}
                    disabled={disabled}
                    onClick={() =>
                      void lifecycle(
                        project,
                        project.archivedAt ? "restore" : "archive",
                      )
                    }
                  >
                    {lifecycleProjectId === project.id ? (
                      <ActivityIndicator />
                    ) : (
                      <Icon
                        icon={project.archivedAt ? RotateCcwIcon : ArchiveIcon}
                      />
                    )}
                    {project.archivedAt ? "Restore project" : "Archive project"}
                  </Button>
                  {lifecycleFeedback(project.id)}
                </div>
                <div className="settings-row">
                  <div>
                    <h3>Delete project</h3>
                    <p>Remove it for all members. {deletionDescription}</p>
                  </div>
                  <Button
                    size="sm"
                    className="project-lifecycle-danger"
                    disabled={disabled || !supportsDelete}
                    onClick={() => open("delete", project)}
                  >
                    <Icon icon={Trash2Icon} />
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
                  className="project-lifecycle-danger"
                  disabled={disabled}
                  onClick={() => open("leave", project)}
                >
                  <Icon icon={LogOutIcon} />
                  Leave project
                </Button>
              </div>
            )}
          </div>
        </section>
      )}
      {catalog &&
        (Object.values(groups).some((projects) => projects.length) ? (
          projectGroups.map(
            ({ id, label, icon }) =>
              groups[id].length > 0 && (
                <section
                  className="settings-danger"
                  aria-label={label}
                  key={id}
                >
                  <div className="settings-danger-heading">
                    <h3>{label}</h3>
                  </div>
                  <ul className="settings-group settings-project-list">
                    {groups[id].map((item) => {
                      const name = projectLabel(item);
                      const deadline =
                        id === "deleted"
                          ? restorableUntil(item.purgeAfter)
                          : null;
                      const owner = item.role === "owner";
                      return (
                        <li className="settings-project-row" key={item.id}>
                          <Icon icon={icon} variant="tertiary" />
                          <div className="settings-project-summary">
                            <strong title={name}>{name}</strong>
                            {id === "archived" && <p>Sync paused</p>}
                            {id === "deleted" && (
                              <p>
                                {deadline
                                  ? `Restorable until ${deadline}`
                                  : "Restore deadline unavailable."}
                              </p>
                            )}
                            {id === "unavailable" && (
                              <p>
                                {item.purged
                                  ? "Permanently deleted"
                                  : "Access removed"}
                              </p>
                            )}
                          </div>
                          <div className="settings-inline-actions">
                            {localCopies.has(item.id) && (
                              <Button
                                size="sm"
                                disabled={disabled}
                                onClick={() => catalog.onViewInactive(item.id)}
                              >
                                Details
                              </Button>
                            )}
                            {id === "active" && (
                              <Button
                                size="sm"
                                disabled={disabled}
                                onClick={() => catalog.onManage(item.id)}
                              >
                                Manage
                              </Button>
                            )}
                            {(id === "disabled" ||
                              (owner &&
                                (id === "archived" || id === "deleted"))) && (
                              <Button
                                size="sm"
                                disabled={disabled}
                                aria-busy={lifecycleProjectId === item.id}
                                onClick={() =>
                                  void lifecycle(
                                    item,
                                    id === "disabled" ? "show" : "restore",
                                  )
                                }
                              >
                                {lifecycleProjectId === item.id ? (
                                  <ActivityIndicator />
                                ) : (
                                  <Icon
                                    icon={
                                      id === "disabled"
                                        ? PlusIcon
                                        : RotateCcwIcon
                                    }
                                  />
                                )}
                                {id === "disabled"
                                  ? "Add to this Mac"
                                  : "Restore"}
                              </Button>
                            )}
                            {id === "deleted" && owner && (
                              <Button
                                size="sm"
                                className="project-lifecycle-danger"
                                disabled={disabled || !supportsDelete}
                                onClick={() => open("purge", item)}
                              >
                                Delete now
                              </Button>
                            )}
                          </div>
                          {lifecycleFeedback(item.id)}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ),
          )
        ) : (
          <p>No projects yet.</p>
        ))}
      {notice && (
        <p className="project-lifecycle-feedback" role="status">
          {notice}
        </p>
      )}
      {dialog && (
        <Modal
          title={title}
          className="settings-confirm project-lifecycle-confirm"
          onCloseAutoFocus={standaloneDelete?.onCloseAutoFocus}
          onClose={() => {
            if (!working) close();
          }}
          size="compact"
          closeButton={false}
          footer={
            <>
              <Button size="sm" disabled={working} onClick={close}>
                {dialog.kind === "leave" ? "Stay" : "Cancel"}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                className="project-lifecycle-danger"
                aria-busy={working}
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
            </>
          }
        >
          <div className="project-lifecycle-target">
            <Icon icon={FolderIcon} variant="tertiary" />
            <span>{dialog.project.name}</span>
          </div>
          {dialog.kind === "leave" ? (
            <p>
              Your account will lose access to its shared content on all your
              devices. The project and its other members stay as they are.
            </p>
          ) : dialog.kind === "delete" ? (
            <>
              <p>
                {count === null
                  ? "All members of this project will lose access."
                  : `The ${count} ${count === 1 ? "member" : "members"} of this project will lose access.`}
              </p>
              <p className="project-lifecycle-policy">{deletionDescription}</p>
              {standaloneDelete && capabilityFeedback}
            </>
          ) : (
            <p>
              This permanently deletes the project and its shared content for
              every member. This can’t be undone.
            </p>
          )}
          {dialog.kind !== "leave" && (
            <TextField
              label="Project name"
              autoFocus
              value={typed}
              disabled={working}
              hint="Enter the project name exactly to confirm."
              onChange={(event) => {
                setTyped(event.target.value);
                setDialogError("");
              }}
            />
          )}
          {dialogError && (
            <p className="project-lifecycle-feedback" role="alert">
              {dialogError}
            </p>
          )}
        </Modal>
      )}
    </>
  );
}
