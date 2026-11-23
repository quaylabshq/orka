import { PanelLeftIcon } from "lucide-react";
import React from "react";
import { Button } from "./button.js";

export interface WorkspaceHeaderProps {
  title: string;
  collapsed: boolean;
  onToggle: (instant: boolean) => void;
  status?: React.ReactNode;
  repositoryFilter?: React.ReactNode;
  /** Position controls beside the status, such as a review stepper. */
  navigation?: React.ReactNode;
  /** A control shown in place of the visible title, such as Back to Skills. */
  leading?: React.ReactNode;
}

/** Compact Figma shell header; the existing sync menu owns its diagnostics. */
export function WorkspaceHeader({
  title,
  collapsed,
  onToggle,
  status,
  repositoryFilter,
  navigation,
  leading,
}: WorkspaceHeaderProps) {
  return (
    <header
      className={`workspace-header${leading ? " workspace-header--detail" : ""}`}
      data-collapsed={collapsed}
      data-tauri-drag-region
    >
      <div className="workspace-heading" data-tauri-drag-region>
        <Button
          className="ui-icon-button sidebar-toggle"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          onClick={(event) => onToggle(event.detail === 0)}
          variant="tertiary"
          size="sm"
        >
          <PanelLeftIcon size={16} aria-hidden="true" />
        </Button>
        {leading}
        <h1 data-tauri-drag-region className={leading ? "sr-only" : undefined}>
          {title}
        </h1>
      </div>
      <div className="workspace-header-actions" data-tauri-drag-region>
        {repositoryFilter}
        {navigation}
        {status}
      </div>
    </header>
  );
}
