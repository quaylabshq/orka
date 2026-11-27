import { productAction } from "./desktop-usage.js";
import {
  CopyIcon,
  FileIcon,
  GlobeIcon,
  MessagesSquareIcon,
  ScrollTextIcon,
  XIcon,
} from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { invoke } from "./product-command.js";
import type { ProjectResource } from "../types.js";
import { Button } from "./button.js";
import { Icon } from "./icon.js";
import { IconButton } from "./icon-button.js";
import { Modal } from "./modal.js";
import { TextField } from "./text-field.js";

type LinkStatus = { active: boolean; linkVersion: string | null; url?: string };

const artifact = {
  skill: {
    icon: FileIcon,
    label: "Skill",
    contents: "the skill title and SKILL.md",
  },
  plan: {
    icon: ScrollTextIcon,
    label: "Plan",
    contents: "the plan title and its text",
  },
  session: {
    icon: MessagesSquareIcon,
    label: "Session",
    contents: "the session title and readable conversation",
  },
  memory: { icon: FileIcon, label: "Memory", contents: "the selected item" },
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
  const copyButton = useRef<HTMLButtonElement>(null);
  const item = artifact[resource.kind];
  const url = stale ? undefined : link?.url;
  useEffect(() => {
    if (url) copyButton.current?.focus();
  }, [url]);
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
      const record = productAction();
      await navigator.clipboard.writeText(link.url);
      record("public_link_copied");
      setNotice("Link copied.");
      setError("");
    } catch {
      setError("Couldn’t copy the link. Select it and copy it manually.");
    }
  };
  return (
    <Modal
      legacyFrame
      title="Manage public link"
      className="artifact-link-dialog"
      onClose={() => {
        if (!busy) onClose();
      }}
      onCloseAutoFocus={onCloseAutoFocus}
    >
      <div className="artifact-link-heading">
        <h2>Manage public link</h2>
        <IconButton
          icon={XIcon}
          size="sm"
          variant="tertiary"
          aria-label="Close"
          disabled={busy}
          onClick={onClose}
        />
      </div>
      <section className="artifact-link-item" aria-label="Shared snapshot">
        <span className="artifact-link-item-icon">
          <Icon icon={item.icon} size="md" variant="secondary" />
        </span>
        <div className="artifact-link-item-name">
          <p title={resource.title}>{resource.title}</p>
          <span>{item.label}</span>
        </div>
      </section>
      <div className="artifact-link-details">
        {url ? (
          <div className="artifact-link-address">
            <TextField
              label="Public link"
              value={url}
              readOnly
              spellCheck={false}
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button
              ref={copyButton}
              variant="primary"
              disabled={busy}
              onClick={() => void copyLink()}
            >
              <Icon icon={CopyIcon} size="sm" />
              Copy link
            </Button>
          </div>
        ) : (
          <div className="artifact-link-access">
            <strong>
              <Icon icon={GlobeIcon} size="sm" variant="secondary" /> Anyone
              with the link
            </strong>
            <p>They can read {item.contents} without signing in.</p>
            <p>
              {link?.active
                ? "Replacing or revoking the link ends access through it."
                : "Publishing an update ends access through this link."}
            </p>
          </div>
        )}
        {(stale || error) && (
          <p role="alert">
            {stale
              ? "This snapshot changed. Reopen the item to manage its public link."
              : error}
          </p>
        )}
        <p className="artifact-link-status" role="status">
          {stale
            ? ""
            : busy
              ? "Updating public link…"
              : !link && !error
                ? "Checking public link…"
                : notice ||
                  (url && !error ? "Copy this link before closing." : "")}
        </p>
      </div>
      <div className="artifact-link-actions">
        {!stale && link?.active && (
          <Button
            variant={url ? "tertiary" : "secondary"}
            disabled={busy}
            onClick={() => void changeLink("revoke-public-link")}
          >
            Revoke link
          </Button>
        )}
        {url ? (
          <Button disabled={busy} onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            {(stale || !link?.active) && (
              <Button variant="tertiary" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
            )}
            {!stale && link && (
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => void changeLink("create-public-link")}
              >
                {link.active ? "Replace link" : "Create public link"}
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
          </>
        )}
      </div>
    </Modal>
  );
}
