import type {
  Resource,
  SessionConflict,
  Activity,
  RepositoryBinding,
} from "@portable/protocol";
import type {
  ReviewRequest,
  EffectiveAccess,
  RolePolicies,
} from "@portable/protocol";
export type ResourceSource = Resource["source"] | "pi";
export type WorkspaceResource =
  | Resource
  | (Omit<Resource, "source" | "kind"> & {
      source: "pi";
      kind: "session";
    });
export type ProjectResource = WorkspaceResource & {
  repositoryName?: string;
  local?: true;
  localChanges?: boolean;
  sharedRevision?: number;
  global?: boolean;
  sharing?: "queued" | "approval" | "paused" | "blocked";
  fork?: {
    parentId: string;
    nativeId: string | null;
    destination: "desktop" | "terminal" | "warp" | "iterm2";
    createdAt: string;
  };
  localForkId?: string;
  nativeForkParentId?: string;
};
export type ProjectPage =
  "home" | "env" | "members" | "reviews" | Resource["kind"];
export type ProjectSharing = Record<Resource["kind"] | "env", boolean>;
export interface ProjectMember {
  id: string;
  role: string;
  name?: string;
  displayName?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  avatarData?: string | null;
}
export interface Project {
  id: string;
  name: string;
  localName?: string | null;
  path?: string | null;
  sources?: {
    id: string;
    name: string;
    removedAt?: string | null;
    path?: string | null;
    folderState?: "connected" | "reconnect" | "locate" | "repository-conflict";
    remoteKey?: string;
    /** Unsent changes that block disconnecting this folder on this Mac. */
    queuedChanges?: number;
    /** False when the connected folder is not inside a Git repository. */
    gitRepository?: boolean;
    /** When a folder newly connected on this Mac starts its first sync. */
    syncStartsAt?: string | null;
    repository?: RepositoryBinding | null;
    repositoryRevision?: number;
  }[];
  folderState?: "connected" | "reconnect" | "locate";
  role: "owner" | "admin" | "member";
  sharing?: ProjectSharing | null;
  governed?: boolean;
  rolePolicies?: RolePolicies | null;
  policyRevision?: number;
  lifecycleRevision?: number;
  archivedAt?: string | null;
  deletedAt?: string | null;
  purgeAfter?: string | null;
  /** Outbox changes eligible for upload after restore. */
  heldChanges?: number;
  /** Pending local changes that removal discards, including failed uploads. */
  pendingChanges?: number;
  /** Pending encrypted publications included in the removal count and excluded from export. */
  pendingEnvPublications?: number;
  purged?: boolean | null;
  revoked?: boolean | null;
  detachedAt?: string | null;
  /** This Mac's workspace attachment was removed. */
  hidden?: boolean | null;
}
export interface Binding {
  resourceId?: string;
  projectId?: string;
  base?: WorkspaceResource;
  nativeId?: string;
  paths?: string[];
  needsCopy?: boolean;
  installationState?: string;
  availableRevision?: number;
  skillReviewFingerprint?: string | null;
}
export type ServiceMode = "cloud" | "self-hosted";
export interface SyncProgress {
  /** Present only for progress produced by this project's active queue claim. */
  projectId?: string;
  label: string;
  detail?: string | null;
  completed?: number;
  total?: number | null;
}
/** One queued project from `sync_queue_state`; the workspace `*` row is not sent. */
export interface SyncQueueEntry {
  projectId: string;
  /** `scheduled`: a newly connected folder waits before its first sync. */
  state: "queued" | "running" | "waiting" | "scheduled";
  reason: string;
  attempts: number;
  notBefore: string | null;
  cancelRequested?: boolean;
}
export interface Snapshot {
  onboarding?: import("./components/onboarding/model.js").OnboardingInfo;
  accountProfile?:
    import("./components/onboarding/model.js").AccountProfile | null;
  localSkills?: ProjectResource[];
  drafts?: LocalDraft[];
  reviewRequests?: ReviewRequest[];
  governance?: {
    projectId: string;
    catalog: {
      access: Record<string, EffectiveAccess>;
      members?: ProjectMember[];
    };
  }[];
  profile?: string;
  user: string | null;
  config: {
    apiUrl: string;
    syncMinutes: number;
    mode?: ServiceMode;
    cloudUrl?: string;
    selfHostedUrl?: string;
  } | null;
  projects: Project[];
  /** Archived, deleted, or unreachable projects that stay visible as read-only. */
  inactive?: Project[];
  deletedProjects?: Project[];
  archivedProjects?: Project[];
  /** Includes projects that have been removed from this Mac. */
  managedProjects?: Project[];
  resources: ProjectResource[];
  bindings: Binding[];
  conflicts: SessionConflict[];
  activity: Activity[];
  outbox: {
    id: string;
    project: string;
    error: string | null;
    resourceId?: string | null;
    title?: string | null;
    kind?: Resource["kind"] | null;
    reviewable?: boolean;
  }[];
  errors: { source: string; error: string }[];
  sync: { online: boolean; lastSync?: string; error?: string } | null;
  syncProgress?: SyncProgress | null;
  daemon: { running: boolean; heartbeat?: string; error?: string } | null;
  devices:
    | {
        id: string;
        name: string;
        seen_at: string;
        hardwareFamily?: string | null;
      }[]
    | null;
  deviceId: string;
  localHardwareFamily?: string | null;
  background: boolean | null;
}
export interface LocalDraft {
  id: string;
  projectId: string;
  resource: WorkspaceResource;
  status: string;
  automaticSharing?: boolean;
  createdAt: string;
  updatedAt?: string;
  request?: ReviewRequest;
  requestId?: string;
  submission?: { id?: string; resource?: Pick<Resource, "resourceId"> };
  dismissalReason?: string;
  archivedAt?: string;
}
export interface SessionSnapshotDownload {
  conflictId?: string | null;
  snapshotHash: string;
}
export type SessionSnapshotSelection =
  | SessionSnapshotDownload
  | {
      conflictId?: string;
      reviewed: Pick<
        WorkspaceResource,
        "projectId" | "resourceId" | "source"
      > & {
        files: Pick<Resource["files"][number], "path" | "hash">[];
      };
    };

export interface SessionTranscriptOpen {
  readerId: string;
  sessionSnapshot: SessionSnapshotDownload | null;
  removed?: boolean;
}

export interface SessionTranscriptRange {
  offset: number;
  text: string;
  nextOffset: number;
  eof: boolean;
}

export type Inspection = {
  conversation?: string | null;
  content: string | null;
  previous: string | null;
  paths: string[] | null;
} & (
  | { tooLarge?: false }
  | {
      /** An oversized transcript sends its size in bytes and a download selector. */
      tooLarge: true;
      content: null;
      size: number;
      sessionSnapshot: SessionSnapshotSelection;
    }
);
export interface SessionMessage {
  index: number;
  role: "user" | "assistant";
  text: string;
}
export interface SessionPage {
  messages: SessionMessage[];
  total: number;
  offset: number;
  removed?: boolean;
}
