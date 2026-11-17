import React from "react";
import type { ProjectResource as Resource } from "../types.js";
import type { DetailFact } from "./detail-layout.js";
import { factDate, metaDate } from "./detail-document.js";
import { SourceLabel } from "./source-label.js";

const isShared = (resource: Resource) =>
  !resource.local && resource.revision > 0;

/** The title card chip for anything that isn't fully shared. */
export function sharingStatus(resource: Resource) {
  if (!resource.local && !resource.localChanges) return null;
  return (
    <span
      className={`detail-status detail-status--${resource.local ? "neutral" : "warning"}`}
    >
      {resource.local ? "On this Mac" : "Local changes"}
    </span>
  );
}

/** Info card facts shared by memories, plans, and sessions. */
export function detailFacts(resource: Resource, author: string): DetailFact[] {
  return [
    { label: "Updated by", value: author },
    {
      label: "Updated at",
      value: (
        <time dateTime={resource.updatedAt}>
          {factDate(resource.updatedAt)}
        </time>
      ),
    },
    { label: "Source", value: <SourceLabel source={resource.source} /> },
    ...(resource.repositoryName
      ? [{ label: "Repository", value: resource.repositoryName }]
      : []),
    ...(isShared(resource)
      ? [{ label: "Version", value: resource.revision }]
      : []),
  ];
}

/** The same facts on one line, for the compact reader. */
export function detailMeta(resource: Resource, author: string) {
  return (
    <>
      Updated by {author} · {metaDate(resource.updatedAt)} ·{" "}
      <SourceLabel source={resource.source} />
      {isShared(resource) && ` · Version ${resource.revision}`}
    </>
  );
}
