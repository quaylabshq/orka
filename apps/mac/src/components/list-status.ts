import {
  BanIcon,
  ClockIcon,
  CloudAlertIcon,
  EyeIcon,
  FileWarningIcon,
  PencilIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { ProjectResource, Snapshot } from "../types.js";
import { isReadFailure, type IndexStatus } from "./skill-status.js";
import type { AttentionItem } from "./sync-attention.js";
import { isTerminalUploadError } from "./sync-issues.js";

/** The collections listed like Skills: memories, sessions, and plans. */
export type ListKind = Exclude<ProjectResource["kind"], "skill">;

export type ListStatusKey =
  | "conflict"
  | "upload-failed"
  | "could-not-read"
  | "upload-refused"
  | "needs-review"
  | "waiting-to-sync"
  | "local-edits";

export type ListStatus = IndexStatus<ListStatusKey>;

export interface ListStatusInput {
  resource: ProjectResource;
  conflicted: boolean;
  /** This item's entry in the project's attention list, when it has one. */
  attention?: AttentionItem;
  /** Every queued upload for this item, including ones with no error yet. */
  uploads: Snapshot["outbox"];
  governed: boolean;
}

type Upload = ListStatusInput["uploads"][number];

export const isInstructionFile = (resource: ProjectResource) =>
  resource.kind === "memory" &&
  resource.logicalPath.startsWith("instructions/");

/** Native offers a review only for a plan upload the service turned back. */
const reviewable = (resource: ProjectResource, upload: Upload) =>
  resource.kind === "plan" && upload.reviewable === true;

const installation = ({ attention }: ListStatusInput) =>
  attention?.binding?.installationState ?? "";

/** Each status beside the data that produces it. The first that holds wins. */
const rules: {
  status: ListStatus;
  holds: (input: ListStatusInput) => boolean;
}[] = [
  {
    status: {
      key: "conflict",
      label: "Conflict",
      tone: "red",
      icon: TriangleAlertIcon,
    },
    holds: ({ conflicted }) => conflicted,
  },
  {
    status: {
      key: "upload-failed",
      label: "Upload failed",
      tone: "red",
      icon: CloudAlertIcon,
    },
    holds: ({ uploads }) =>
      uploads.some(
        ({ error }) => Boolean(error) && !isTerminalUploadError(error),
      ),
  },
  {
    status: {
      key: "could-not-read",
      label: "Couldn’t read",
      tone: "red",
      icon: FileWarningIcon,
    },
    // Memories show read failures for instruction files only.
    holds: ({ resource, attention }) =>
      (resource.kind !== "memory" || isInstructionFile(resource)) &&
      Boolean(
        attention?.errors.some(
          ({ source, error }) =>
            source.includes(":scan:") && isReadFailure(error),
        ),
      ),
  },
  {
    status: {
      key: "upload-refused",
      label: "Upload refused",
      tone: "amber",
      icon: BanIcon,
    },
    holds: ({ resource, uploads }) =>
      uploads.some(
        (upload) =>
          isTerminalUploadError(upload.error) && !reviewable(resource, upload),
      ),
  },
  {
    status: {
      key: "needs-review",
      label: "Needs review",
      tone: "amber",
      icon: EyeIcon,
    },
    holds: (input) =>
      input.uploads.some((upload) => reviewable(input.resource, upload)) ||
      (input.governed &&
        isInstructionFile(input.resource) &&
        ["review_pending", "update_available"].includes(installation(input))),
  },
  {
    status: {
      key: "waiting-to-sync",
      label: "Waiting to sync",
      tone: "neutral",
      icon: ClockIcon,
    },
    holds: ({ uploads }) => uploads.some(({ error }) => !error),
  },
  {
    status: {
      key: "local-edits",
      label: "Local edits",
      tone: "neutral",
      icon: PencilIcon,
    },
    holds: (input) =>
      Boolean(input.resource.localChanges) ||
      (isInstructionFile(input.resource) &&
        installation(input) === "locally_modified"),
  },
];

const all = rules.map(({ status }) => status);

/** The statuses each list can show, in the order the Filter menu lists them. */
export const listStatuses: Record<ListKind, ListStatus[]> = {
  memory: all,
  plan: all,
  // Only plan uploads and instruction files can be reviewed.
  session: all.filter(({ key }) => key !== "needs-review"),
};

/** The one status a memory, session, or plan row shows: failures first. */
export function listStatus(input: ListStatusInput): ListStatus | null {
  return rules.find(({ holds }) => holds(input))?.status ?? null;
}
