import React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { XIcon } from "lucide-react";
import { motion } from "motion/react";
import { IconButton } from "./icon-button.js";
import { useUiMotion } from "./use-ui-motion.js";
import { ToastViewport, useToastEscape } from "./toasts.js";
import "./modal.css";

/** 340, 390 (the Share dialog) or 640px wide. */
export type ModalSize = "compact" | "default" | "wide";

interface DialogEvents {
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  onCloseAutoFocus?: (event: Event) => void;
  onKeyDownCapture?: React.KeyboardEventHandler<HTMLDivElement>;
  dismissOnBackdrop?: boolean;
}

export interface ModalProps extends DialogEvents {
  /** The visible heading and the dialog's accessible name. */
  title: string;
  /** Visible heading text when it is longer than the accessible name. */
  heading?: string;
  onClose: () => void;
  size?: ModalSize;
  /** Actions, aligned to the end of the footer. */
  footer?: React.ReactNode;
  /** Why the last step failed, shown at the start of the footer. */
  error?: string;
  /** False for a confirmation whose footer already has Cancel. */
  closeButton?: boolean;
  closeLabel?: string;
  closeDisabled?: boolean;
  /** Body styling only; the frame belongs to Modal. */
  className?: string;
  children?: React.ReactNode;
  /**
   * Keeps a dialog that still draws its own heading in the previous frame.
   * Each migration removes it from its callers; the last one removes the prop.
   */
  legacyFrame?: boolean;
}

/**
 * Every centered dialog in Orka: the Share dialog's title row, close button,
 * scrolling body and footer, with Escape, backdrop and focus return in one
 * place.
 */
export function Modal({
  title,
  heading,
  onClose,
  size = "default",
  footer,
  error,
  closeButton = true,
  closeLabel = "Close",
  closeDisabled,
  className = "",
  children,
  legacyFrame = false,
  ...events
}: ModalProps) {
  if (legacyFrame)
    return (
      <DialogFrame
        {...events}
        onClose={onClose}
        className={`modal toast-host-modal ${className}`.trim()}
      >
        <Dialog.Title className="sr-only">{title}</Dialog.Title>
        {children}
      </DialogFrame>
    );
  return (
    <DialogFrame
      {...events}
      onClose={onClose}
      className={`modal toast-host-modal ui-modal ui-modal--${size} ${className}`.trim()}
    >
      <header className="ui-modal-header">
        <Dialog.Title
          aria-label={heading ? title : undefined}
          title={heading ?? title}
        >
          {heading ?? title}
        </Dialog.Title>
        {closeButton && (
          <IconButton
            icon={XIcon}
            size="sm"
            variant="tertiary"
            aria-label={closeLabel}
            title="Close"
            disabled={closeDisabled}
            onClick={onClose}
          />
        )}
      </header>
      <div className="ui-modal-body">{children}</div>
      {(footer || error) && (
        <footer className="ui-modal-footer">
          {error && (
            <p className="ui-modal-error" role="alert" title={error}>
              {error}
            </p>
          )}
          {footer}
        </footer>
      )}
    </DialogFrame>
  );
}

/** The right-side panel. Same dismissal and focus rules, no title row. */
export function Drawer({
  title,
  onClose,
  className = "",
  children,
  ...events
}: DialogEvents & {
  title: string;
  onClose: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <DialogFrame
      {...events}
      onClose={onClose}
      className={`drawer ${className}`.trim()}
    >
      <Dialog.Title className="sr-only">{title}</Dialog.Title>
      {children}
    </DialogFrame>
  );
}

function DialogFrame({
  onClose,
  className,
  children,
  onEscapeKeyDown,
  onCloseAutoFocus,
  onKeyDownCapture,
  dismissOnBackdrop = false,
}: DialogEvents & {
  onClose: () => void;
  className: string;
  children: React.ReactNode;
}) {
  const { transition, reduced } = useUiMotion();
  const dismissToastOnEscape = useToastEscape();
  const [returnFocusTo] = React.useState(() =>
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  return (
    <Dialog.Root open onOpenChange={(value) => !value && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay
          asChild
          onPointerDown={
            dismissOnBackdrop
              ? (event) => {
                  if (
                    event.button === 0 &&
                    !event.defaultPrevented &&
                    event.target === event.currentTarget
                  )
                    onClose();
                }
              : undefined
          }
        >
          <motion.div
            className="overlay-backdrop"
            initial={reduced ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={transition}
          />
        </Dialog.Overlay>
        <Dialog.Content
          asChild
          className={className}
          aria-describedby={undefined}
          onKeyDownCapture={onKeyDownCapture}
          onEscapeKeyDown={(event) => {
            if (!dismissToastOnEscape(event)) onEscapeKeyDown?.(event);
          }}
          onCloseAutoFocus={(event) => {
            onCloseAutoFocus?.(event);
            if (event.defaultPrevented) return;
            event.preventDefault();
            returnFocusTo?.focus();
          }}
        >
          <motion.div
            initial={reduced ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={transition}
          >
            {children}
            <ToastViewport modal />
          </motion.div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
