import { InfoIcon } from "lucide-react";
import React from "react";
import * as Popover from "@radix-ui/react-popover";
import type { IconGlyph } from "./icons.js";

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
