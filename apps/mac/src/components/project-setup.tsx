import {
  ArrowRightIcon,
  FolderIcon,
  LogInIcon,
  PlusIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { TextField } from "./text-field.js";
import { IconButton } from "./icon-button.js";
import { Button } from "./button.js";
import { EmptyState } from "./empty-state.js";
import { Icon } from "./icon.js";
import React, { useLayoutEffect, useRef } from "react";
import { Overlay } from "./overlay.js";
import { ProjectSharingChoices } from "./project-sharing.js";
import { SegmentedControl } from "./segmented-control.js";
import type { ProjectSharing } from "../types.js";
import { SourceFolders, type useSourceFolders } from "./source-folders.js";
import { joinErrorMessage } from "./project-invite.js";
import type { InviteDialog } from "./use-invite-preview.js";

export type ProjectSetupMode = "create" | "join";

export function ProjectSetupDialog({
  mode,
  value,
  busy,
  waiting = false,
  cancelling = false,
  onCancelWait,
  connectingFolders = false,
  folderError = "",
  error,
  onChange,
  onClose,
  onSubmit,
  selection,
  run,
  sharing,
  onSharingChange,
  invite,
  inviteService,
  serviceMismatch = false,
  onSwitchService,
  repositoryEnabled = false,
  sourceMode = "folder",
  onSourceMode,
}: {
  repositoryEnabled?: boolean;
  sourceMode?: "github" | "folder";
  onSourceMode?: (value: "github" | "folder") => void;
  mode: ProjectSetupMode;
  value: string;
  busy: boolean;
  /** The request is held until background sync frees the workspace. */
  waiting?: boolean;
  cancelling?: boolean;
  onCancelWait?: () => void;
  connectingFolders?: boolean;
  folderError?: string;
  error: string;
  onChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
  selection: ReturnType<typeof useSourceFolders>;
  run: (action: () => Promise<unknown>) => void;
  sharing: ProjectSharing;
  onSharingChange: (value: ProjectSharing) => void;
  invite?: InviteDialog;
  inviteService?: string;
  serviceMismatch?: boolean;
  onSwitchService?: () => void;
}) {
  const creating = mode === "create";
  const action = creating ? "Create project" : "Join project";
  const title = connectingFolders
    ? "Connect project folders"
    : creating
      ? action
      : (invite?.title ?? action);
  const problem = error || invite?.error || "";
  const heading = useRef<HTMLHeadingElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const submit = useRef<HTMLButtonElement>(null);
  const attachingFolders = busy && connectingFolders && !folderError;
  const status = cancelling
    ? "Cancelling…"
    : waiting
      ? `Waiting for sync to finish. Orka will ${creating ? "create" : "join"} the project.`
      : attachingFolders
        ? "Connecting folders…"
        : "";
  useLayoutEffect(() => {
    if (waiting && !cancelling) cancel.current?.focus({ preventScroll: true });
    else if (busy) heading.current?.focus({ preventScroll: true });
    else if (folderError) submit.current?.focus({ preventScroll: true });
  }, [busy, cancelling, folderError, waiting]);
  // While waiting, closing the dialog cancels the pending request instead.
  const dismiss = waiting ? onCancelWait : busy ? undefined : onClose;
  return (
    <Overlay
      open
      onClose={() => dismiss?.()}
      title={title}
      className="create-project-modal"
    >
      <form
        className="create-project-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!submit.current?.disabled) onSubmit();
        }}
      >
        <div className="create-project-heading">
          <h2 ref={heading} title={title} tabIndex={-1}>
            {title}
          </h2>
          <IconButton
            icon={XIcon}
            variant="tertiary"
            size="sm"
            aria-label={
              connectingFolders
                ? "Close project folder setup"
                : creating
                  ? "Close create project"
                  : "Close join project"
            }
            disabled={!dismiss || cancelling}
            onClick={dismiss}
          />
        </div>
        <div
          className="create-project-fields"
          aria-busy={busy}
          tabIndex={busy ? 0 : undefined}
        >
          {creating ? (
            <>
              <TextField
                label="Project name"
                icon={FolderIcon}
                autoFocus
                required
                maxLength={128}
                autoComplete="off"
                spellCheck={false}
                value={value}
                disabled={busy || connectingFolders}
                onChange={(event) => onChange(event.target.value)}
              />
              {repositoryEnabled && !connectingFolders && (
                <div className="repository-source-choice">
                  <span className="repository-source-choice-label">
                    Repository
                  </span>
                  <SegmentedControl
                    label="Repository source"
                    value={sourceMode}
                    options={[
                      { value: "github", label: "GitHub repository" },
                      { value: "folder", label: "Local folder" },
                    ]}
                    disabled={busy}
                    onChange={(value) => onSourceMode?.(value)}
                  />
                </div>
              )}
              {sourceMode === "github" && !connectingFolders ? (
                <p className="create-project-source-hint">
                  Choose an account and repository next.
                </p>
              ) : (
                <SourceFolders selection={selection} busy={busy} run={run} />
              )}
            </>
          ) : (
            <>
              <TextField
                label="Invite link or token"
                icon={LogInIcon}
                autoFocus
                required
                maxLength={2048}
                placeholder="https://…/join/…"
                autoComplete="off"
                spellCheck={false}
                value={value}
                disabled={busy}
                onChange={(event) => onChange(event.target.value)}
              />
              {invite?.expires && (
                <p className="create-project-source-hint">{invite.expires}</p>
              )}
            </>
          )}
          {!creating && inviteService && (
            <div className="project-invite-service" role="status">
              <p>Project service: {inviteService}</p>
              {serviceMismatch && (
                <>
                  <p>
                    Switch to this service and sign in to join. Your current
                    service’s projects stay saved.
                  </p>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={onSwitchService}
                  >
                    Switch service and sign in
                  </Button>
                </>
              )}
            </div>
          )}
          {!connectingFolders && (
            <ProjectSharingChoices
              value={sharing}
              disabled={busy}
              onChange={onSharingChange}
            />
          )}
          {problem && (
            <div className="setup-error" role="alert">
              <TriangleAlertIcon size={16} aria-hidden="true" />
              <span>{creating ? problem : joinErrorMessage(problem)}</span>
            </div>
          )}
        </div>
        {folderError && (
          <div
            className="create-project-connection-error setup-error"
            role="alert"
            tabIndex={0}
          >
            <TriangleAlertIcon size={16} aria-hidden="true" />
            <span>
              Project created. Couldn’t connect the selected folders.{" "}
              {folderError}
            </span>
          </div>
        )}
        <div className="create-project-footer">
          <p
            className="create-project-status"
            role="status"
            aria-label="Project setup progress"
          >
            {status}
          </p>
          <Button
            ref={cancel}
            variant="tertiary"
            onClick={dismiss}
            disabled={!dismiss || cancelling}
          >
            {connectingFolders ? "Open project" : "Cancel"}
          </Button>
          <Button
            ref={submit}
            className="create-project-submit"
            type="submit"
            variant="primary"
            disabled={
              busy ||
              (connectingFolders
                ? selection.folders.length === 0
                : !value.trim() || serviceMismatch || invite?.unavailable)
            }
          >
            {waiting
              ? "Waiting for sync…"
              : connectingFolders
                ? attachingFolders
                  ? "Connecting…"
                  : "Retry connection"
                : busy
                  ? creating
                    ? "Creating…"
                    : "Joining…"
                  : action}
          </Button>
        </div>
      </form>
    </Overlay>
  );
}

export function ProjectEmptyState({
  onCreate,
  onJoin,
}: {
  onCreate: () => void;
  onJoin: () => void;
}) {
  return (
    <section className="project-empty" aria-label="Project setup">
      <EmptyState
        illustration="project"
        size="workspace"
        title="Start with a project"
        description="Create a project to organize your work, or join one with an invite."
        actions={
          <>
            <Button onClick={onCreate} variant="primary" size="lg">
              <Icon icon={PlusIcon} />
              Add project
            </Button>
            <Button onClick={onJoin} variant="secondary" size="lg">
              <Icon icon={LogInIcon} />
              Join project
            </Button>
          </>
        }
      />
    </section>
  );
}

export function FolderConnectionPrompt({
  projectName,
  busy,
  onConnect,
  repositories = false,
}: {
  projectName: string;
  busy: boolean;
  onConnect: () => void;
  repositories?: boolean;
}) {
  return (
    <section className="folder-connection" aria-label="Connect this Mac">
      <div className="connection-symbol">
        <FolderIcon size={18} aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <h2>Connect this Mac</h2>
        <p>
          {repositories ? (
            <>
              Clone or locate the repositories for{" "}
              <strong>{projectName}</strong> to sync files and open native
              sessions.
            </>
          ) : (
            <>
              Choose the local folder for <strong>{projectName}</strong> to sync
              files and open native sessions.
            </>
          )}
        </p>
      </div>
      <Button
        className="shrink-0"
        disabled={busy}
        onClick={onConnect}
        variant="primary"
        size="md"
      >
        {repositories ? "Connect repositories" : "Connect folder"}
        <Icon icon={ArrowRightIcon} />
      </Button>
    </section>
  );
}
