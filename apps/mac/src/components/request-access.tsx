import { XIcon } from "lucide-react";
import React, { useEffect, useState } from "react";
import type { AccessMode, Resource } from "@portable/protocol";
import type { Project, Snapshot } from "../types.js";
import { Button } from "./button.js";
import { IconButton } from "./icon-button.js";
import { PermissionSelect } from "./permission-select.js";
import { Overlay } from "./overlay.js";
import {
  governanceCall,
  permissionSections,
  type GovernanceCatalog,
} from "./project-permissions.js";

export function RequestAccess({
  project,
  kind,
  state,
  onRefresh,
  className,
}: {
  project: Project;
  kind: Resource["kind"];
  state: Snapshot;
  onRefresh: () => Promise<void>;
  className?: string;
}) {
  const { id: projectId, governed, role, policyRevision } = project;
  const usesRolePolicies = Boolean(project.rolePolicies);
  const [permissions, setPermissions] = useState<{
    modes: AccessMode[];
    roleBased: boolean;
  } | null>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"read" | "suggest" | "publish">("read");
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
    return null;
  const needsRead = permissions.modes.some((value) => value === "hidden");
  if (permissions.roleBased)
    return (
      <p className={className}>
        The project Owner manages access for your role.
      </p>
    );
  return (
    <>
      <Button
        className={className}
        size="sm"
        variant="secondary"
        disabled={busy || pending || sent}
        onClick={() => {
          setMode(needsRead ? "read" : "publish");
          setRequestId(crypto.randomUUID());
          setError("");
          setOpen(true);
        }}
      >
        {pending || sent
          ? "Access requested"
          : needsRead
            ? "Request access"
            : "Ask to edit"}
      </Button>
      {open && (
        <Overlay
          open
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
          <label>
            Permission
            <PermissionSelect
              label="Requested permission"
              value={mode}
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
              disabled={busy}
              onClick={() =>
                void (async () => {
                  setBusy(true);
                  setError("");
                  try {
                    await governanceCall("request-access", {
                      projectId: project.id,
                      id: requestId,
                      class: kind,
                      mode,
                    });
                    setSubmittedId(requestId);
                    setOpen(false);
                    await onRefresh();
                  } catch (e) {
                    setError(String(e));
                  } finally {
                    setBusy(false);
                  }
                })()
              }
            >
              {busy ? "Sending…" : "Send request"}
            </Button>
            <Button
              variant="tertiary"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
          </div>
        </Overlay>
      )}
    </>
  );
}
