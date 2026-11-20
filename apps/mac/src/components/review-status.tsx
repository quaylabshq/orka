import {
  CheckIcon,
  CircleXIcon,
  CloudOffIcon,
  DownloadIcon,
  HourglassIcon,
  PencilIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  UserIcon,
  XIcon,
} from "lucide-react";
import React from "react";
import { Icon } from "./icon.js";
import type { IconGlyph } from "./icons.js";
import { useMemberPhoto } from "./member-names.js";
import type { GovernanceCatalog } from "./project-permissions.js";
import { displayText } from "./resource-presentation.js";
import type { ReviewRowStatus, ReviewStatusId } from "./review-presentation.js";

const statusIcons: Record<ReviewStatusId, IconGlyph> = {
  approved: CheckIcon,
  awaiting: HourglassIcon,
  blocked: TriangleAlertIcon,
  edits: PencilIcon,
  rejected: XIcon,
  removal: CircleXIcon,
  stale: RefreshCwIcon,
  unsent: CloudOffIcon,
  update: DownloadIcon,
};

/** The one status a review shows, with its icon and tone. */
export function StatusPill({ status }: { status: ReviewRowStatus }) {
  return (
    <span className={`review-pill review-pill--${status.tone}`}>
      <Icon icon={statusIcons[status.id]} size="sm" />
      {status.label}
    </span>
  );
}

/** A member's full name, "You", or "Former member" once they have left. */
export function personName(
  id: string,
  user: string | null,
  members: GovernanceCatalog["members"],
) {
  if (id === user) return "You";
  const name = members.find((item) => item.id === id)?.name?.trim();
  return name ? displayText(name) : "Former member";
}

export function Person({
  id,
  user,
  members,
}: {
  id: string;
  user: string | null;
  members: GovernanceCatalog["members"];
}) {
  const photo = useMemberPhoto(id);
  const name = personName(id, user, members);
  const known = name !== "Former member";
  const label = id === user || !known ? name : name.split(/\s+/)[0];
  return (
    <span className="review-person" title={label === name ? undefined : name}>
      <span className="review-person-avatar" aria-hidden="true">
        {photo ? (
          <img
            key={photo}
            src={photo}
            alt=""
            width={20}
            height={20}
            onError={(event) => {
              event.currentTarget.hidden = true;
            }}
          />
        ) : known ? (
          label.charAt(0).toUpperCase()
        ) : (
          <UserIcon size={12} />
        )}
      </span>
      <span>{label}</span>
    </span>
  );
}
