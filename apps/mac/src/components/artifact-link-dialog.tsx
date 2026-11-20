import { FileIcon } from "lucide-react";
import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectResource } from "../types.js";
import { Button } from "./button.js";
import { Icon } from "./icon.js";
import { Overlay } from "./overlay.js";
import { TextField } from "./text-field.js";

type LinkStatus = { active: boolean; linkVersion: string | null; url?: string };

const description = {
  skill: "The page includes the skill title and SKILL.md.",
  plan: "The page includes the plan title and its text.",
  session: "The page includes the session title and readable conversation.",
  memory: "",
};

export function ArtifactLinkDialog({
  resource,
  accountId,
  serviceOrigin,
  linkOrigin,
  stale,
  onClose,
  onCloseAutoFocus,
}: {
  resource: ProjectResource;
  accountId: string | null;
  serviceOrigin?: string;
  linkOrigin: string | null;
  stale: boolean;
  onClose: () => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const { projectId, resourceId, revision } = resource;
  const [link, setLink] = useState<LinkStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (stale) return;
    let current = true;
    void invoke<LinkStatus>("resource_command", {
      action: "public-link-status",
      input: { accountId, serviceOrigin, projectId, resourceId, revision },
    }).then(
      (result) => {
        if (current) setLink(result);
      },
      (failure: unknown) => {
        if (current) setError(String(failure));
      },
    );
    return () => {
      current = false;
    };
  }, [
    accountId,
    serviceOrigin,
    projectId,
    resourceId,
    revision,
    stale,
    attempt,
  ]);

  const changeLink = async (
    action: "create-public-link" | "revoke-public-link",
  ) => {
    if (busy || stale || !link || !linkOrigin) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await invoke<LinkStatus>("resource_command", {
        action,
        input: {
          accountId,
          serviceOrigin,
          projectId,
          resourceId,
          revision,
          linkVersion: link.linkVersion,
        },
      });
      if (action === "create-public-link") {
        const url = new URL(result.url ?? "", linkOrigin);
        if (
          !result.active ||
          url.origin !== linkOrigin ||
          !/^\/share\/[a-f0-9]{64}$/.test(url.pathname) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new Error("Orka returned an invalid public link.");
        setLink({ ...result, url: url.href });
      } else {
        setLink(result);
        setNotice("Public link revoked.");
      }
    } catch (failure) {
      setLink(null);
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const copyLink = async () => {
    if (!link?.url || stale) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setNotice("Link copied.");
      setError("");
    } catch {
      setError("Couldn’t copy the link. Select it and copy it manually.");
    }
  };
  return (
    <Overlay
      open
      title="Manage public link"
      className="resource-command-dialog artifact-link-dialog"
      onClose={() => {
        if (!busy) onClose();
      }}
      onCloseAutoFocus={onCloseAutoFocus}
    >
      <h2>Manage public link</h2>
      <section className="resource-command-item" aria-label="Shared snapshot">
        <Icon icon={FileIcon} size="sm" variant="secondary" />
        <div>
          <span className="resource-command-kind">{resource.kind}</span>
          <p title={resource.title}>{resource.title}</p>
        </div>
      </section>
      <div className="resource-command-workspace">
        <p className="command-copy">
          Anyone with the link can read this shared revision without signing in.{" "}
          {description[resource.kind]} Publishing an update ends access through
          this link.
        </p>
        {stale ? (
          <p role="alert">
            This snapshot changed. Reopen the item to manage its public link.
          </p>
        ) : (
          <>
            {link?.url && (
              <TextField
                label="Public link"
                value={link.url}
                readOnly
                spellCheck={false}
                hint="Copy this link before closing."
              />
            )}
            {link?.active && !link.url && (
              <p className="command-copy">
                A public link is active. Replacing or revoking it ends access
                through the current link.
              </p>
            )}
            {error && <p role="alert">{error}</p>}
            <p role="status">
              {busy
                ? "Updating public link…"
                : !link && !error
                  ? "Checking public link…"
                  : notice}
            </p>
          </>
        )}
      </div>
      <div className="actions">
        <Button disabled={busy} onClick={onClose}>
          Close
        </Button>
        <div className="resource-command-main-actions">
          {!stale && link?.active && (
            <Button
              disabled={busy}
              onClick={() => void changeLink("revoke-public-link")}
            >
              Revoke link
            </Button>
          )}
          {!stale && link && (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() =>
                link.url
                  ? void copyLink()
                  : void changeLink("create-public-link")
              }
            >
              {link.url
                ? "Copy link"
                : link.active
                  ? "Replace link"
                  : "Create public link"}
            </Button>
          )}
          {!stale && !link && error && (
            <Button
              onClick={() => {
                setError("");
                setAttempt((value) => value + 1);
              }}
            >
              Check link status
            </Button>
          )}
        </div>
      </div>
    </Overlay>
  );
}
