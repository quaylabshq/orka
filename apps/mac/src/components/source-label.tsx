import { TerminalIcon, UsersIcon } from "lucide-react";
import React from "react";
import type { ResourceSource } from "../types.js";

export const sourceName = (source: ResourceSource) =>
  ({ codex: "Codex", claude: "Claude", pi: "Pi", shared: "Shared" })[source];

export function SourceLabel({ source }: { source: ResourceSource }) {
  return (
    <span className="source-label">
      {source === "shared" ? (
        <UsersIcon size={14} aria-hidden="true" />
      ) : source === "pi" ? (
        <TerminalIcon size={16} aria-hidden="true" />
      ) : (
        <img
          src={`${import.meta.env.BASE_URL}source-icons/${source}.svg`}
          width={16}
          height={16}
          alt=""
          aria-hidden="true"
          draggable={false}
        />
      )}
      <span>{sourceName(source)}</span>
    </span>
  );
}
