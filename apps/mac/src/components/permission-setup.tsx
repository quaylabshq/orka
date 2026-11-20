import React from "react";
import { ENV_ENABLED } from "../lib/features.js";
import { Button } from "./button.js";
import type { GovernanceCatalog } from "./project-permissions.js";

/** The owner's switch for access and change requests on a project without them. */
export function PermissionSetup({
  heading: Heading = "h3",
  catalog,
  queuedChanges,
  busy,
  onEnable,
}: {
  /** The level that follows the page's own headings. */
  heading?: "h2" | "h3";
  catalog: GovernanceCatalog;
  queuedChanges: number;
  busy: boolean;
  onEnable: () => void;
}) {
  return (
    <section
      className="permission-card"
      aria-label="Enable project permissions"
    >
      <Heading>Set up permissions for this project</Heading>
      <p>
        Enable access and change requests. Shared memory and skill changes will
        need approval unless you allow editing. Existing shared content and
        personal memory stay as they are.
      </p>
      <details className="permission-activation-details">
        <summary>What happens to existing work?</summary>
        <p>
          {catalog.resourceCount} shared items and {queuedChanges} queued
          changes on this Mac keep their content. Queued changes are checked
          against permissions on reconnect. Personal memory stays local and
          writable. Existing Macs need an updated app.
        </p>
        <p>
          Authorized skills install automatically when Skills sharing is enabled
          on this Mac. Local edits are preserved. Project instructions need
          local review before installation.
          {ENV_ENABLED &&
            " ENV sets keep their encrypted recipient and trusted device requirements."}
        </p>
      </details>
      {catalog.owner ? (
        <Button variant="primary" disabled={busy} onClick={onEnable}>
          Enable project permissions
        </Button>
      ) : (
        <p>A project owner can enable these controls.</p>
      )}
    </section>
  );
}
