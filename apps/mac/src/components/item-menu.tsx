import { ChevronRightIcon, EllipsisIcon } from "lucide-react";
import React, { useRef, useState } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { IconButton } from "./icon-button.js";
import type { IconGlyph } from "./icons.js";
import { hasNativeTextMenu } from "../hooks/use-web-view-menu-policy.js";
import "./item-menu.css";

/** The most top-level entries one item menu should show. */
export const ITEM_MENU_CAP = 8;

export interface ItemMenuAction {
  id: string;
  label: string;
  icon?: IconGlyph;
  /** Actions in one group sit together; a separator divides two groups. */
  group?: string;
  onSelect: () => void;
  disabled?: boolean;
  reason?: string;
  danger?: boolean;
  separator?: boolean;
  children?: ItemMenuAction[];
  restoreFocus?: boolean;
}

/** Whether a separator goes above each action. */
function separators(actions: ItemMenuAction[]) {
  let group: string | undefined;
  return actions.map((action, index) => {
    const changed =
      action.group !== undefined &&
      group !== undefined &&
      action.group !== group;
    group = action.group ?? group;
    return index > 0 && (Boolean(action.separator) || changed);
  });
}

function ActionLabel({
  action,
  iconSlot,
}: {
  action: ItemMenuAction;
  iconSlot: boolean;
}) {
  return (
    <>
      {action.icon ? (
        <action.icon className="item-menu-icon" size={16} aria-hidden />
      ) : (
        // Keeps labels aligned when only some actions have an icon.
        iconSlot && <span className="item-menu-icon" aria-hidden />
      )}
      <span className="item-menu-label">{action.label}</span>
    </>
  );
}

function MenuItems({
  actions,
  contextual,
  onSelect,
}: {
  actions: ItemMenuAction[];
  contextual: boolean;
  onSelect: (action: ItemMenuAction) => void;
}) {
  const Menu = contextual ? ContextMenu : DropdownMenu;
  const separated = separators(actions);
  const iconSlot = actions.some((action) => action.icon);
  return actions.map((action, index) => (
    <React.Fragment key={action.id}>
      {separated[index] && <Menu.Separator className="item-menu-separator" />}
      {action.children?.length ? (
        <Menu.Sub>
          <Menu.SubTrigger
            className="item-menu-action"
            disabled={action.disabled}
            title={action.reason}
          >
            <ActionLabel action={action} iconSlot={iconSlot} />
            <ChevronRightIcon size={14} aria-hidden="true" />
          </Menu.SubTrigger>
          <Menu.Portal>
            <Menu.SubContent
              className="item-menu-content"
              collisionPadding={10}
              sideOffset={4}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <MenuItems
                actions={action.children}
                contextual={contextual}
                onSelect={onSelect}
              />
            </Menu.SubContent>
          </Menu.Portal>
        </Menu.Sub>
      ) : (
        <Menu.Item
          className="item-menu-action"
          data-danger={action.danger || undefined}
          disabled={action.disabled}
          title={action.reason}
          onSelect={() => {
            onSelect(action);
            action.onSelect();
          }}
        >
          <ActionLabel action={action} iconSlot={iconSlot} />
        </Menu.Item>
      )}
    </React.Fragment>
  ));
}

/**
 * Native macOS menus swallow the click that dismisses them. Radix's modal mode
 * would too, but it also hides the rest of the window from assistive
 * technology, so the menus stay non-modal and drop that one click instead.
 */
function swallowDismissingClick() {
  let timer = 0;
  const stop = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    disarm();
  };
  // WebKit sends a press's click in the same task as its pointerup, so a timer
  // started there runs after that click. A right-click has no click, and the
  // timer still clears the guard before anything else can be activated.
  const settle = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(disarm);
  };
  const listeners = {
    click: stop,
    pointerup: settle,
    pointercancel: settle,
    // A press whose pointerup never arrives, for example one released
    // outside the window, ends at the next press or key.
    pointerdown: disarm,
    keydown: disarm,
  };
  function disarm() {
    window.clearTimeout(timer);
    for (const [type, listener] of Object.entries(listeners))
      document.removeEventListener(type, listener, true);
  }
  for (const [type, listener] of Object.entries(listeners))
    document.addEventListener(type, listener, true);
}

export function ItemContextMenu({
  actions,
  label,
  children,
  disabled = false,
}: {
  actions: ItemMenuAction[];
  label: string;
  children: React.ReactElement;
  disabled?: boolean;
}) {
  const trigger = useRef<HTMLSpanElement>(null);
  const selected = useRef(false);
  const [open, setOpen] = useState(false);
  if (!actions.length) return children;
  return (
    <ContextMenu.Root
      modal={false}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) selected.current = false;
      }}
    >
      <ContextMenu.Trigger
        asChild
        ref={trigger}
        disabled={disabled}
        // Not data-state: a trigger such as the project picker carries its own.
        data-item-menu-open={open ? "" : undefined}
        onClickCapture={(event) => {
          // Control-click is a secondary click on macOS, but WebKit still
          // follows it with a click. Keep that click from opening the item.
          if (event.ctrlKey) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        onContextMenuCapture={(event) => {
          if (hasNativeTextMenu(event.target)) event.stopPropagation();
        }}
        onKeyDown={(event) => {
          if (
            !disabled &&
            !hasNativeTextMenu(event.target) &&
            (event.key === "ContextMenu" ||
              (event.shiftKey && event.key === "F10"))
          ) {
            event.preventDefault();
            event.stopPropagation();
            const bounds = event.currentTarget.getBoundingClientRect();
            event.currentTarget.dispatchEvent(
              new MouseEvent("contextmenu", {
                bubbles: true,
                cancelable: true,
                clientX: bounds.left + 8,
                clientY: bounds.bottom,
              }),
            );
          }
        }}
      >
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="item-menu-content"
          aria-label={label}
          collisionPadding={10}
          onPointerDownOutside={swallowDismissingClick}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!selected.current) {
              const element = trigger.current;
              const target = element?.matches("button, [tabindex]")
                ? element
                : element?.querySelector<HTMLElement>(
                    "button[data-resource-id], button, [tabindex]",
                  );
              target?.focus();
            }
          }}
        >
          <MenuItems
            actions={actions}
            contextual
            onSelect={(action) => {
              selected.current = action.restoreFocus === false;
            }}
          />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

export function ItemMenuButton({
  actions,
  label,
  disabled,
  size = "sm",
}: {
  actions: ItemMenuAction[];
  label: string;
  disabled?: boolean;
  size?: "sm" | "md" | "lg";
}) {
  const selected = useRef(false);
  return (
    <DropdownMenu.Root
      modal={false}
      onOpenChange={(open) => {
        if (open) selected.current = false;
      }}
    >
      <DropdownMenu.Trigger asChild>
        <IconButton
          icon={EllipsisIcon}
          variant="tertiary"
          size={size}
          aria-label={label}
          disabled={disabled || !actions.length}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="item-menu-content"
          aria-label={label}
          align="end"
          sideOffset={5}
          collisionPadding={10}
          onPointerDownOutside={swallowDismissingClick}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onCloseAutoFocus={(event) => {
            if (selected.current) event.preventDefault();
          }}
        >
          <MenuItems
            actions={actions}
            contextual={false}
            onSelect={(action) => {
              selected.current = action.restoreFocus === false;
            }}
          />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
