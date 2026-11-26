import { XIcon } from "lucide-react";
import React, { useEffect, useState } from "react";
import type { AccessMode, Resource } from "@portable/protocol";
import type { Project, Snapshot } from "../types.js";
import { Button } from "./button.js";
import { IconButton } from "./icon-button.js";
import { PermissionSelect } from "./permission-select.js";
import { Modal } from "./modal.js";
import {
  governanceCall,
  permissionSections,
  type GovernanceCatalog,
} from "./project-permissions.js";

export interface RequestAccessProps {
  project: Project;
  kind: Resource["kind"];
  state: Snapshot;
  onRefresh: () => Promise<void>;
  className?: string;
  /** Show these controls inside a dialog owned by the caller. */
  renderInDialog?: (
    request: React.ReactNode,
    busy: boolean,
  ) => React.ReactElement;
}

export function RequestAccess({
  project,
  kind,
  state,
  onRefresh,
  className,
  renderInDialog,
}: RequestAccessProps) {
  const { id: projectId, governed, role, policyRevision } = project;
  const usesRolePolicies = Boolean(project.rolePolicies);
  const [permissions, setPermissions] = useState<{
    modes: AccessMode[];
    roleBased: boolean;
  } | null>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"read" | "suggest" | "publish">();
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [submittedId, setSubmittedId] = useState<string | null>(null);
  const submitted = state.reviewRequests?.find(
    (request) => request.id === submittedId,
  );
  const sent = Boolean(
    submittedId && (!submitted || submitted.status === "pending"),
  );
  const category = permissionSections.find((section) => section.id === kind)!;
  const pending = (state.reviewRequests ?? []).some(
    (request) =>
      request.projectId === project.id &&
      request.author === state.user &&
      request.type === "access" &&
      request.status === "pending" &&
      request.requestedClass === kind,
  );
  useEffect(() => {
    if (!governed || role === "owner") return;
    let active = true;
    let retryTimer: number | undefined;
    const load = async () => {
      try {
        const catalog = await governanceCall<GovernanceCatalog>("catalog", {
          projectId,
        });
        if (active)
          setPermissions({
            modes: category.classes.map((key) => catalog.access[key].mode),
            roleBased: Boolean(catalog.rolePolicies),
          });
      } catch {
        if (!active) return;
        if (usesRolePolicies) {
          // A failed check gives us no new information about the role.
          retryTimer = window.setTimeout(() => void load(), 5000);
          return;
        }
        // Legacy projects still offer a request when the first check fails.
        setPermissions(
          (current) => current ?? { modes: ["hidden"], roleBased: false },
        );
      }
    };
    void load();
    return () => {
      active = false;
      window.clearTimeout(retryTimer);
    };
  }, [projectId, governed, role, policyRevision, usesRolePolicies, category]);
  if (
    !governed ||
    role === "owner" ||
    !permissions ||
    permissions.modes.every((value) => value === "publish")
  )
    return renderInDialog?.(null, busy) ?? null;
  const needsRead = permissions.modes.some((value) => value === "hidden");
  if (permissions.roleBased) {
    const notice = (
      <p className={className}>
        The project Owner manages access for your role.
      </p>
    );
    return renderInDialog?.(notice, busy) ?? notice;
  }
  const defaultMode = needsRead ? "read" : "publish";
  const requestedMode = mode ?? defaultMode;
  const alreadyRequested = pending || sent;
  const sendRequest = async () => {
    setBusy(true);
    setError("");
    try {
      await governanceCall("request-access", {
        projectId: project.id,
        id: requestId,
        class: kind,
        mode: requestedMode,
      });
      setSubmittedId(requestId);
      setRequestId(crypto.randomUUID());
      setOpen(false);
      await onRefresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const fields = (
    <>
      <label>
        Permission
        <PermissionSelect
          label="Requested permission"
          value={requestedMode}
          disabled={busy}
          options={[
            { value: "read", label: "View only" },
            { value: "suggest", label: "Suggest changes" },
            { value: "publish", label: "Can edit" },
          ]}
          onChange={(value) => {
            setMode(value);
            setRequestId(crypto.randomUUID());
          }}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <div className="actions">
        <Button
          size={renderInDialog ? "sm" : undefined}
          disabled={busy}
          onClick={() => void sendRequest()}
        >
          {busy ? "Sending…" : "Send request"}
        </Button>
        {!renderInDialog && (
          <Button
            variant="tertiary"
            disabled={busy}
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
        )}
      </div>
    </>
  );
  if (renderInDialog)
    return renderInDialog(
      alreadyRequested ? (
        <p role="status">Access requested</p>
      ) : (
        <div className="index-access-request-fields">{fields}</div>
      ),
      busy,
    );
  return (
    <>
      <Button
        className={className}
        size="sm"
        variant="secondary"
        disabled={busy || alreadyRequested}
        onClick={() => {
          setMode(defaultMode);
          setRequestId(crypto.randomUUID());
          setError("");
          setOpen(true);
        }}
      >
        {alreadyRequested
          ? "Access requested"
          : needsRead
            ? "Request access"
            : "Ask to edit"}
      </Button>
      {open && (
        <Modal
          legacyFrame
          title="Request access"
          onClose={() => {
            if (!busy) setOpen(false);
          }}
          className="access-request-dialog"
        >
          <div className="actions">
            <h2>Request access</h2>
            <span className="spacer" />
            <IconButton
              icon={XIcon}
              aria-label="Close access request"
              variant="tertiary"
              size="sm"
              disabled={busy}
              onClick={() => setOpen(false)}
            />
          </div>
          {fields}
        </Modal>
      )}
    </>
  );
}
