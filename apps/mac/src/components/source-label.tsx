import { UsersIcon } from "lucide-react";
import React from "react";
import type { Resource } from "@portable/protocol";

export function SourceLabel({ source }: { source: Resource["source"] }) {
  const label =
    source === "codex" ? "Codex" : source === "claude" ? "Claude" : "Shared";
  return (
    <span className="source-label">
      {source === "shared" ? (
        <UsersIcon size={14} aria-hidden="true" />
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
      <span>{label}</span>
    </span>
  );
}
