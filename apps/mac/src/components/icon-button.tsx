import { type IconGlyph } from "./icons.js";
import React, { forwardRef } from "react";
import { Button, type ButtonProps } from "./button.js";
import { Icon } from "./icon.js";

export interface IconButtonProps extends Omit<ButtonProps, "children"> {
  icon: IconGlyph;
  "aria-label": string;
}

/** A square control with the same height, states, and variants as Button. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton({ icon, size = "md", className = "", ...props }, ref) {
    return (
      <Button
        {...props}
        ref={ref}
        size={size}
        className={`ui-icon-button ${className}`.trim()}
      >
        <Icon icon={icon} size={size} />
      </Button>
    );
  },
);
