import React from "react";
import type { ProjectResource } from "../types.js";
import { isInstructionFile } from "./list-status.js";
import { useLocalLocation } from "./resource-menu.js";
import { isFork } from "./index-pages.js";
import { UpdatedTime } from "./updated-time.js";

/** A session's place among its forks, read from the whole collection. */
interface SessionFamily {
  /** The display title of the session this one forked from. */
  parent?: string;
  forks: number;
}

/** A plan extracted from a session transcript. */
const inSession = (plan: ProjectResource) =>
  /^[^/]+\/sessions\//.test(plan.logicalPath);

const homeFolder = /^\/Users\/[^/]+(?=\/|$)/;

function Updated({ value }: { value: string }) {
  return (
    <span className="index-table-peek-updated">
      Updated <UpdatedTime value={value} now={new Date()} />
    </span>
  );
}

/** What a memory, session, or plan is, then where it lives on this Mac. */
export function ListPeek({
  resource,
  family,
  showLogicalPath,
}: {
  resource: ProjectResource;
  family?: SessionFamily;
  showLogicalPath?: boolean;
}) {
  const session = resource.kind === "session";
  const fromSession = resource.kind === "plan" && inSession(resource);
  // A session points at its repository folder; files would be transcripts.
  const location = useLocalLocation(resource, !session);
  const path =
    (session ? location.folder : location.files?.[0]) ??
    (showLogicalPath ? resource.logicalPath : undefined);
  const forks = family?.forks ?? 0;
  const kind =
    resource.kind === "memory" ? (
      <span className="index-table-peek-kind">
        {isInstructionFile(resource) ? "Instruction file" : "Memory"}
        {resource.revision > 0 && ` · Version ${resource.revision}`}
        <span className="index-table-peek-updated">
          {" · "}
          Updated <UpdatedTime value={resource.updatedAt} now={new Date()} />
        </span>
      </span>
    ) : resource.kind === "plan" ? (
      <span className="index-table-peek-kind">
        {fromSession ? "From a session" : "Plan file"}
      </span>
    ) : (
      <>
        {isFork(resource) && (
          <span className="index-table-peek-kind">
            {family?.parent ? `Fork of ${family.parent}` : "Fork"}
          </span>
        )}
        {forks > 0 && (
          <span className="index-table-peek-kind">
            {forks} {forks === 1 ? "fork" : "forks"}
          </span>
        )}
      </>
    );
  return (
    <>
      {kind}
      {path && (
        <span className="index-table-peek-path" title={path}>
          {path.replace(homeFolder, "~")}
        </span>
      )}
      {resource.kind !== "memory" && <Updated value={resource.updatedAt} />}
    </>
  );
}
