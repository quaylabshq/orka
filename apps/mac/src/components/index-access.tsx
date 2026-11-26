import { InfoIcon, XIcon } from "lucide-react";
import React, { useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { IconButton } from "./icon-button.js";
import type { IconGlyph } from "./icons.js";
import { Modal } from "./modal.js";

/** One warning leads to the folder and permission actions for this project. */
export function IndexAccessDialog({
  label,
  busy = false,
  children,
}: {
  label: string;
  busy?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="index-status-pill index-access-pill"
        data-tone="amber"
        data-state={open ? "open" : "closed"}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        {label}
        <InfoIcon size={12} aria-hidden="true" />
      </button>
      {open && (
        <Modal
          legacyFrame
          title="Project access"
          className="index-access-dialog"
          onClose={() => {
            if (!busy) setOpen(false);
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
        >
          <div className="index-access-dialog-header">
            <h2>Project access</h2>
            <IconButton
              icon={XIcon}
              aria-label="Close project access"
              variant="tertiary"
              size="sm"
              disabled={busy}
              onClick={() => setOpen(false)}
            />
          </div>
          {children}
        </Modal>
      )}
    </>
  );
}

/** An amber pill beside the toolbar that explains a limit on the whole page. */
export function AccessPill({
  label,
  title,
  icon: Glyph,
  children,
}: {
  label: string;
  title: string;
  icon: IconGlyph;
  children: React.ReactNode;
}) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="index-status-pill index-access-pill"
          data-tone="amber"
        >
          {label}
          <InfoIcon size={12} aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="index-access-panel"
          aria-label={title}
          align="end"
          sideOffset={8}
          collisionPadding={12}
          // Its action can open a dialog of its own; the panel stays under it.
          onFocusOutside={(event) => {
            if (
              event.target instanceof Element &&
              event.target.closest('[role="dialog"]')
            )
              event.preventDefault();
          }}
        >
          <p className="index-access-title">
            <Glyph size={16} aria-hidden="true" />
            {title}
          </p>
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
