import React from "react";
import type { SessionConflict } from "@portable/protocol";
import type {
  Project,
  ProjectResource as Resource,
  Snapshot,
} from "../types.js";
import { displayText } from "./resource-presentation.js";
import { SessionDetail } from "./session-detail.js";
import { SkillDetail } from "./skill-detail.js";
import { MemoryDetail } from "./memory-detail.js";
import { useSkillMetadata } from "./skill-metadata.js";
import type { SkillSummary } from "./use-skill-summaries.js";
import { useResourceActions, type Run } from "./use-resource-actions.js";
import type { ResourceView } from "./use-resource-view.js";

export interface ResourceDetailProps {
  scope: string;
  resource: Resource;
  /** The cleaned index title; SKILL.md frontmatter overrides it for skills. */
  displayTitle: string;
  /** Metadata already read for this exact revision in the Skills collection. */
  skillSummary?: SkillSummary | null;
  project: Project;
  user: string | null;
  deviceId: string;
  busy: boolean;
  accessRequest?: React.ReactNode;
  /** The project's unresolved conflicts; the panel shows this resource's. */
  conflicts: SessionConflict[];
  view: ResourceView;
  act: Run;
  /** The workspace snapshot; skills read bindings, drafts, and access from it. */
  state: Snapshot;
  offline?: boolean;
  onRefresh: () => Promise<void>;
  onNotice: (message: string) => void;
  onGovernance?: () => void;
  onError: (message: string) => void;
}

/** Routes each resource kind to its reader. */
export function ResourceDetail(props: ResourceDetailProps) {
  const {
    resource,
    view,
    act,
    onNotice,
    displayTitle,
    state,
    offline = false,
    onRefresh,
  } = props;
  const inspectedSkill = useSkillMetadata(resource, props.scope);
  const skill =
    inspectedSkill ??
    (props.skillSummary
      ? {
          ...props.skillSummary,
          body: "",
          invalid: false,
          key: `${props.scope}:${resource.resourceId}:${resource.revision}`,
        }
      : null);
  const title = displayText(skill?.name || displayTitle);
  const actions = useResourceActions({
    act,
    resource,
    user: props.user,
    onNotice,
    scope: JSON.stringify([
      props.scope,
      props.project.id,
      props.project.path,
      props.project.sources,
    ]),
  });
  if (resource.kind === "skill")
    return (
      <SkillDetail
        resource={resource}
        title={title}
        skill={skill}
        project={props.project}
        user={props.user}
        busy={props.busy}
        accessRequest={props.accessRequest}
        view={view}
        actions={actions}
        state={state}
        offline={offline}
        onRefresh={onRefresh}
        onNotice={onNotice}
        onError={props.onError}
        onGovernance={props.onGovernance}
      />
    );
  if (resource.kind === "session")
    return (
      <SessionDetail
        key={resource.resourceId}
        scope={props.scope}
        resource={resource}
        title={title}
        project={props.project}
        user={props.user}
        deviceId={props.deviceId}
        busy={props.busy}
        accessRequest={props.accessRequest}
        conflicts={props.conflicts}
        view={view}
        actions={actions}
        offline={offline}
        onError={props.onError}
      />
    );
  return (
    <MemoryDetail
      resource={resource}
      title={title}
      project={props.project}
      user={props.user}
      deviceId={props.deviceId}
      busy={props.busy}
      accessRequest={props.accessRequest}
      conflicts={props.conflicts}
      view={view}
      actions={actions}
      offline={offline}
      onError={props.onError}
    />
  );
}
